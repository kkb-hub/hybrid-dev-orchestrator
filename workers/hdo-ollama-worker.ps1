#Requires -Version 7.0
<#
.SYNOPSIS
    HDO の local implement/fix step を Ollama の native API で実行する軽量 worker。

.DESCRIPTION
    `type: command` runner として HDO から起動され、既存の command adapter
    contract（{promptFile} / {outputFile} / {schemaFile} / {workingDirectory} /
    {model} / {contextTokens}）だけで完結する。HDO 本体に adapter 分岐を足さない。

    claude+ollama route との違いは context の使い方にある。Claude CLI は汎用の
    対話型 agent であり、宣言した context window から固定の予備枠（出力用 20000 と
    送信拒否ライン 3000）を先に差し引くため、contextTokens に 57344 という実用下限が
    生じる（issue #26 / #28）。この worker は必要な tool 定義と system prompt しか
    積まないため固定コストが桁違いに小さく、24GB VRAM の GPU に完全に載る 32768 でも
    余裕を持って動作する。

    Ollama の native /api/chat は num_ctx を request option として受け付けるので、
    claude route のように num_ctx を焼き込んだ派生モデルを `ollama create` する必要も
    ない。contextTokens はそのまま options.num_ctx になる。

    固定費が小さいことは、会話が伸びないことを意味しない。tool result と tool
    arguments は turn ごとに積み上がるため、実装規模のあるタスクでは数ターンで window
    に到達する（issue #47）。この worker は Ollama 自身が返す prompt_eval_count を
    監視し、provider 側の silent truncation より先に履歴を圧縮する。圧縮後も system
    prompt と元の task はそのまま残り、破棄した turn は「worker が観測した事実」と
    「model が要約した経緯」に分けて再注入される。

    Security boundary は claude+ollama route と同じものを維持する。公開する tool は
    workspace 配下の file 操作だけで、workspace 外への path は拒否する。shell、git、
    build、validation gate は一切実行せず、それらは trusted な HDO 本体が持つ。

.EXAMPLE
    pwsh -NoProfile -File workers/hdo-ollama-worker.ps1 -PromptFile p.txt `
        -OutputFile final.json -SchemaFile worker-result.schema.json `
        -WorkingDirectory C:\repo -Model qwen3.8:27b-q4_K_M -ContextTokens 32768
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PromptFile,
    [Parameter(Mandatory)][string]$OutputFile,
    [Parameter(Mandatory)][string]$SchemaFile,
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string]$Model,
    [ValidateRange(1024, 1048576)][int]$ContextTokens = 32768,
    # Read-only steps get the inspection tools only. The file-editing tools are not
    # merely unused but structurally absent, so a read-only runner cannot be talked
    # into writing by prompt content.
    [switch]$ReadOnly,
    [ValidateRange(1, 200)][int]$MaxTurns = 40,
    # Bounds a single tool result. A local model's context is small enough that one
    # unbounded file read can consume all of it; truncating here keeps that failure
    # visible to the model instead of letting Ollama silently drop the oldest turns.
    [ValidateRange(1000, 200000)][int]$MaxToolResultChars = 20000,
    # Percentage of the context window at which the history is compacted. Kept well below
    # 100 deliberately: compaction has to happen while there is still room to describe what
    # is being dropped, not once the window is already full. 0 disables it and restores the
    # previous grow-until-the-provider-truncates behaviour.
    [ValidateRange(0, 95)][int]$CompactAtPercent = 65,
    # How many trailing messages survive a compaction, so the model keeps the local context
    # needed to continue the exchange it is in rather than restarting from a summary alone.
    [ValidateRange(2, 50)][int]$KeepRecentMessages = 6,
    [ValidateRange(30, 3600)][int]$RequestTimeoutSeconds = 600,
    # Defaults to the local Ollama. Unlike the claude+ollama adapter, this does not need
    # to be pinned against repository configuration: HDO refuses to let a repository
    # config define, modify, or route to a command runner at all, so the endpoint is
    # already only reachable by the operator who chose this executable in the first place.
    [ValidatePattern('^https?://')][string]$OllamaUri = 'http://127.0.0.1:11434/api/chat'
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
    throw "WorkingDirectory '$WorkingDirectory' does not exist."
}
$script:Workspace = (Resolve-Path -LiteralPath $WorkingDirectory).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)

# The first two messages are the system prompt and the operator's task. Compaction never
# touches them, so every rebuilt history still starts from the same instructions and the
# same goal the orchestrator asked for.
$script:ProtectedMessageCount = 2

function Get-OptionalProperty {
    <#
    .SYNOPSIS
        Reads a property that the server may legitimately omit.
    .DESCRIPTION
        Ollama marks several response counters omitempty, so a fully cached prompt comes
        back without prompt_eval_count. Under Set-StrictMode that is a terminating error,
        which would otherwise abort a step whose work is already on disk.
    #>
    param($Object, [Parameter(Mandatory)][string]$Name, $Default = 0)

    if ($null -eq $Object) { return $Default }
    if ($Object.PSObject.Properties.Name -notcontains $Name) { return $Default }
    $value = $Object.$Name
    if ($null -eq $value) { return $Default }
    return $value
}

function Limit-Text {
    param([AllowEmptyString()][AllowNull()][string]$Text, [Parameter(Mandatory)][int]$Max)

    if ([string]::IsNullOrEmpty($Text)) { return '' }
    if ($Text.Length -le $Max) { return $Text }
    return $Text.Substring(0, $Max) + '...[truncated]'
}

function Add-BoundedEntry {
    <#
    .SYNOPSIS
        Appends to a rolling log that is allowed to forget its oldest entries.
    #>
    param(
        # AllowEmptyCollection because the binder otherwise rejects the very first call:
        # a mandatory collection parameter treats an empty list as a missing argument.
        [Parameter(Mandatory)][AllowEmptyCollection()][Collections.Generic.List[string]]$List,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Value,
        [Parameter(Mandatory)][int]$Max
    )

    $List.Add($Value)
    while ($List.Count -gt $Max) { $List.RemoveAt(0) }
}

function Test-PathInsideWorkspace {
    param([Parameter(Mandatory)][string]$FullPath)

    # Compare against the workspace plus a separator so a sibling directory whose name
    # merely starts with the workspace name (C:\repo-old vs C:\repo) is not accepted.
    $prefix = $script:Workspace + [IO.Path]::DirectorySeparatorChar
    return $FullPath -eq $script:Workspace -or $FullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-WorkerPath {
    <#
    .SYNOPSIS
        Resolves a model-supplied path and proves it stays inside the workspace.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'path must not be empty' }
    if ([IO.Path]::IsPathRooted($Path)) { throw "path must be workspace-relative: $Path" }
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($script:Workspace, $Path))
    if (-not (Test-PathInsideWorkspace $full)) { throw "path escapes the workspace: $Path" }

    # Git metadata is off limits even though it sits inside the workspace. HDO runs real
    # git against this worktree, so a writable .git turns a file edit into command
    # execution (a redirected gitdir, a core.fsmonitor hook) and lets a run rewrite the
    # very history the orchestrator uses to derive what changed.
    $relative = if ($full -eq $script:Workspace) { '' } else { $full.Substring($script:Workspace.Length + 1) }
    $firstSegment = @($relative -split '[\\/]' | Where-Object { $_ })
    if ($firstSegment.Count -gt 0 -and $firstSegment[0] -ieq '.git') {
        throw "path is inside git metadata and is not writable or readable by a worker: $Path"
    }

    # GetFullPath is purely lexical, so a junction or symlink planted inside the workspace
    # still satisfies the prefix check above while pointing outside it. Every existing
    # component between the workspace and the target is inspected, not just the target
    # itself: the leaf of 'escape/secret.txt' is an ordinary file, and it is the 'escape'
    # directory that is the link.
    $cursor = $full
    while ($cursor -and $cursor.Length -gt $script:Workspace.Length) {
        if (Test-Path -LiteralPath $cursor) {
            $linkTarget = (Get-Item -LiteralPath $cursor -Force).ResolveLinkTarget($true)
            if ($null -ne $linkTarget -and -not (Test-PathInsideWorkspace ([IO.Path]::GetFullPath($linkTarget.FullName)))) {
                throw "path resolves through a link that leaves the workspace: $Path"
            }
        }
        $cursor = Split-Path -Parent $cursor
    }
    return $full
}

