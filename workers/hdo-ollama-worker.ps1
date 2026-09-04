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

$script:ReadTools = @(
    @{ type = 'function'; function = [ordered]@{
        name = 'read_file'
        description = 'Read a UTF-8 text file from the workspace. Long files are truncated; use start_line to read the rest.'
        parameters = [ordered]@{ type = 'object'; additionalProperties = $false
            properties = [ordered]@{
                path = [ordered]@{ type = 'string'; description = 'Workspace-relative file path.' }
                start_line = [ordered]@{ type = 'integer'; description = 'Optional 1-based line to start reading from.' } }
            required = @('path') } } },
    @{ type = 'function'; function = [ordered]@{
        name = 'list_files'
        description = 'List workspace files matching a wildcard pattern such as *.ps1.'
        parameters = [ordered]@{ type = 'object'; additionalProperties = $false
            properties = [ordered]@{ pattern = [ordered]@{ type = 'string'; description = 'Wildcard file name pattern.' } }
            required = @('pattern') } } },
    @{ type = 'function'; function = [ordered]@{
        name = 'search_files'
        description = 'Search workspace file contents with a regular expression and return matching lines.'
        parameters = [ordered]@{ type = 'object'; additionalProperties = $false
            properties = [ordered]@{
                pattern = [ordered]@{ type = 'string'; description = 'Regular expression to search for.' }
                include = [ordered]@{ type = 'string'; description = 'Optional wildcard file name filter.' } }
            required = @('pattern') } } }
)

$script:WriteTools = @(
    @{ type = 'function'; function = [ordered]@{
        name = 'write_file'
        description = 'Create or overwrite a UTF-8 text file in the workspace.'
        parameters = [ordered]@{ type = 'object'; additionalProperties = $false
            properties = [ordered]@{
                path = [ordered]@{ type = 'string'; description = 'Workspace-relative file path.' }
                content = [ordered]@{ type = 'string'; description = 'Full new file content.' } }
            required = @('path', 'content') } } },
    @{ type = 'function'; function = [ordered]@{
        name = 'edit_file'
        description = 'Replace one exact, unique block of text in an existing workspace file.'
        parameters = [ordered]@{ type = 'object'; additionalProperties = $false
            properties = [ordered]@{
                path = [ordered]@{ type = 'string'; description = 'Workspace-relative file path.' }
                old_text = [ordered]@{ type = 'string'; description = 'Exact text to replace. Must occur exactly once.' }
                new_text = [ordered]@{ type = 'string'; description = 'Replacement text.' } }
            required = @('path', 'old_text', 'new_text') } } }
)

$script:Tools = if ($ReadOnly) { $script:ReadTools } else { $script:ReadTools + $script:WriteTools }

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
            $lines = [IO.File]::ReadAllLines($target)
            $startLine = 1
            $requestedStart = Get-Argument 'start_line' -Optional
            if ($requestedStart) { $startLine = [Math]::Max(1, [int]$requestedStart) }
            if ($startLine -gt $lines.Count) { return "start_line $startLine is past the end of $relative ($($lines.Count) lines)" }
            $body = ($lines[($startLine - 1)..($lines.Count - 1)] -join "`n")
            if ($body.Length -le $MaxToolResultChars) {
                if ($startLine -eq 1) { return $body }
                return "[$relative from line $startLine of $($lines.Count)]`n$body"
            }
            # Report the line the model should resume from, so the tail of a long file
            # stays reachable instead of being permanently cut off by the size bound.
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
            $hits = @($files | Select-String -Pattern (Get-Argument 'pattern') -ErrorAction SilentlyContinue |
                ForEach-Object { "$($_.Path.Substring($script:Workspace.Length + 1)):$($_.LineNumber): $($_.Line.Trim())" })
            if ($hits.Count -eq 0) { return 'no matches' }
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

$messages = @(
    [ordered]@{ role = 'system'; content = @"
You are a local coding worker operating inside a repository workspace.
$capabilities
Never guess a file's contents: read it first.
Do not attempt to run shell commands, git, builds, or tests. The orchestrator runs
trusted validation gates after you finish.
Make only the change the task asks for, then stop calling tools.
"@ },
    [ordered]@{ role = 'user'; content = (Get-Content -LiteralPath $PromptFile -Raw) }
)

$turnsUsed = 0
$exhausted = $true
for ($turn = 1; $turn -le $MaxTurns; $turn++) {
    $turnsUsed = $turn
    $response = Invoke-OllamaChat -Messages $messages -Tools $script:Tools
    $assistant = [ordered]@{ role = 'assistant'; content = [string]$response.message.content }
    $toolCalls = @()
    if ($response.message.PSObject.Properties.Name -contains 'tool_calls' -and $response.message.tool_calls) {
        $toolCalls = @($response.message.tool_calls)
        $assistant['tool_calls'] = @($toolCalls | ForEach-Object { ConvertTo-RequestToolCall $_ })
    }
    $messages += $assistant
    Write-Host "turn ${turn}: prompt_tokens=$(Get-OptionalProperty $response 'prompt_eval_count') tool_calls=$($toolCalls.Count)"
    if ($toolCalls.Count -eq 0) { $exhausted = $false; break }

    foreach ($call in $toolCalls) {
        $toolName = [string]$call.function.name
        $arguments = ConvertTo-ArgumentTable $call.function.arguments
        try {
            $result = Invoke-WorkerTool -Name $toolName -Arguments $arguments
        }
        catch {
            # Returned to the model rather than thrown: a wrong path or a non-unique
            # edit is something it can correct on the next turn. MaxTurns bounds the
            # retries. Mirrored to stderr so HDO's artifacts record the attempt.
            $result = "ERROR: $($_.Exception.Message)"
            Write-Warning "tool '$toolName' failed: $($_.Exception.Message)"
        }
        $messages += [ordered]@{ role = 'tool'; tool_name = $toolName; content = [string]$result }
    }
}

if ($exhausted) {
    Write-Warning "Worker stopped after the $MaxTurns-turn limit without finishing; reporting the incomplete state as a blocker."
    $messages += [ordered]@{ role = 'user'; content = "You reached the $MaxTurns-turn limit before finishing. Report what you completed, and record the unfinished work in 'blockers'." }
}

# Final turn carries no tools and forces the orchestrator's schema, so the structured
# result cannot be confused with another tool call. Reasoning is disabled here because
# this turn only reformats work already done: on a thinking model it otherwise spends
# most of its budget on hidden tokens and can return an empty content field.
$messages += [ordered]@{ role = 'user'; content = 'Now report what you did as a JSON object matching the required schema.' }
$finalContent = ''
$finalAttempts = 3
for ($attempt = 1; $attempt -le $finalAttempts; $attempt++) {
    $final = Invoke-OllamaChat -Messages $messages -Tools $null -Format $schema -Think $false
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
Write-Host "final: prompt_tokens=$(Get-OptionalProperty $final 'prompt_eval_count') turns=$turnsUsed num_ctx=$ContextTokens"
exit 0