function Limit-ToolResult {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    if ($Text.Length -le $MaxToolResultChars) { return $Text }
    return $Text.Substring(0, $MaxToolResultChars) +
        "`n...[truncated by HDO after $MaxToolResultChars characters; narrow the request instead of re-reading]"
}

# Default cap on how many matching lines a single search returns. A repository-wide regular
# expression can match thousands of lines, and a result that large is never what the model
# actually needed: it is the shape of the question that should change, not the window.
$script:DefaultSearchResults = 100

$script:ReadTools = @(
    @{ type = 'function'; function = [ordered]@{
        name = 'read_file'
        description = 'Read a UTF-8 text file from the workspace. Prefer a narrow window: pass start_line with max_lines instead of reading a whole large file. Long results are truncated; use start_line to read the rest.'
        parameters = [ordered]@{ type = 'object'; additionalProperties = $false
            properties = [ordered]@{
                path = [ordered]@{ type = 'string'; description = 'Workspace-relative file path.' }
                start_line = [ordered]@{ type = 'integer'; description = 'Optional 1-based line to start reading from.' }
                max_lines = [ordered]@{ type = 'integer'; description = 'Optional maximum number of lines to return, counted from start_line.' } }
            required = @('path') } } },
    @{ type = 'function'; function = [ordered]@{
        name = 'list_files'
        description = 'List workspace files matching a wildcard pattern such as *.ps1.'
        parameters = [ordered]@{ type = 'object'; additionalProperties = $false
            properties = [ordered]@{ pattern = [ordered]@{ type = 'string'; description = 'Wildcard file name pattern.' } }
            required = @('pattern') } } },
    @{ type = 'function'; function = [ordered]@{
        name = 'search_files'
        description = "Search workspace file contents with a regular expression and return matching lines. Returns at most $($script:DefaultSearchResults) matches unless max_results says otherwise."
        parameters = [ordered]@{ type = 'object'; additionalProperties = $false
            properties = [ordered]@{
                pattern = [ordered]@{ type = 'string'; description = 'Regular expression to search for.' }
                include = [ordered]@{ type = 'string'; description = 'Optional wildcard file name filter.' }
                max_results = [ordered]@{ type = 'integer'; description = "Optional maximum number of matching lines to return (default $($script:DefaultSearchResults))." } }
            required = @('pattern') } } }
)

$script:WriteTools = @(
    @{ type = 'function'; function = [ordered]@{
        name = 'write_file'
        description = 'Create a new UTF-8 text file in the workspace, or overwrite one outright. For a file that already exists, use edit_file instead: the full content passed here stays in the conversation and consumes the context window.'
        parameters = [ordered]@{ type = 'object'; additionalProperties = $false
            properties = [ordered]@{
                path = [ordered]@{ type = 'string'; description = 'Workspace-relative file path.' }
                content = [ordered]@{ type = 'string'; description = 'Full new file content.' } }
            required = @('path', 'content') } } },
    @{ type = 'function'; function = [ordered]@{
        name = 'edit_file'
        description = 'Replace one exact, unique block of text in an existing workspace file. This is the preferred way to change a file that already exists.'
        parameters = [ordered]@{ type = 'object'; additionalProperties = $false
            properties = [ordered]@{
                path = [ordered]@{ type = 'string'; description = 'Workspace-relative file path.' }
                old_text = [ordered]@{ type = 'string'; description = 'Exact text to replace. Must occur exactly once.' }
                new_text = [ordered]@{ type = 'string'; description = 'Replacement text.' } }
            required = @('path', 'old_text', 'new_text') } } }
)

$script:Tools = if ($ReadOnly) { $script:ReadTools } else { $script:ReadTools + $script:WriteTools }

# --- worker-verified state --------------------------------------------------------------
# Everything below is recorded by the worker as tools actually run, so it survives a
# compaction without depending on the model correctly recalling its own history. It is
# presented to the model separately from the model's own summary for exactly that reason.
# Keyed by path rather than a plain list: the same file is read more than once across a
# session (windowed, then in full, or the other way round), and a plain list of rendered
# "path" / "path (partial)" strings would let both survive as distinct entries with
# contradictory status for the same file. One entry per path, sticky true once any read of
# it was whole, keeps that status meaningful.
$script:FilesRead = [ordered]@{}
$script:FileChanges = [ordered]@{}
$script:Searches = [Collections.Generic.List[string]]::new()
$script:ToolErrors = [Collections.Generic.List[string]]::new()
$script:RecentActions = [Collections.Generic.List[string]]::new()
$script:CompactionCount = 0
$script:LastSummaryBlock = ''
$script:LastReadWasWhole = $false
$script:LastCompactionTurn = 0

function Register-ToolOutcome {
    <#
    .SYNOPSIS
        Records the facts a compaction must not lose: what was read, what changed, what failed.
    #>
    param(
        [Parameter(Mandatory)][int]$Turn,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][hashtable]$Arguments,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Result,
        [Parameter(Mandatory)][bool]$Failed
    )

    $subject = ''
    foreach ($key in 'path', 'pattern') {
        if ($Arguments.ContainsKey($key) -and $null -ne $Arguments[$key]) {
            $subject = Limit-Text ([string]$Arguments[$key]) 120
            break
        }
    }

    if (-not $Failed -and $subject) {
        switch ($Name) {
            'read_file' {
                # A windowed or size-truncated read is recorded as partial. Recording it as
                # a plain "file read" would combine with the instruction not to re-read a
                # file already read, and leave the model believing it has seen content that
                # compaction has since removed and that it never had in full. $Whole comes
                # from Invoke-WorkerTool's own accounting of the read, not from matching the
                # returned text for a truncation marker: this file's own source contains
                # those marker phrases, so a whole read of it would otherwise misclassify
                # itself as partial.
                #
                # One entry per path, not one per (path, whole/partial) pair: without that,
                # the same file read once windowed and once whole records as two distinct
                # strings and shows both, contradictorily, in the same block. Sticky true
                # once whole, since a read that happened is a fact regardless of what is read
                # afterwards.
                if (-not $script:FilesRead.Contains($subject)) {
                    if ($script:FilesRead.Count -ge 30) {
                        # Oldest entry, by insertion order, as with every other bounded list.
                        $script:FilesRead.Remove(@($script:FilesRead.Keys)[0])
                    }
                    $script:FilesRead[$subject] = $false
                }
                if ($script:LastReadWasWhole) { $script:FilesRead[$subject] = $true }
            }
            'search_files' {
                if (-not $script:Searches.Contains($subject)) { Add-BoundedEntry -List $script:Searches -Value $subject -Max 12 }
            }
            { $_ -in @('write_file', 'edit_file') } {
                if (-not $script:FileChanges.Contains($subject)) { $script:FileChanges[$subject] = [ordered]@{ write = 0; edit = 0 } }
                $operation = if ($Name -eq 'write_file') { 'write' } else { 'edit' }
                $script:FileChanges[$subject][$operation] = [int]$script:FileChanges[$subject][$operation] + 1
            }
            default { }
        }
    }

    if ($Failed) {
        Add-BoundedEntry -List $script:ToolErrors -Value "turn ${Turn}: $Name($subject): $(Limit-Text $Result 200)" -Max 8
    }
    $outcome = if ($Failed) { 'ERROR' } else { 'ok' }
    Add-BoundedEntry -List $script:RecentActions -Value "turn ${Turn}: $Name($subject) -> $outcome" -Max 12
}

function Get-VerifiedStateBlock {
    <#
    .SYNOPSIS
        Renders the worker's own record of the session as plain text for re-injection.
    #>
    param([Parameter(Mandatory)][int]$Turn)

    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add("Turns used: $Turn of $MaxTurns. Compactions so far: $script:CompactionCount.")

    $read = if ($script:FilesRead.Count -eq 0) {
        '(none)'
    }
    else {
        (@(foreach ($path in $script:FilesRead.Keys) {
            if ($script:FilesRead[$path]) { $path } else { "$path (partial)" }
        })) -join ', '
    }
    $lines.Add("Files read: $read")

    if ($script:FileChanges.Count -eq 0) {
        $lines.Add('Files changed: (none yet)')
    }
    else {
        # Bounded like the other collections. This one grows with the work rather than with
        # a rolling window, and the block is truncated from the end, so an unbounded list
        # here would push the tool errors and recent actions out of a small window.
        $changed = @(foreach ($path in $script:FileChanges.Keys) {
            $counts = $script:FileChanges[$path]
            $parts = @()
            if ([int]$counts['edit'] -gt 0) { $parts += "$([int]$counts['edit']) edit(s)" }
            if ([int]$counts['write'] -gt 0) { $parts += "$([int]$counts['write']) write(s)" }
            "$path ($($parts -join ', '))"
        })
        $shown = @($changed | Select-Object -Last 20)
        $suffix = if ($changed.Count -gt $shown.Count) { " (and $($changed.Count - $shown.Count) earlier file(s))" } else { '' }
        $lines.Add("Files changed: $($shown -join ', ')$suffix")
    }

    if ($script:Searches.Count -gt 0) { $lines.Add("Searches run: $($script:Searches -join ' | ')") }

    if ($script:ToolErrors.Count -eq 0) {
        $lines.Add('Tool errors: (none)')
    }
    else {
        $lines.Add('Tool errors (most recent last):')
        foreach ($entry in $script:ToolErrors) { $lines.Add("  - $entry") }
    }

    if ($script:RecentActions.Count -gt 0) {
        $lines.Add('Recent actions (most recent last):')
        foreach ($entry in $script:RecentActions) { $lines.Add("  - $entry") }
    }

    return ($lines -join "`n")
}

function Invoke-OllamaChat {
    param(
        [Parameter(Mandatory)][array]$Messages,
        [array]$Tools,
        $Format,
        [nullable[bool]]$Think
    )

    $payload = [ordered]@{
        model = $Model
        messages = $Messages
        stream = $false
        # The native API honours num_ctx per request, so unlike the Anthropic-compatible
        # endpoint this route needs no 'ollama create' derived model to raise the window.
        options = [ordered]@{ num_ctx = $ContextTokens }
    }
    if ($Tools) { $payload.tools = $Tools }
    if ($Format) { $payload.format = $Format }
    if ($null -ne $Think) { $payload.think = [bool]$Think }

    try {
        return Invoke-RestMethod -Uri $OllamaUri -Method Post -ContentType 'application/json' `
            -Body ($payload | ConvertTo-Json -Depth 30 -Compress) -TimeoutSec $RequestTimeoutSeconds
    }
    catch {
        # The exception message is only the HTTP status; Ollama's actual complaint (an
        # unloadable model, a rejected schema) is in the response body, and losing it
        # reproduces exactly the diagnostic dead end the claude route already fixed.
        $detail = [string](Get-OptionalProperty $_.ErrorDetails 'Message' '')
        $detail = $detail.Trim()
        # Bounded: when the body cannot be read this field holds a full .NET stack trace,
        # which would bury the status line it is meant to explain.
        if ($detail.Length -gt 1000) { $detail = $detail.Substring(0, 1000) + '...[truncated]' }
        if ($detail) { throw "Ollama request failed: $($_.Exception.Message) - $detail" }
        throw "Ollama request failed: $($_.Exception.Message)"
    }
}

function ConvertTo-RequestToolCall {
    <#
    .SYNOPSIS
        Reduces a response tool_call to the minimal shape the request format defines.
    .DESCRIPTION
        Echoing Ollama's own response objects back into the next request carries
        response-only fields (id, function.index) into a request body that does not
        define them, which is a needless way to perturb chat-template rendering.
    #>
    param([Parameter(Mandatory)]$ToolCall)

    return [ordered]@{
        function = [ordered]@{
            name = [string]$ToolCall.function.name
            arguments = $ToolCall.function.arguments
        }
    }
}

function ConvertTo-ArgumentTable {
    param($Arguments)

    $table = @{}
    if ($null -eq $Arguments) { return $table }
    if ($Arguments -is [System.Collections.IDictionary]) {
        foreach ($key in $Arguments.Keys) { $table[[string]$key] = $Arguments[$key] }
        return $table
    }
    foreach ($property in $Arguments.PSObject.Properties) { $table[$property.Name] = $property.Value }
    return $table
}

function Invoke-WorkerTool {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][hashtable]$Arguments
    )

    function Get-Argument {
        param([string]$Key, [switch]$Optional)
        if (-not $Arguments.ContainsKey($Key) -or $null -eq $Arguments[$Key]) {
            if ($Optional) { return '' }
            throw "missing required argument '$Key'"
        }
        return [string]$Arguments[$Key]
    }

    # Omitting the editing tools from the advertised list is a hint, not a boundary: a
    # model can name a tool it was never offered. The read-only contract is enforced here,
    # at the only place that can actually touch the file system.
    if ($ReadOnly -and $Name -in @('write_file', 'edit_file')) {
        throw "tool '$Name' is not available to a read-only runner"
    }

    switch ($Name) {
        'read_file' {
            $relative = Get-Argument 'path'
            $target = Resolve-WorkerPath $relative
            if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "file not found: $relative" }
            $lines = @([IO.File]::ReadAllLines($target))
            $startLine = 1
            $requestedStart = Get-Argument 'start_line' -Optional
            if ($requestedStart) { $startLine = [Math]::Max(1, [int]$requestedStart) }
            if ($startLine -gt $lines.Count) {
                # Neither a window nor the file's content: nothing was actually read.
                $script:LastReadWasWhole = $false
                return "start_line $startLine is past the end of $relative ($($lines.Count) lines)"
            }

            # max_lines lets the model ask for the window it actually needs. Without it the
            # only bound is MaxToolResultChars, which is a whole-context-sized bite.
            $endIndex = $lines.Count - 1
            $requestedMax = Get-Argument 'max_lines' -Optional
            if ($requestedMax) {
                $maxLines = [int]$requestedMax
                if ($maxLines -lt 1) { throw 'max_lines must be at least 1' }
                $endIndex = [Math]::Min($endIndex, $startLine - 1 + $maxLines - 1)
            }
            $body = ($lines[($startLine - 1)..$endIndex] -join "`n")
            $windowed = $startLine -gt 1 -or $endIndex -lt ($lines.Count - 1)
            if ($body.Length -le $MaxToolResultChars) {
                # Set from the same facts the branch below is already choosing on, not by
                # matching the returned text for a truncation marker: this file's own source
                # contains those marker phrases, so a whole read of it would otherwise
                # misclassify itself as partial.
                $script:LastReadWasWhole = -not $windowed
                if (-not $windowed) { return $body }
                $header = "[$relative lines $startLine-$($endIndex + 1) of $($lines.Count)]"
                if ($endIndex -lt ($lines.Count - 1)) {
                    return "$header`n$body`n...[stopped at max_lines; call read_file with start_line=$($endIndex + 2) to continue]"
                }
                return "$header`n$body"
            }
            # Report the line the model should resume from, so the tail of a long file
            # stays reachable instead of being permanently cut off by the size bound.
            $script:LastReadWasWhole = $false
            $kept = $body.Substring(0, $MaxToolResultChars)
            $nextLine = $startLine + ([regex]::Matches($kept, "`n")).Count
            return "$kept`n...[truncated after $MaxToolResultChars characters; call read_file again with start_line=$nextLine to continue]"
        }
        'list_files' {
            $matched = @(Get-ChildItem -LiteralPath $script:Workspace -Filter (Get-Argument 'pattern') -Recurse -File -ErrorAction SilentlyContinue |
                ForEach-Object { $_.FullName.Substring($script:Workspace.Length + 1) })
            if ($matched.Count -eq 0) { return 'no files matched' }
            return Limit-ToolResult ($matched -join "`n")
        }
        'search_files' {
            $include = Get-Argument 'include' -Optional
            $files = if ($include) {
                Get-ChildItem -LiteralPath $script:Workspace -Filter $include -Recurse -File -ErrorAction SilentlyContinue
            }
            else {
                Get-ChildItem -LiteralPath $script:Workspace -Recurse -File -ErrorAction SilentlyContinue
            }
            $limit = $script:DefaultSearchResults
            $requestedResults = Get-Argument 'max_results' -Optional
            if ($requestedResults) {
                $limit = [int]$requestedResults
                if ($limit -lt 1) { throw 'max_results must be at least 1' }
            }
            $hits = @($files | Select-String -Pattern (Get-Argument 'pattern') -ErrorAction SilentlyContinue |
                ForEach-Object { "$($_.Path.Substring($script:Workspace.Length + 1)):$($_.LineNumber): $($_.Line.Trim())" })
            if ($hits.Count -eq 0) { return 'no matches' }
            if ($hits.Count -gt $limit) {
                # Bound the hits first and append the notice afterwards: run the other way
                # round, the character limit cuts off the very sentence that says results
                # were dropped, and the model reads a partial list as a complete one.
                $shown = Limit-ToolResult ($hits[0..($limit - 1)] -join "`n")
                return "$shown`n...[showing $limit of $($hits.Count) matches; narrow the pattern or raise max_results]"
            }
            return Limit-ToolResult ($hits -join "`n")
        }
        'write_file' {
            $relative = Get-Argument 'path'
            $target = Resolve-WorkerPath $relative
            $parent = Split-Path -Parent $target
            if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }
            [IO.File]::WriteAllText($target, (Get-Argument 'content'), [Text.UTF8Encoding]::new($false))
            return "wrote $relative"
        }
        'edit_file' {
            $relative = Get-Argument 'path'
            $target = Resolve-WorkerPath $relative
            if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "file not found: $relative" }
            $original = [IO.File]::ReadAllText($target)
            $oldText = Get-Argument 'old_text'
            $newText = Get-Argument 'new_text'
            if ($oldText -eq '') { throw 'old_text must not be empty' }
            $occurrences = ([regex]::Matches($original, [regex]::Escape($oldText))).Count
            if ($occurrences -eq 0) {
                # A model reproduces multi-line text with LF even when the file on disk is
                # CRLF, so a byte-exact requirement would reject correct edits and push it
                # toward rewriting whole files. Retry once against normalized newlines and
                # write the result back in the file's own convention.
                $usesCrLf = $original.Contains("`r`n")
                $normalizedOriginal = $original -replace "`r`n", "`n"
                $normalizedOld = $oldText -replace "`r`n", "`n"
                $normalizedOccurrences = ([regex]::Matches($normalizedOriginal, [regex]::Escape($normalizedOld))).Count
                if ($normalizedOccurrences -eq 0) { throw "old_text was not found in $relative" }
                if ($normalizedOccurrences -gt 1) { throw "old_text occurs $normalizedOccurrences times in $relative; include more surrounding context to make it unique" }
                $updated = $normalizedOriginal.Replace($normalizedOld, ($newText -replace "`r`n", "`n"))
                if ($usesCrLf) { $updated = $updated -replace "`n", "`r`n" }
                [IO.File]::WriteAllText($target, $updated, [Text.UTF8Encoding]::new($false))
                return "edited $relative"
            }
            if ($occurrences -gt 1) { throw "old_text occurs $occurrences times in $relative; include more surrounding context to make it unique" }
            $updated = $original.Replace($oldText, $newText)
            [IO.File]::WriteAllText($target, $updated, [Text.UTF8Encoding]::new($false))
            return "edited $relative"
        }
        default { throw "unknown tool: $Name" }
    }
}

# --- context accounting and compaction ----------------------------------------------------

function Measure-MessageTokens {
    <#
    .SYNOPSIS
        Estimates the prompt size of a message list.
    .DESCRIPTION
        An estimate, and deliberately so: it covers the messages that have not been sent yet
        (so no counter exists for them) and the turns where Ollama omits prompt_eval_count.

        Measured as UTF-8 bytes over three, not characters over four. The familiar four
        characters per token only holds for ASCII: this project's own prompts and issue text
        are Japanese, which ConvertTo-Json leaves unescaped and which tokenizes at roughly
        one token per character, so counting characters understates such a prompt about
        fourfold. Three bytes per token is one token per Japanese character and one token
        per three ASCII characters, which overstates ASCII by a third. Overstating is the
        harmless direction: it compacts slightly early, whereas understating is the failure
        this number exists to prevent.
    #>
    param([array]$Messages)

    if ($null -eq $Messages -or $Messages.Count -eq 0) { return 0 }
    # -InputObject rather than the pipeline: a single-element list piped in would be
    # serialized as the element itself, and the count is what is being measured.
    $json = ConvertTo-Json -InputObject $Messages -Depth 30 -Compress
    return [int][Math]::Ceiling([Text.Encoding]::UTF8.GetByteCount($json) / 3)
}

function Limit-TextToTokens {
    <#
    .SYNOPSIS
        Trims text until its estimated token count fits a budget.
    .DESCRIPTION
        Trims the front by default, which is what a transcript digest wants: the newest
        turns are the ones still being reasoned about. -FromStart keeps the beginning
        instead, for text whose opening lines are the point of it.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory)][int]$BudgetTokens,
        [switch]$FromStart
    )

    $budgetBytes = $BudgetTokens * 3
    $bytes = [Text.Encoding]::UTF8.GetByteCount($Text)
    if ($bytes -le $budgetBytes) { return $Text }
    # Cut proportionally first, then shave until it actually fits: the ratio of bytes to
    # characters is not uniform across text that mixes source code and prose.
    $keepChars = [Math]::Max(1, [int]($Text.Length * $budgetBytes / $bytes))
    if ($FromStart) {
        $trimmed = $Text.Substring(0, $keepChars)
        while ($trimmed.Length -gt 200 -and [Text.Encoding]::UTF8.GetByteCount($trimmed) -gt $budgetBytes) {
            $trimmed = $trimmed.Substring(0, $trimmed.Length - [Math]::Max(1, [int]($trimmed.Length * 0.1)))
        }
        return "$trimmed`n...[truncated to fit the context budget]"
    }
    $trimmed = $Text.Substring($Text.Length - $keepChars)
    while ($trimmed.Length -gt 200 -and [Text.Encoding]::UTF8.GetByteCount($trimmed) -gt $budgetBytes) {
        $trimmed = $trimmed.Substring([Math]::Max(1, [int]($trimmed.Length * 0.1)))
    }
    return "...[older detail omitted from this digest]`n$trimmed"
}

function Get-CompactionThreshold {
    return [int]($ContextTokens * $CompactAtPercent / 100)
}

function Get-ExchangeStarts {
    <#
    .SYNOPSIS
        The indexes at which a rebuilt history may resume, in ascending order.
    .DESCRIPTION
        A tool result only means anything next to the assistant turn that requested it, so
        the only valid resume points are the non-tool messages: cutting anywhere else
        orphans a result from its call. The message count itself is included as the last
        option, which retains nothing -- the only choice left when a single exchange is
        larger than the window, as one assistant turn answering with ten parallel tool
        calls can be.
    #>
    param([Parameter(Mandatory)][array]$Messages, [Parameter(Mandatory)][int]$Floor)

    $starts = [Collections.Generic.List[int]]::new()
    for ($index = $Floor; $index -lt $Messages.Count; $index++) {
        if ([string]$Messages[$index]['role'] -ne 'tool') { $starts.Add($index) }
    }
    $starts.Add($Messages.Count)
    return $starts
}

function Get-MessageRange {
    param([Parameter(Mandatory)][array]$Messages, [int]$Start, [int]$End)

    # PowerShell ranges count downward when the start is past the end, which would silently
    # reverse the conversation instead of yielding nothing.
    if ($Start -gt $End) { return @() }
    return @($Messages[$Start..$End])
}

# Bounds the digest handed to the summarization call. That call is a fresh two-message
# conversation rather than a continuation of the session, so the only thing that could push
# it near the window is the digest itself; roughly a third of the window leaves the model
# ample room to answer.
$script:SummaryInputTokens = [Math]::Max(500, [Math]::Min(10000, [int]($ContextTokens * 0.35)))

# Bounds the message that replaces the dropped turns. Without a cap it grows across
# compactions -- each one summarizes the previous summary along with new turns -- until the
# block alone exceeds the threshold, at which point compaction can no longer reclaim
# anything and simply re-runs, paying for a summarization call every turn. The two halves
# get half each so a long verified-state record cannot crowd out the model's summary or the
# other way round.
#
# A fraction of the threshold, not of the window: this figure is also what gets reserved
# when deciding how much history to keep, and the space being divided up there is the
# threshold. Taken from the window it would claim well over half the usable budget at a low
# CompactAtPercent, leaving nothing for the recent turns it exists alongside.
$script:MaxBlockTokens = [Math]::Max(400, [int]($ContextTokens * $CompactAtPercent / 100 * 0.35))
$script:MaxBlockHalfTokens = [int]($script:MaxBlockTokens / 2)

$script:SummarySchema = [ordered]@{
    type = 'object'
    properties = [ordered]@{
        goal = [ordered]@{ type = 'string' }
        constraints = [ordered]@{ type = 'array'; items = [ordered]@{ type = 'string' } }
        filesInspected = [ordered]@{ type = 'array'; items = [ordered]@{ type = 'string' } }
        filesChanged = [ordered]@{ type = 'array'; items = [ordered]@{ type = 'string' } }
        decisions = [ordered]@{ type = 'array'; items = [ordered]@{ type = 'string' } }
        failedAttempts = [ordered]@{ type = 'array'; items = [ordered]@{ type = 'string' } }
        currentState = [ordered]@{ type = 'string' }
        remainingWork = [ordered]@{ type = 'array'; items = [ordered]@{ type = 'string' } }
    }
    required = @('goal', 'constraints', 'filesInspected', 'filesChanged', 'decisions', 'failedAttempts', 'currentState', 'remainingWork')
}

function Get-TranscriptDigest {
    <#
    .SYNOPSIS
        Flattens the messages a compaction is about to drop into bounded plain text.
    #>
    param([Parameter(Mandatory)][array]$Messages, [Parameter(Mandatory)][int]$BudgetTokens)

    $lines = [Collections.Generic.List[string]]::new()
    foreach ($message in $Messages) {
        $role = [string]$message['role']
        $content = [string]$message['content']
        if ($role -eq 'assistant') {
            if (-not [string]::IsNullOrWhiteSpace($content)) { $lines.Add("assistant: $(Limit-Text $content 1200)") }
            if ($message.Contains('tool_calls')) {
                foreach ($call in @($message['tool_calls'])) {
                    $arguments = Limit-Text ($call['function']['arguments'] | ConvertTo-Json -Depth 10 -Compress) 300
                    $lines.Add("assistant called $($call['function']['name']) with $arguments")
                }
            }
        }
        elseif ($role -eq 'tool') {
            $lines.Add("result of $([string]$message['tool_name']): $(Limit-Text $content 600)")
        }
        else {
            $lines.Add("${role}: $(Limit-Text $content 1500)")
        }
    }

    # Keep the tail: the newest turns are the ones the model still has to reason about, and
    # anything older has already been folded into the summary carried over from the previous
    # compaction.
    return Limit-TextToTokens -Text ($lines -join "`n") -BudgetTokens $BudgetTokens
}

function Format-SummaryField {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Source,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$Label
    )

    if (-not $Source.Contains($Key) -or $null -eq $Source[$Key]) { return "${Label}: (not reported)" }
    $value = $Source[$Key]
    if ($value -isnot [string] -and $value -is [System.Collections.IEnumerable]) {
        $items = @($value | ForEach-Object { Limit-Text ([string]$_) 300 } | Where-Object { $_ })
        if ($items.Count -eq 0) { return "${Label}: (none)" }
        # Bounded like every other recorded collection: nothing stops a model from
        # returning a hundred "decisions", and this text is carried into the next
        # compaction's input as well as into the rebuilt history.
        $shown = @($items | Select-Object -First 10)
        $rendered = "${Label}:`n" + ((($shown | ForEach-Object { "  - $_" })) -join "`n")
        if ($items.Count -gt $shown.Count) { $rendered += "`n  - ...and $($items.Count - $shown.Count) more" }
        return $rendered
    }
    $text = Limit-Text ([string]$value) 800
    if (-not $text) { return "${Label}: (none)" }
    return "${Label}: $text"
}

function Get-ModelWorkingSummary {
    <#
    .SYNOPSIS
        Asks the model to compress the dropped turns into a structured working summary.
    .DESCRIPTION
        Sent as its own two-message conversation rather than as a continuation of the
        session, so it cannot be the request that finally overruns the window it exists to
        protect. Any failure here is reported and tolerated: the verified state block alone
        is still a usable, if thinner, handover, and losing a summary is not a reason to
        fail a step whose work is already on disk.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Transcript,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Task,
        [Parameter(Mandatory)][AllowEmptyString()][string]$CarryOver
    )

    $previous = if ($CarryOver) { "Summary carried over from the previous compaction:`n$CarryOver`n" } else { '' }
    $request = @(
        [ordered]@{ role = 'system'; content = @'
You compress a coding session into a structured working summary that the same worker will
continue from. Report only what the transcript supports. Never invent a file, a decision,
or a result. Be specific: name files, functions, and exact error text.
'@ },
        [ordered]@{ role = 'user'; content = @"
The task being worked on:
$(Limit-Text $Task 4000)

$previous
Transcript of the turns being removed from the conversation:
$Transcript

Produce the structured working summary as JSON matching the required schema.
"@ }
    )

    try {
        $response = Invoke-OllamaChat -Messages $request -Tools $null -Format $script:SummarySchema -Think $false
    }
    catch {
        Write-Warning "Context compaction summary request failed: $($_.Exception.Message)"
        return ''
    }
    # Read defensively rather than as $response.message.content: a 200 that omits the
    # message would be a terminating error under StrictMode, and this function's whole
    # contract is that a bad summary degrades the block instead of failing the step.
    $content = [string](Get-OptionalProperty (Get-OptionalProperty $response 'message' $null) 'content' '')
    if ([string]::IsNullOrWhiteSpace($content)) {
        Write-Warning 'Context compaction summary came back empty; keeping the verified state only.'
        return ''
    }
    try { $parsed = $content | ConvertFrom-Json -AsHashtable }
    catch {
        Write-Warning 'Context compaction summary was not valid JSON; keeping the verified state only.'
        return ''
    }
    if ($parsed -isnot [System.Collections.IDictionary]) { return '' }

    $fields = @(
        (Format-SummaryField -Source $parsed -Key 'goal' -Label 'Goal'),
        (Format-SummaryField -Source $parsed -Key 'constraints' -Label 'Constraints'),
        (Format-SummaryField -Source $parsed -Key 'filesInspected' -Label 'Files inspected'),
        (Format-SummaryField -Source $parsed -Key 'filesChanged' -Label 'Files changed'),
        (Format-SummaryField -Source $parsed -Key 'decisions' -Label 'Decisions'),
        (Format-SummaryField -Source $parsed -Key 'failedAttempts' -Label 'Failed attempts'),
        (Format-SummaryField -Source $parsed -Key 'currentState' -Label 'Current state'),
        (Format-SummaryField -Source $parsed -Key 'remainingWork' -Label 'Remaining work')
    )
    # Capped here rather than only where it is rendered, because this text is also carried
    # into the next compaction as prior context; an uncapped summary would compound.
    return Limit-TextToTokens -Text ($fields -join "`n") -BudgetTokens $script:MaxBlockHalfTokens -FromStart
}

function New-HistoryBlock {
    <#
    .SYNOPSIS
        Builds the single message that stands in for the turns that were dropped.
    .DESCRIPTION
        The two halves are labelled apart on purpose. The first is what the worker observed
        itself and is therefore true; the second is the model's own account and may not be.
        A model that cannot tell those apart will trust a hallucinated 'already fixed' as
        readily as a recorded edit.
    #>
    param(
        [Parameter(Mandatory)][string]$Heading,
        [Parameter(Mandatory)][string]$Preamble,
        [Parameter(Mandatory)][int]$Turn,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Summary
    )

    $verified = Limit-TextToTokens -Text (Get-VerifiedStateBlock -Turn $Turn) -BudgetTokens $script:MaxBlockHalfTokens -FromStart
    $modelPart = if ($Summary) {
        Limit-TextToTokens -Text $Summary -BudgetTokens $script:MaxBlockHalfTokens -FromStart
    }
    else {
        '(unavailable: rely on the verified facts above and on the messages that follow)'
    }
    return @"
=== $Heading ===
$Preamble
The task stated in the previous message is unchanged and remains the goal.

-- Verified by the orchestrator (observed, not recalled) --
$verified

-- Your own summary of the removed turns (model-generated, may be incomplete) --
$modelPart
=== END OF COMPACTED HISTORY ===
"@
}

function Update-WorkingSummary {
    <#
    .SYNOPSIS
        Folds the messages about to be dropped into the running working summary.
    #>
    param([Parameter(Mandatory)][array]$Dropped)

    $digest = Get-TranscriptDigest -Messages $Dropped -BudgetTokens $script:SummaryInputTokens
    $summary = Get-ModelWorkingSummary -Transcript $digest `
        -Task ([string]$script:Messages[1]['content']) -CarryOver $script:LastSummaryBlock
    # Only replace on success: a failed or unusable call must not erase what an earlier
    # compaction already established.
    if ($summary) { $script:LastSummaryBlock = $summary }
    return $script:LastSummaryBlock
}

function Resolve-RetentionBoundary {
    <#
    .SYNOPSIS
        Decides how much of the tail a rebuilt history can afford to keep.
    .DESCRIPTION
        Walks the valid resume points from the earliest to the latest and takes the first
        that both honours the retention policy and leaves the surviving history under the
        threshold with room reserved for the replacement block. Earliest-first means the
        most context that can be afforded is the context that is kept.

        The retained tail can be the expensive part on its own: five full-size tool results,
        or one write_file argument holding a whole file, can exceed the threshold with the
        rest of the history already gone. Keeping fewer of them is then the only lever left,
        and if no resume point fits, the last one retains nothing at all.

        RequireDrop refuses the "keep everything" boundary. The in-loop caller passes it
        because compaction there is a response to the provider's own prompt_eval_count, and
        that counter, not this estimate, is the authority on whether the window is filling
        up. If the two disagree, dropping the oldest exchange is always a better answer than
        declining and sending the request anyway.

        This runs before the block is built, not after, so that the summarization digest can
        be taken over exactly the messages that are about to be dropped. Choosing the
        boundary afterwards would silently discard the messages between the two boundaries:
        summarized out of one and truncated out of the other.
    #>
    param(
        [Parameter(Mandatory)][array]$Original,
        [Parameter(Mandatory)][int]$Keep,
        [switch]$RequireDrop
    )

    $floor = $script:ProtectedMessageCount
    # The block does not exist yet, but it is capped, so its cap can be reserved instead.
    $budget = [Math]::Max(1, (Get-CompactionThreshold) - $script:MaxBlockTokens)
    foreach ($start in (Get-ExchangeStarts -Messages $Original -Floor $floor)) {
        # Two, not one: after a previous compaction the first candidate drops only the old
        # block, which is replaced by a new one of the same capped size. That reclaims
        # nothing, so the next exchange has to go with it.
        if ($RequireDrop -and ($start - $floor) -lt 2) { continue }
        if (($Original.Count - $start) -gt $Keep) { continue }
        $kept = @($Original[0], $Original[1]) + (Get-MessageRange -Messages $Original -Start $start -End ($Original.Count - 1))
        if ((Measure-MessageTokens $kept) -lt $budget) { return $start }
    }
    return $Original.Count
}

function New-RebuiltHistory {
    param([Parameter(Mandatory)][array]$Original, [Parameter(Mandatory)]$BlockMessage, [Parameter(Mandatory)][int]$Start)

    $tail = Get-MessageRange -Messages $Original -Start $Start -End ($Original.Count - 1)
    return , (@($Original[0], $Original[1], $BlockMessage) + $tail)
}

function Test-CompactionThresholdCrossed {
    <#
    .SYNOPSIS
        Runs the in-loop threshold check and compacts if crossed.
    .DESCRIPTION
        Shared by both places a turn can end: one with tool calls still to process, one
        without. Without this, the two call sites would each re-derive the same projection
        formula, and a future change to how PromptTokens and Measure-MessageTokens combine
        could be made in one without the other, silently making a turn that ends on a tool
        call and one that ends on plain content diverge in when they compact.
    #>
    param(
        [Parameter(Mandatory)][int]$Turn,
        [Parameter(Mandatory)][int]$SentCount,
        [Parameter(Mandatory)][int]$PromptTokens
    )

    if ($CompactAtPercent -le 0) { return }
    # prompt_eval_count describes the request that was just sent, not the one about to be:
    # this turn's assistant message, and any tool results, were appended after it.
    # Projecting them keeps the decision ahead of the window rather than one turn behind it.
    $appended = Get-MessageRange -Messages $script:Messages -Start $SentCount -End ($script:Messages.Count - 1)
    $projected = if ($PromptTokens -gt 0) { $PromptTokens + (Measure-MessageTokens $appended) } else { Measure-MessageTokens $script:Messages }
    if ($projected -ge (Get-CompactionThreshold)) {
        Invoke-ContextCompaction -Turn $Turn -BeforeTokens $projected
    }
}

function Invoke-ContextCompaction {
    <#
    .SYNOPSIS
        Rewrites the history in place once the next request would approach the window.
    #>
    param(
        [Parameter(Mandatory)][int]$Turn,
        [Parameter(Mandatory)][int]$BeforeTokens
    )

    $floor = $script:ProtectedMessageCount
    $start = Resolve-RetentionBoundary -Original $script:Messages -Keep $KeepRecentMessages -RequireDrop
    $droppable = $start - $floor
    if ($droppable -lt 2) {
        # A single message cannot be summarized into less than itself, and re-running the
        # summarizer every turn would spend more context than it reclaims.
        Write-Host "compaction: turn=$Turn skipped droppable_messages=$droppable prompt_tokens_before~$BeforeTokens"
        return
    }

    $dropped = Get-MessageRange -Messages $script:Messages -Start $floor -End ($start - 1)
    $summary = Update-WorkingSummary -Dropped $dropped
    $script:CompactionCount++
    # Read by Compress-FinalContext: a compaction that just rebuilt the history this same
    # turn has already reserved headroom under the threshold (Resolve-RetentionBoundary's
    # budget subtracts the block's own cap), so a second reduction immediately afterward
    # would almost always find nothing left worth doing and pay a summarization call for it.
    $script:LastCompactionTurn = $Turn
    $block = New-HistoryBlock -Heading "HDO CONTEXT COMPACTION (after turn $Turn)" `
        -Preamble 'Earlier turns of this session were removed to stay inside the context window.' `
        -Turn $Turn -Summary $summary

    $before = $script:Messages.Count
    $script:Messages = New-RebuiltHistory -Original $script:Messages `
        -BlockMessage ([ordered]@{ role = 'user'; content = $block }) -Start $start
    Write-Host ("compaction: turn=$Turn reason=threshold prompt_tokens_before~$BeforeTokens " +
        "prompt_tokens_after~$(Measure-MessageTokens $script:Messages) messages=$before->$($script:Messages.Count) " +
        "kept_recent=$($script:Messages.Count - $floor - 1)")
}

function Compress-FinalContext {
    <#
    .SYNOPSIS
        Reduces the history once more before the schema-forced final turn.
    .DESCRIPTION
        The final turn only reformats work that is already done, so re-sending every tool
        result to produce it is the single largest avoidable request in a long run.

        It is applied only when the history is genuinely expensive or has already been
        compacted once. Discarding a transcript that fits comfortably would trade a real
        cost for an imaginary one: a short run would then report from the terse verified
        facts while its own transcript was still affordable.

        It costs one summarization call whenever it actually drops anything, because what it
        drops is by definition not covered by the last summary: every turn since the previous
        compaction, or the entire transcript when no compaction ever ran. Reusing the stale
        summary would be free and wrong -- the final report would describe the session up to
        some earlier turn and say nothing about the work done after it.
    #>
    param([Parameter(Mandatory)][int]$Turn)

    if ($CompactAtPercent -le 0) { return }
    if ($script:LastCompactionTurn -eq $Turn) {
        # A compaction already rewrote the history this exact turn, on the loop-break path.
        # Resolve-RetentionBoundary reserved the block's own cap as headroom when it chose
        # what to keep, so the result is already under threshold in every ordinary case;
        # running the summarizer again here would almost always find nothing left to trim.
        return
    }
    $floor = $script:ProtectedMessageCount
    $original = @($script:Messages)
    $overThreshold = (Measure-MessageTokens $original) -ge (Get-CompactionThreshold)
    # A short session skips the reduction, unless its few messages are themselves already
    # over the threshold: nothing bounds a closing assistant turn's content the way tool
    # results are bounded by MaxToolResultChars, so message count alone is not proof that
    # the history is cheap.
    if ($original.Count -le $floor + $KeepRecentMessages + 1 -and -not $overThreshold) { return }
    if ($script:CompactionCount -eq 0 -and -not $overThreshold) { return }

    $start = Resolve-RetentionBoundary -Original $original -Keep $KeepRecentMessages
    $droppable = $start - $floor
    if ($droppable -lt 1) { return }
    $dropped = Get-MessageRange -Messages $original -Start $floor -End ($start - 1)
    if ($droppable -eq 1 -and (Measure-MessageTokens $dropped) -le $script:MaxBlockTokens) {
        # Dropping one ordinary message and replacing it with a block of comparable size
        # would not meaningfully shrink the history, only spend a summarization call. An
        # oversized single message is different: the block is capped well below it, so this
        # is where the check above exists to let that case through.
        return
    }

    $summary = Update-WorkingSummary -Dropped $dropped
    $block = New-HistoryBlock -Heading 'HDO WORKING STATE (compacted for the final report)' `
        -Preamble 'The tool loop is finished. The full transcript was replaced by this record.' `
        -Turn $Turn -Summary $summary
    $script:Messages = New-RebuiltHistory -Original $original `
        -BlockMessage ([ordered]@{ role = 'user'; content = $block }) -Start $start
    Write-Host ("compaction: turn=$Turn reason=final prompt_tokens_after~$(Measure-MessageTokens $script:Messages) " +
        "messages=$($original.Count)->$($script:Messages.Count) kept_recent=$($script:Messages.Count - $floor - 1)")
}

# Ollama rejects the JSON Schema meta-keywords, so they are dropped the same way the
# Claude and Codex adapters normalize a schema before handing it to their CLI.
$schema = Get-Content -LiteralPath $SchemaFile -Raw | ConvertFrom-Json -AsHashtable
foreach ($metaKeyword in '$schema', '$id', 'title') {
    if ($schema.ContainsKey($metaKeyword)) { $schema.Remove($metaKeyword) }
}

$capabilities = if ($ReadOnly) {
    'You can read files, list them, and search their contents. You cannot modify anything.'
}
else {
    'You can read, list, search, create, and edit files.'
}

# Context is the scarce resource on a local model, and the model is the only party that can
# stop spending it. The compaction below is the safety net, not the plan.
$contextRules = [Collections.Generic.List[string]]::new()
if (-not $ReadOnly) {
    $contextRules.Add('- To change a file that already exists, use edit_file. Do not send a whole file through')
    $contextRules.Add('  write_file: that content stays in the conversation for the rest of the session. Use')
    $contextRules.Add('  write_file only to create a file that does not exist yet.')
}
$contextRules.Add('- Use search_files to find the relevant lines, then read_file with start_line and')
$contextRules.Add('  max_lines for just that region, instead of reading a whole large file.')
$contextRules.Add('- Do not re-read a file you have already read in full unless you changed it since.')
$contextRules.Add('  A file listed as "(partial)" in a compaction block was only read in part.')
$contextDiscipline = $contextRules -join "`n"

$script:Messages = @(
    [ordered]@{ role = 'system'; content = @"
You are a local coding worker operating inside a repository workspace.
$capabilities
Never guess a file's contents: read it first.
Do not attempt to run shell commands, git, builds, or tests. The orchestrator runs
trusted validation gates after you finish.
Make only the change the task asks for, then stop calling tools.

Your context window is small and every tool result stays in it. Work narrowly:
$contextDiscipline
If a message headed HDO CONTEXT COMPACTION appears, earlier turns were removed to stay
inside the window. Continue from it: the facts it lists were recorded by the orchestrator.
"@ },
    [ordered]@{ role = 'user'; content = (Get-Content -LiteralPath $PromptFile -Raw) }
)

$turnsUsed = 0
$exhausted = $true
for ($turn = 1; $turn -le $MaxTurns; $turn++) {
    $turnsUsed = $turn
    $sentCount = $script:Messages.Count
    $response = Invoke-OllamaChat -Messages $script:Messages -Tools $script:Tools
    $promptTokens = [int](Get-OptionalProperty $response 'prompt_eval_count')
    $assistant = [ordered]@{ role = 'assistant'; content = [string]$response.message.content }
    $toolCalls = @()
    if ($response.message.PSObject.Properties.Name -contains 'tool_calls' -and $response.message.tool_calls) {
        $toolCalls = @($response.message.tool_calls)
        $assistant['tool_calls'] = @($toolCalls | ForEach-Object { ConvertTo-RequestToolCall $_ })
    }
    $script:Messages += $assistant
    Write-Host "turn ${turn}: prompt_tokens=$promptTokens tool_calls=$($toolCalls.Count)"
    if ($toolCalls.Count -eq 0) {
        $exhausted = $false
        # The loop is about to end here, before the compaction check below this block ever
        # runs. Nothing bounds the size of $response.message.content the way tool results
        # are bounded by MaxToolResultChars, so a verbose closing turn can be the single
        # largest message of the whole session; skipping this check would let it reach
        # Compress-FinalContext, and then the final Ollama call, unreduced.
        Test-CompactionThresholdCrossed -Turn $turn -SentCount $sentCount -PromptTokens $promptTokens
        break
    }

    foreach ($call in $toolCalls) {
        $toolName = [string]$call.function.name
        $arguments = ConvertTo-ArgumentTable $call.function.arguments
        $failed = $false
        # Reset before every call: Register-ToolOutcome below only reads this after a
        # successful read_file, but a stale value from a previous call must never survive
        # to be attributed to a different one.
        $script:LastReadWasWhole = $false
        try {
            $result = Invoke-WorkerTool -Name $toolName -Arguments $arguments
        }
        catch {
            # Returned to the model rather than thrown: a wrong path or a non-unique
            # edit is something it can correct on the next turn. MaxTurns bounds the
            # retries. Mirrored to stderr so HDO's artifacts record the attempt.
            $result = "ERROR: $($_.Exception.Message)"
            $failed = $true
            Write-Warning "tool '$toolName' failed: $($_.Exception.Message)"
        }
        Register-ToolOutcome -Turn $turn -Name $toolName -Arguments $arguments -Result ([string]$result) -Failed $failed
        $script:Messages += [ordered]@{ role = 'tool'; tool_name = $toolName; content = [string]$result }
    }

    Test-CompactionThresholdCrossed -Turn $turn -SentCount $sentCount -PromptTokens $promptTokens
}

if ($exhausted) {
    Write-Warning "Worker stopped after the $MaxTurns-turn limit without finishing; reporting the incomplete state as a blocker."
    $script:Messages += [ordered]@{ role = 'user'; content = "You reached the $MaxTurns-turn limit before finishing. Report what you completed, and record the unfinished work in 'blockers'." }
}

Compress-FinalContext -Turn $turnsUsed

# Final turn carries no tools and forces the orchestrator's schema, so the structured
# result cannot be confused with another tool call. Reasoning is disabled here because
# this turn only reformats work already done: on a thinking model it otherwise spends
# most of its budget on hidden tokens and can return an empty content field.
$script:Messages += [ordered]@{ role = 'user'; content = 'Now report what you did as a JSON object matching the required schema.' }
$finalContent = ''
$finalAttempts = 3
for ($attempt = 1; $attempt -le $finalAttempts; $attempt++) {
    $final = Invoke-OllamaChat -Messages $script:Messages -Tools $null -Format $schema -Think $false
    $finalContent = [string]$final.message.content
    if (-not [string]::IsNullOrWhiteSpace($finalContent)) { break }
    # Observed on qwen3.8: an occasional empty content field after a tool loop. The work
    # is already on disk at this point, so retrying the report is far better than failing
    # a completed step; a persistent empty result still fails closed below.
    Write-Warning "Structured result attempt $attempt of $finalAttempts came back empty; retrying."
}
if ([string]::IsNullOrWhiteSpace($finalContent)) {
    throw "Worker produced an empty structured result after $finalAttempts attempts."
}

[IO.File]::WriteAllText($OutputFile, $finalContent, [Text.UTF8Encoding]::new($false))
Write-Host "final: prompt_tokens=$(Get-OptionalProperty $final 'prompt_eval_count') turns=$turnsUsed num_ctx=$ContextTokens compactions=$script:CompactionCount"
exit 0
