#Requires -Version 7.0
<#
.SYNOPSIS
    workers/hdo-ollama-worker.ps1 の deterministic test。実 Ollama を必要としない。

.DESCRIPTION
    scripted response を返す stub HTTP server を立てて worker を実運用と同じ形で起動し、
    tool loop、workspace 外への path 拒否、read-only の tool 境界、tool result の
    上限、空応答時の retry、structured output の書き出しを検査する。

    HttpListener ではなく TcpListener を使うのは、HttpListener が Windows で URL
    reservation を要求し得るため。CI で追加の権限を必要としない。
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workerPath = Join-Path $repositoryRoot 'workers/hdo-ollama-worker.ps1'
$schemaPath = Join-Path $repositoryRoot 'schemas/worker-result.schema.json'
$failures = 0

function Assert-Worker {
    param([bool]$Condition, [string]$Message)
    if ($Condition) { Write-Host "PASS: $Message" }
    else { Write-Host "FAIL: $Message"; $script:failures++ }
}

# The stub runs in a background job because the worker blocks on its HTTP calls. It
# replays $Responses in order and records every request body for later assertions.
$stubScript = {
    param([int]$Port, [string]$ResponsesJson, [string]$RequestLogPath)

    $responses = $ResponsesJson | ConvertFrom-Json -AsHashtable
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    $index = 0
    try {
        while ($index -lt $responses.Count) {
            $client = $listener.AcceptTcpClient()
            $stream = $client.GetStream()
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)

            $contentLength = 0
            while ($true) {
                $line = $reader.ReadLine()
                if ($null -eq $line -or $line -eq '') { break }
                if ($line -match '^(?i)Content-Length:\s*(\d+)') { $contentLength = [int]$Matches[1] }
            }
            $bodyChars = [char[]]::new($contentLength)
            $read = 0
            while ($read -lt $contentLength) {
                $count = $reader.Read($bodyChars, $read, $contentLength - $read)
                if ($count -le 0) { break }
                $read += $count
            }
            Add-Content -LiteralPath $RequestLogPath -Value ([string]::new($bodyChars, 0, $read)) -Encoding utf8NoBOM

            $payload = $responses[$index] | ConvertTo-Json -Depth 30 -Compress
            $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
            $header = "HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
            $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
            $client.Close()
            $index++
        }
    }
    finally { $listener.Stop() }
}

function New-AssistantResponse {
    # PromptTokens is what the worker's compaction threshold reads, so a test drives
    # compaction by scripting the counter rather than by producing a genuinely huge
    # conversation.
    param([string]$Content = '', [array]$ToolCalls, [switch]$OmitTokenCounts, [int]$PromptTokens = 100)

    $message = [ordered]@{ role = 'assistant'; content = $Content }
    if ($ToolCalls) { $message['tool_calls'] = $ToolCalls }
    $response = [ordered]@{ message = $message; done_reason = 'stop' }
    # Ollama marks the counters omitempty, so a fully cached prompt really does come back
    # without prompt_eval_count.
    if (-not $OmitTokenCounts) { $response['prompt_eval_count'] = $PromptTokens }
    return $response
}

function New-ToolCall {
    param([string]$Name, [hashtable]$Arguments)
    return [ordered]@{ function = [ordered]@{ name = $Name; arguments = $Arguments } }
}

function Get-FreePort {
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $port = $probe.LocalEndpoint.Port
    $probe.Stop()
    return $port
}

function Invoke-WorkerAgainstStub {
    <#
    .SYNOPSIS
        Runs the worker against scripted responses and returns its output and requests.
    #>
    param(
        [Parameter(Mandatory)][array]$Responses,
        [Parameter(Mandatory)][string]$Workspace,
        [string]$Prompt = 'do the thing',
        [switch]$ReadOnly,
        [int]$MaxToolResultChars = 20000,
        [int]$MaxTurns = 40,
        [int]$ContextTokens = 32768,
        [int]$CompactAtPercent = 65,
        [int]$KeepRecentMessages = 6
    )

    $port = Get-FreePort
    $requestLog = Join-Path $Workspace '..\requests.log'
    Set-Content -LiteralPath $requestLog -Value '' -Encoding utf8NoBOM
    $promptFile = Join-Path $Workspace '..\prompt.md'
    $outputFile = Join-Path $Workspace '..\final.json'
    Set-Content -LiteralPath $promptFile -Value $Prompt -Encoding utf8NoBOM
    Remove-Item -LiteralPath $outputFile -Force -ErrorAction SilentlyContinue

    $job = Start-Job -ScriptBlock $stubScript -ArgumentList $port, ($Responses | ConvertTo-Json -Depth 30), $requestLog
    try {
        $arguments = @(
            '-NoProfile', '-File', $workerPath,
            '-PromptFile', $promptFile, '-OutputFile', $outputFile, '-SchemaFile', $schemaPath,
            '-WorkingDirectory', $Workspace, '-Model', 'stub-model', '-ContextTokens', "$ContextTokens",
            '-MaxToolResultChars', "$MaxToolResultChars", '-MaxTurns', "$MaxTurns",
            '-CompactAtPercent', "$CompactAtPercent", '-KeepRecentMessages', "$KeepRecentMessages",
            '-OllamaUri', "http://127.0.0.1:$port/api/chat"
        )
        if ($ReadOnly) { $arguments += '-ReadOnly' }
        $stdout = & pwsh @arguments 2>&1 | Out-String
        return [ordered]@{
            exitCode = $LASTEXITCODE
            stdout = $stdout
            output = if (Test-Path -LiteralPath $outputFile) { Get-Content -LiteralPath $outputFile -Raw } else { '' }
            requests = @(Get-Content -LiteralPath $requestLog | Where-Object { $_.Trim() })
        }
    }
    finally { Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "hdo-lean-worker-$([guid]::NewGuid().ToString('N'))"
$structuredResult = '{"schemaVersion":1,"summary":"done","changedFiles":["a.txt"],"tests":[],"notes":[],"blockers":[]}'

try {
    # --- tool loop, editing, and structured output -------------------------------------
    $workspace = Join-Path $testRoot 'edit/ws'
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $workspace 'a.txt') -Value 'original text' -Encoding utf8NoBOM
    $run = Invoke-WorkerAgainstStub -Workspace $workspace -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'a.txt' }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'edit_file' @{ path = 'a.txt'; old_text = 'original'; new_text = 'replaced' }))),
        (New-AssistantResponse -Content 'finished'),
        (New-AssistantResponse -Content $structuredResult)
    )
    Assert-Worker ($run.exitCode -eq 0) 'the worker exits zero after a successful tool loop'
    Assert-Worker ((Get-Content -LiteralPath (Join-Path $workspace 'a.txt') -Raw).Trim() -eq 'replaced text') 'edit_file applies a unique replacement'
    Assert-Worker ($run.output.Trim() -eq $structuredResult) 'the structured result is written to the output file'
    $firstRequest = $run.requests[0] | ConvertFrom-Json -AsHashtable
    Assert-Worker ([int]$firstRequest.options.num_ctx -eq 32768) 'contextTokens is sent as options.num_ctx, needing no derived model'
    $toolNames = @($firstRequest.tools | ForEach-Object { $_.function.name })
    Assert-Worker (($toolNames -contains 'write_file') -and ($toolNames -contains 'edit_file')) 'a writable runner exposes the file-editing tools'
    Assert-Worker (-not ($toolNames -contains 'run_command')) 'no shell or command-execution tool is ever exposed'
    $finalRequest = $run.requests[-1] | ConvertFrom-Json -AsHashtable
    Assert-Worker (-not $finalRequest.ContainsKey('tools')) 'the schema-forced final turn carries no tools'
    Assert-Worker ($finalRequest.ContainsKey('format') -and $finalRequest.think -eq $false) 'the final turn forces the schema and disables reasoning'

    # --- workspace containment ---------------------------------------------------------
    $escapeWorkspace = Join-Path $testRoot 'escape/ws'
    New-Item -ItemType Directory -Path $escapeWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $testRoot 'escape/secret.txt') -Value 'SECRET' -Encoding utf8NoBOM
    $escape = Invoke-WorkerAgainstStub -Workspace $escapeWorkspace -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = '../secret.txt' }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'write_file' @{ path = '../escaped.txt'; content = 'x' }))),
        (New-AssistantResponse -Content 'stopped'),
        (New-AssistantResponse -Content $structuredResult)
    )
    $escapeToolResults = @($escape.requests[-1] | ConvertFrom-Json -AsHashtable | ForEach-Object { $_.messages } |
        Where-Object { $_.role -eq 'tool' } | ForEach-Object { [string]$_.content })
    Assert-Worker (@($escapeToolResults | Where-Object { $_ -match 'escapes the workspace' }).Count -eq 2) 'relative paths that climb out of the workspace are refused'
    Assert-Worker ($escapeToolResults -notcontains 'SECRET') 'a refused read returns no file content'
    Assert-Worker (-not (Test-Path -LiteralPath (Join-Path $testRoot 'escape/escaped.txt'))) 'a refused write creates nothing outside the workspace'

    $absolute = Invoke-WorkerAgainstStub -Workspace $escapeWorkspace -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = (Join-Path $testRoot 'escape/secret.txt') }))),
        (New-AssistantResponse -Content 'stopped'),
        (New-AssistantResponse -Content $structuredResult)
    )
    $absoluteResults = @($absolute.requests[-1] | ConvertFrom-Json -AsHashtable | ForEach-Object { $_.messages } |
        Where-Object { $_.role -eq 'tool' } | ForEach-Object { [string]$_.content })
    Assert-Worker (@($absoluteResults | Where-Object { $_ -match 'must be workspace-relative' }).Count -eq 1) 'absolute paths are refused outright'

    # --- read-only boundary ------------------------------------------------------------
    $readOnlyWorkspace = Join-Path $testRoot 'readonly/ws'
    New-Item -ItemType Directory -Path $readOnlyWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $readOnlyWorkspace 'a.txt') -Value 'keep me' -Encoding utf8NoBOM
    $readOnly = Invoke-WorkerAgainstStub -Workspace $readOnlyWorkspace -ReadOnly -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'write_file' @{ path = 'a.txt'; content = 'overwritten' }))),
        (New-AssistantResponse -Content 'stopped'),
        (New-AssistantResponse -Content $structuredResult)
    )
    $readOnlyToolNames = @(($readOnly.requests[0] | ConvertFrom-Json -AsHashtable).tools | ForEach-Object { $_.function.name })
    Assert-Worker (-not ($readOnlyToolNames -contains 'write_file') -and -not ($readOnlyToolNames -contains 'edit_file')) 'a read-only runner does not expose the file-editing tools at all'
    Assert-Worker ((Get-Content -LiteralPath (Join-Path $readOnlyWorkspace 'a.txt') -Raw).Trim() -eq 'keep me') 'a read-only runner cannot be talked into writing'
    $readOnlyToolResults = @(($readOnly.requests[-1] | ConvertFrom-Json -AsHashtable).messages |
        Where-Object { $_.role -eq 'tool' } | ForEach-Object { [string]$_.content })
    Assert-Worker (@($readOnlyToolResults | Where-Object { $_ -match 'not available to a read-only runner' }).Count -eq 1) 'calling an unadvertised editing tool is refused at dispatch, not merely unlisted'

    # --- tool result bounding ----------------------------------------------------------
    $boundedWorkspace = Join-Path $testRoot 'bounded/ws'
    New-Item -ItemType Directory -Path $boundedWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $boundedWorkspace 'big.txt') -Value ('x' * 50000) -Encoding utf8NoBOM
    $bounded = Invoke-WorkerAgainstStub -Workspace $boundedWorkspace -MaxToolResultChars 1000 -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'big.txt' }))),
        (New-AssistantResponse -Content 'stopped'),
        (New-AssistantResponse -Content $structuredResult)
    )
    $boundedResult = @(($bounded.requests[-1] | ConvertFrom-Json -AsHashtable).messages |
        Where-Object { $_.role -eq 'tool' } | ForEach-Object { [string]$_.content })[0]
    Assert-Worker ($boundedResult.Length -lt 1200) 'an oversized file read is truncated instead of flooding the context'
    Assert-Worker ($boundedResult -match 'truncated after 1000 characters') 'the truncation is visible to the model rather than silent'

    # --- empty structured result retries, then fails closed ----------------------------
    $retryWorkspace = Join-Path $testRoot 'retry/ws'
    New-Item -ItemType Directory -Path $retryWorkspace -Force | Out-Null
    $retry = Invoke-WorkerAgainstStub -Workspace $retryWorkspace -Responses @(
        (New-AssistantResponse -Content 'nothing to do'),
        (New-AssistantResponse -Content ''),
        (New-AssistantResponse -Content $structuredResult)
    )
    Assert-Worker ($retry.exitCode -eq 0 -and $retry.output.Trim() -eq $structuredResult) 'an empty structured result is retried rather than failing a completed step'

    $failWorkspace = Join-Path $testRoot 'fail/ws'
    New-Item -ItemType Directory -Path $failWorkspace -Force | Out-Null
    $failed = Invoke-WorkerAgainstStub -Workspace $failWorkspace -Responses @(
        (New-AssistantResponse -Content 'nothing to do'),
        (New-AssistantResponse -Content ''),
        (New-AssistantResponse -Content ''),
        (New-AssistantResponse -Content '')
    )
    Assert-Worker ($failed.exitCode -ne 0) 'a persistently empty structured result fails closed'

    # --- omitted response counters -----------------------------------------------------
    $omitWorkspace = Join-Path $testRoot 'omit/ws'
    New-Item -ItemType Directory -Path $omitWorkspace -Force | Out-Null
    $omitted = Invoke-WorkerAgainstStub -Workspace $omitWorkspace -Responses @(
        (New-AssistantResponse -Content 'nothing to do' -OmitTokenCounts),
        (New-AssistantResponse -Content $structuredResult -OmitTokenCounts)
    )
    Assert-Worker ($omitted.exitCode -eq 0) 'a response without token counters does not abort a step whose work is already done'
    Assert-Worker ($omitted.output.Trim() -eq $structuredResult) 'the structured result still reaches the output file when counters are omitted'

    # --- git metadata ------------------------------------------------------------------
    $gitWorkspace = Join-Path $testRoot 'gitmeta/ws'
    New-Item -ItemType Directory -Path (Join-Path $gitWorkspace '.git') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $gitWorkspace '.git/config') -Value '[core]' -Encoding utf8NoBOM
    $gitMeta = Invoke-WorkerAgainstStub -Workspace $gitWorkspace -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'write_file' @{ path = '.git/hooks/pre-commit'; content = 'evil' }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = '.git/config' }))),
        (New-AssistantResponse -Content 'stopped'),
        (New-AssistantResponse -Content $structuredResult)
    )
    $gitResults = @(($gitMeta.requests[-1] | ConvertFrom-Json -AsHashtable).messages |
        Where-Object { $_.role -eq 'tool' } | ForEach-Object { [string]$_.content })
    Assert-Worker (@($gitResults | Where-Object { $_ -match 'git metadata' }).Count -eq 2) 'git metadata is refused even though it sits inside the workspace'
    Assert-Worker (-not (Test-Path -LiteralPath (Join-Path $gitWorkspace '.git/hooks/pre-commit'))) 'a worker cannot plant a git hook that HDO would later execute'

    # --- link traversal ----------------------------------------------------------------
    $linkWorkspace = Join-Path $testRoot 'link/ws'
    New-Item -ItemType Directory -Path $linkWorkspace -Force | Out-Null
    $outsideDirectory = Join-Path $testRoot 'link/outside'
    New-Item -ItemType Directory -Path $outsideDirectory -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $outsideDirectory 'secret.txt') -Value 'LINKED_SECRET' -Encoding utf8NoBOM
    $junctionMade = $true
    try { New-Item -ItemType Junction -Path (Join-Path $linkWorkspace 'escape') -Target $outsideDirectory -ErrorAction Stop | Out-Null }
    catch { $junctionMade = $false }
    if ($junctionMade) {
        $linked = Invoke-WorkerAgainstStub -Workspace $linkWorkspace -Responses @(
            (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'escape/secret.txt' }))),
            (New-AssistantResponse -Content 'stopped'),
            (New-AssistantResponse -Content $structuredResult)
        )
        $linkedResults = @(($linked.requests[-1] | ConvertFrom-Json -AsHashtable).messages |
            Where-Object { $_.role -eq 'tool' } | ForEach-Object { [string]$_.content })
        Assert-Worker ($linkedResults -notcontains 'LINKED_SECRET') 'a link planted inside the workspace cannot be used to read outside it'
        Assert-Worker (@($linkedResults | Where-Object { $_ -match 'leaves the workspace' }).Count -eq 1) 'link traversal is refused with a clear reason'
    }
    else { Write-Host 'SKIP: junction creation unavailable on this host' }

    # --- long file remains reachable ---------------------------------------------------
    $longWorkspace = Join-Path $testRoot 'long/ws'
    New-Item -ItemType Directory -Path $longWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $longWorkspace 'long.txt') -Value (1..400 | ForEach-Object { "line $_ padding padding padding" }) -Encoding utf8NoBOM
    $long = Invoke-WorkerAgainstStub -Workspace $longWorkspace -MaxToolResultChars 1000 -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'long.txt' }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'long.txt'; start_line = 300 }))),
        (New-AssistantResponse -Content 'stopped'),
        (New-AssistantResponse -Content $structuredResult)
    )
    $longResults = @(($long.requests[-1] | ConvertFrom-Json -AsHashtable).messages |
        Where-Object { $_.role -eq 'tool' } | ForEach-Object { [string]$_.content })
    Assert-Worker ($longResults[0] -match 'start_line=\d+ to continue') 'a truncated read tells the model which line to resume from'
    Assert-Worker ($longResults[1] -match 'line 300') 'the tail of a long file stays reachable through start_line'

    # --- CRLF-tolerant editing ---------------------------------------------------------
    $crlfWorkspace = Join-Path $testRoot 'crlf/ws'
    New-Item -ItemType Directory -Path $crlfWorkspace -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $crlfWorkspace 'crlf.txt'), "alpha`r`nbeta`r`ngamma`r`n")
    $crlf = Invoke-WorkerAgainstStub -Workspace $crlfWorkspace -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'edit_file' @{ path = 'crlf.txt'; old_text = "alpha`nbeta"; new_text = "alpha`ndelta" }))),
        (New-AssistantResponse -Content 'stopped'),
        (New-AssistantResponse -Content $structuredResult)
    )
    $crlfContent = [IO.File]::ReadAllText((Join-Path $crlfWorkspace 'crlf.txt'))
    Assert-Worker ($crlfContent.Contains("delta")) 'a multi-line edit expressed with LF still applies to a CRLF file'
    Assert-Worker ($crlfContent.Contains("alpha`r`ndelta")) 'the file keeps its original CRLF convention after the edit'

    # --- upstream error detail ---------------------------------------------------------
    $errorWorkspace = Join-Path $testRoot 'error/ws'
    New-Item -ItemType Directory -Path $errorWorkspace -Force | Out-Null
    $errorPort = Get-FreePort
    $errorJob = Start-Job -ScriptBlock {
        param([int]$Port)
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        $client = $listener.AcceptTcpClient()
        $stream = $client.GetStream()
        # The request body has to be drained before responding: replying to a half-sent
        # request makes Windows reset the connection, and the client then never sees the
        # error body.
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
        $contentLength = 0
        while ($true) {
            $line = $reader.ReadLine()
            if ($null -eq $line -or $line -eq '') { break }
            if ($line -match '^(?i)Content-Length:\s*(\d+)') { $contentLength = [int]$Matches[1] }
        }
        $bodyChars = [char[]]::new($contentLength)
        $read = 0
        while ($read -lt $contentLength) {
            $count = $reader.Read($bodyChars, $read, $contentLength - $read)
            if ($count -le 0) { break }
            $read += $count
        }
        $payload = '{"error":"unloadable-stub-model"}'
        $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
        $header = "HTTP/1.1 400 Bad Request`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
        $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
        $stream.Write($headerBytes, 0, $headerBytes.Length)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        # Half-close so the client sees a clean end of body. Closing outright resets the
        # connection, and PowerShell then reports a transport IOException in ErrorDetails
        # instead of the error body this case exists to check.
        $client.Client.Shutdown([Net.Sockets.SocketShutdown]::Send)
        Start-Sleep -Milliseconds 300
        $client.Close()
        $listener.Stop()
    } -ArgumentList $errorPort
    try {
        Set-Content -LiteralPath (Join-Path $testRoot 'error/prompt.md') -Value 'x' -Encoding utf8NoBOM
        $errorOutput = & pwsh -NoProfile -File $workerPath -PromptFile (Join-Path $testRoot 'error/prompt.md') `
            -OutputFile (Join-Path $testRoot 'error/final.json') -SchemaFile $schemaPath `
            -WorkingDirectory $errorWorkspace -Model 'stub-model' `
            -OllamaUri "http://127.0.0.1:$errorPort/api/chat" 2>&1 | Out-String
        Assert-Worker ($LASTEXITCODE -ne 0) 'an upstream error fails the worker'
        Assert-Worker ($errorOutput -match 'unloadable-stub-model') 'the upstream error body is surfaced, not just the HTTP status'
    }
    finally { Stop-Job $errorJob -ErrorAction SilentlyContinue; Remove-Job $errorJob -Force -ErrorAction SilentlyContinue }

    # --- turn limit --------------------------------------------------------------------
    $turnWorkspace = Join-Path $testRoot 'turns/ws'
    New-Item -ItemType Directory -Path $turnWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $turnWorkspace 'a.txt') -Value 'text' -Encoding utf8NoBOM
    $turnLimited = Invoke-WorkerAgainstStub -Workspace $turnWorkspace -MaxTurns 2 -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'a.txt' }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'a.txt' }))),
        (New-AssistantResponse -Content $structuredResult)
    )
    Assert-Worker ($turnLimited.exitCode -eq 0) 'hitting the turn limit still produces a reportable result'
    $turnMessages = @(($turnLimited.requests[-1] | ConvertFrom-Json -AsHashtable).messages | ForEach-Object { [string]$_.content })
    Assert-Worker (@($turnMessages | Where-Object { $_ -match 'turn limit' }).Count -ge 1) 'the turn limit is reported back for the blockers field'

    # --- context discipline in the system prompt ---------------------------------------
    $promptWorkspace = Join-Path $testRoot 'prompt/ws'
    New-Item -ItemType Directory -Path $promptWorkspace -Force | Out-Null
    $promptRun = Invoke-WorkerAgainstStub -Workspace $promptWorkspace -Responses @(
        (New-AssistantResponse -Content 'nothing to do'),
        (New-AssistantResponse -Content $structuredResult)
    )
    $writableSystemPrompt = [string](($promptRun.requests[0] | ConvertFrom-Json -AsHashtable).messages[0].content)
    Assert-Worker ($writableSystemPrompt -match 'use edit_file') 'the system prompt tells a writable runner to prefer edit_file over resending a whole file'
    Assert-Worker ($writableSystemPrompt -match 'max_lines') 'the system prompt points at the narrow-read arguments'
    $readOnlyPromptRun = Invoke-WorkerAgainstStub -Workspace $promptWorkspace -ReadOnly -Responses @(
        (New-AssistantResponse -Content 'nothing to do'),
        (New-AssistantResponse -Content $structuredResult)
    )
    $readOnlySystemPrompt = [string](($readOnlyPromptRun.requests[0] | ConvertFrom-Json -AsHashtable).messages[0].content)
    Assert-Worker ($readOnlySystemPrompt -notmatch 'edit_file') 'a read-only runner is not told about editing tools it does not have'

    # --- bounded reads and searches ----------------------------------------------------
    $windowWorkspace = Join-Path $testRoot 'window/ws'
    New-Item -ItemType Directory -Path $windowWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $windowWorkspace 'long.txt') -Encoding utf8NoBOM `
        -Value (1..400 | ForEach-Object { "line $_" })
    Set-Content -LiteralPath (Join-Path $windowWorkspace 'many.txt') -Encoding utf8NoBOM `
        -Value (1..150 | ForEach-Object { "needle $_" })
    $windowed = Invoke-WorkerAgainstStub -Workspace $windowWorkspace -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'long.txt'; start_line = 10; max_lines = 5 }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'search_files' @{ pattern = 'needle'; include = 'many.txt'; max_results = 3 }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'search_files' @{ pattern = 'needle'; include = 'many.txt' }))),
        (New-AssistantResponse -Content 'stopped'),
        (New-AssistantResponse -Content $structuredResult)
    )
    $windowResults = @(($windowed.requests[-1] | ConvertFrom-Json -AsHashtable).messages |
        Where-Object { $_.role -eq 'tool' } | ForEach-Object { [string]$_.content })
    Assert-Worker ($windowResults[0] -match '\[long\.txt lines 10-14 of 400\]') 'read_file honours max_lines and labels the window it returned'
    Assert-Worker ($windowResults[0] -match 'line 14' -and $windowResults[0] -notmatch 'line 15') 'max_lines stops exactly where it was told to'
    Assert-Worker ($windowResults[0] -match 'start_line=15 to continue') 'a windowed read says where to resume'
    Assert-Worker ($windowResults[1] -match 'showing 3 of 150 matches') 'search_files honours max_results'
    Assert-Worker ($windowResults[2] -match 'showing 100 of 150 matches') 'search_files caps an unbounded search by default'

    # --- token-aware compaction --------------------------------------------------------
    # 32768 * 65% is 21299, so the second turn's scripted counter puts the next request over
    # the threshold. KeepRecentMessages is 2 here purely to leave something droppable in a
    # conversation this short.
    $summaryJson = '{"goal":"replace the text in a.txt","constraints":["touch no other file"],' +
        '"filesInspected":["a.txt"],"filesChanged":["a.txt"],"decisions":["edited in place instead of rewriting"],' +
        '"failedAttempts":[],"currentState":"the edit is applied","remainingWork":["report the result"]}'
    $compactWorkspace = Join-Path $testRoot 'compact/ws'
    New-Item -ItemType Directory -Path $compactWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $compactWorkspace 'a.txt') -Value 'original text' -Encoding utf8NoBOM
    $readCall = New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'a.txt' }))
    $editCall = New-AssistantResponse -PromptTokens 25000 -ToolCalls @((New-ToolCall 'edit_file' @{ path = 'a.txt'; old_text = 'original'; new_text = 'replaced' }))
    $summaryReply = New-AssistantResponse -Content $summaryJson
    $finishedReply = New-AssistantResponse -Content 'finished'
    $structuredReply = New-AssistantResponse -Content $structuredResult
    # Two summarization replies: one for the in-loop compaction, one for the reduction
    # before the final report, which re-summarizes the turns the first one did not cover.
    $compacted = Invoke-WorkerAgainstStub -Workspace $compactWorkspace -KeepRecentMessages 2 `
        -Prompt 'replace original with replaced in a.txt' `
        -Responses @($readCall, $editCall, $summaryReply, $finishedReply, $summaryReply, $structuredReply)
    Assert-Worker ($compacted.exitCode -eq 0) 'a run that compacts its history still completes'
    Assert-Worker ($compacted.stdout -match 'compaction: turn=2 reason=threshold') 'compaction is triggered by the reported prompt token count'
    Assert-Worker ($compacted.stdout -match 'prompt_tokens_before~\d+ prompt_tokens_after~\d+ messages=\d+->\d+') 'the diagnostic reports the turn and the token count on both sides'

    $summaryRequest = $compacted.requests[2] | ConvertFrom-Json -AsHashtable
    Assert-Worker (-not $summaryRequest.ContainsKey('tools')) 'the summarization call carries no tools'
    Assert-Worker ($summaryRequest.format.required -contains 'currentState' -and $summaryRequest.format.required -contains 'failedAttempts') 'the summarization call forces the structured working-summary schema'
    Assert-Worker ($summaryRequest.messages.Count -eq 2) 'the summarization call is its own conversation, not a replay of the session'

    $afterCompaction = @(($compacted.requests[3] | ConvertFrom-Json -AsHashtable).messages)
    Assert-Worker ($afterCompaction.Count -lt 6) 'the rebuilt history is shorter than the conversation it replaced'
    Assert-Worker ([string]$afterCompaction[1].content -match 'replace original with replaced in a\.txt') 'the original task survives compaction verbatim'
    $block = [string]$afterCompaction[2].content
    Assert-Worker ($block -match 'HDO CONTEXT COMPACTION \(after turn 2\)') 'the dropped turns are replaced by a labelled compaction block'
    Assert-Worker ($block -match 'Verified by the orchestrator' -and $block -match 'model-generated') 'observed facts and the model summary are labelled apart'
    Assert-Worker ($block -match 'Files read: a\.txt') 'the compaction block keeps the worker-observed list of files read'
    Assert-Worker ($block -match 'Files changed: a\.txt \(1 edit\(s\)\)') 'the compaction block keeps the worker-observed record of what changed'
    Assert-Worker ($block -match 'Tool errors: \(none\)' -and $block -match 'Recent actions') 'the compaction block keeps tool errors and recent actions'
    Assert-Worker ($block -match 'Goal: replace the text in a\.txt' -and $block -match 'Current state: the edit is applied') 'the model working summary is folded into the block'
    Assert-Worker ($block -match 'Remaining work' -and $block -match 'Failed attempts') 'the working summary carries the remaining work and failed attempts'
    $retained = @($afterCompaction | Where-Object { $_.role -eq 'tool' } | ForEach-Object { [string]$_.content })
    Assert-Worker ($retained -contains 'edited a.txt') 'the most recent tool interaction is retained after compaction'
    Assert-Worker ([string]$afterCompaction[3].role -eq 'assistant') 'the retained tail starts at the assistant turn that owns the tool result'

    # --- one oversized exchange is still compactable -----------------------------------
    # A single assistant turn answering with eight parallel tool calls puts the retained
    # window inside the first exchange, so walking the boundary back reaches the protected
    # prefix. The whole exchange has to be dropped instead: declining would leave the
    # over-window request to go out unchanged.
    $parallelWorkspace = Join-Path $testRoot 'parallel/ws'
    New-Item -ItemType Directory -Path $parallelWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $parallelWorkspace 'a.txt') -Value 'original text' -Encoding utf8NoBOM
    $parallel = Invoke-WorkerAgainstStub -Workspace $parallelWorkspace -Responses @(
        (New-AssistantResponse -PromptTokens 25000 -ToolCalls @(1..8 | ForEach-Object { New-ToolCall 'read_file' @{ path = 'a.txt' } })),
        (New-AssistantResponse -Content $summaryJson),
        (New-AssistantResponse -Content 'finished'),
        (New-AssistantResponse -Content $structuredResult)
    )
    Assert-Worker ($parallel.exitCode -eq 0) 'an exchange too large for the window on its own still completes'
    Assert-Worker ($parallel.stdout -match 'compaction: turn=1 reason=threshold') 'a single oversized exchange is compacted rather than declined'
    Assert-Worker ($parallel.stdout -notmatch 'skipped') 'compaction is not abandoned when the retained window falls inside one exchange'
    $parallelAfter = @(($parallel.requests[2] | ConvertFrom-Json -AsHashtable).messages)
    Assert-Worker ($parallelAfter.Count -eq 3) 'the oversized exchange is replaced by the compaction block'
    Assert-Worker ([string]$parallelAfter[2].content -match 'Files read: a\.txt') 'what the oversized exchange established is kept as verified state'

    # --- the provider's counter wins over the local estimate ---------------------------
    # One small exchange, a window that easily holds it by the local estimate, and a
    # provider that says the prompt is already at 76% of it. The counter is the authority:
    # declining to compact here would send the over-window request unchanged.
    $trustWorkspace = Join-Path $testRoot 'trust/ws'
    New-Item -ItemType Directory -Path $trustWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $trustWorkspace 'a.txt') -Value 'original text' -Encoding utf8NoBOM
    $trust = Invoke-WorkerAgainstStub -Workspace $trustWorkspace -Responses @(
        (New-AssistantResponse -PromptTokens 25000 -ToolCalls @((New-ToolCall 'read_file' @{ path = 'a.txt' }))),
        (New-AssistantResponse -Content $summaryJson),
        (New-AssistantResponse -Content 'finished'),
        (New-AssistantResponse -Content $structuredResult)
    )
    Assert-Worker ($trust.exitCode -eq 0) 'a compaction driven by the provider counter alone still completes'
    Assert-Worker ($trust.stdout -match 'compaction: turn=1 reason=threshold') 'the reported token count compacts even when the local estimate disagrees'
    Assert-Worker ($trust.stdout -notmatch 'skipped') 'a triggered compaction always reclaims at least the oldest exchange'
    $trustAfter = @(($trust.requests[2] | ConvertFrom-Json -AsHashtable).messages)
    Assert-Worker ($trustAfter.Count -eq 3 -and [string]$trustAfter[2].content -match 'HDO CONTEXT COMPACTION') 'the oldest exchange is what gets reclaimed'

    # --- the final reduction covers the turns since the last compaction ----------------
    $staleWorkspace = Join-Path $testRoot 'stale/ws'
    New-Item -ItemType Directory -Path $staleWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $staleWorkspace 'a.txt') -Value 'original text' -Encoding utf8NoBOM
    Set-Content -LiteralPath (Join-Path $staleWorkspace 'b.txt') -Value 'beta marker content' -Encoding utf8NoBOM
    Set-Content -LiteralPath (Join-Path $staleWorkspace 'c.txt') -Value 'gamma marker content' -Encoding utf8NoBOM
    $stale = Invoke-WorkerAgainstStub -Workspace $staleWorkspace -KeepRecentMessages 4 -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'a.txt' }))),
        (New-AssistantResponse -PromptTokens 25000 -ToolCalls @((New-ToolCall 'read_file' @{ path = 'a.txt' }))),
        (New-AssistantResponse -Content $summaryJson),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'b.txt' }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'c.txt' }))),
        (New-AssistantResponse -Content 'done'),
        (New-AssistantResponse -Content $summaryJson),
        (New-AssistantResponse -Content $structuredResult)
    )
    Assert-Worker ($stale.exitCode -eq 0) 'a run that compacts and then reduces for the final report still completes'
    Assert-Worker ($stale.stdout -match 'reason=threshold' -and $stale.stdout -match 'reason=final') 'both the in-loop compaction and the final reduction run'
    $lastSummaryRequest = $stale.requests[6] | ConvertFrom-Json -AsHashtable
    Assert-Worker ($lastSummaryRequest.format.required -contains 'currentState') 'the final reduction summarizes rather than reusing the earlier summary'
    $lastDigest = [string]$lastSummaryRequest.messages[1].content
    Assert-Worker ($lastDigest -match 'beta marker content') 'the turns taken after the last compaction are the ones summarized'
    Assert-Worker ($lastDigest -match 'carried over from the previous compaction') 'the earlier summary is carried into the new one rather than replaced'
    $staleFinal = @(($stale.requests[-1] | ConvertFrom-Json -AsHashtable).messages)
    Assert-Worker ((@($staleFinal | Where-Object { [string]$_.content -match 'gamma marker content' })).Count -eq 1) 'the newest turn stays in the retained tail rather than being summarized away'
    Assert-Worker ([string]$staleFinal[2].content -match 'HDO WORKING STATE') 'the final report is given the working state that covers the summarized turns'

    # --- an oversized closing turn is still reduced before the final report ------------
    # The model calls no tools on its very first turn, so the loop breaks immediately after
    # appending that assistant message, before the in-loop compaction check further down the
    # loop body ever runs. The message content itself (not just the scripted counter) is
    # genuinely large: nothing bounds a closing turn's content the way MaxToolResultChars
    # bounds a tool result, so a verbose local model can reach this for real.
    #
    # The in-loop attempt this test also exercises still declines ("skipped"): with only
    # this one turn beyond the protected prefix, there is nothing else to drop alongside it,
    # and Invoke-ContextCompaction requires dropping at least two messages before it is
    # willing to spend a summarization call. That is correct given the loop might still
    # continue. Compress-FinalContext runs unconditionally once the loop ends, though, and
    # is where a lone oversized message actually gets caught.
    $closingWorkspace = Join-Path $testRoot 'closing/ws'
    New-Item -ItemType Directory -Path $closingWorkspace -Force | Out-Null
    $closingContent = 'x' * 100000
    $closingTurn = Invoke-WorkerAgainstStub -Workspace $closingWorkspace -Responses @(
        (New-AssistantResponse -Content $closingContent),
        (New-AssistantResponse -Content $summaryJson),
        (New-AssistantResponse -Content $structuredResult)
    )
    Assert-Worker ($closingTurn.exitCode -eq 0) 'a run that closes on an oversized final turn still completes'
    Assert-Worker ($closingTurn.stdout -match 'compaction: turn=1 skipped') 'the loop-break compaction check runs and correctly declines a single-message drop'
    Assert-Worker ($closingTurn.stdout -match 'compaction: turn=1 reason=final') 'the oversized closing turn is still caught by the final reduction'
    $closingFinal = @(($closingTurn.requests[-1] | ConvertFrom-Json -AsHashtable).messages)
    Assert-Worker (-not (($closingFinal | ForEach-Object { [string]$_.content }) -join '' -match [regex]::Escape($closingContent))) 'the oversized closing content does not reach the final schema-forced request unreduced'

    # --- a compaction on the closing turn is not immediately repeated ------------------
    # An ordinary tool call on turn 1, then a turn 2 that calls no tools and is itself huge
    # enough to force the break-path compaction to actually drop something (dropping just
    # the closing message alone would not clear RequireDrop's two-message minimum, but
    # dropping it together with turn 1's exchange does). That compaction runs on turn 2, the
    # same turn number Compress-FinalContext then receives as $turnsUsed, which is exactly
    # the case the LastCompactionTurn guard exists for.
    $noDoubleWorkspace = Join-Path $testRoot 'nodouble/ws'
    New-Item -ItemType Directory -Path $noDoubleWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $noDoubleWorkspace 'a.txt') -Value 'original text' -Encoding utf8NoBOM
    $noDouble = Invoke-WorkerAgainstStub -Workspace $noDoubleWorkspace -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'a.txt' }))),
        (New-AssistantResponse -Content $closingContent),
        (New-AssistantResponse -Content $summaryJson),
        (New-AssistantResponse -Content $structuredResult)
    )
    Assert-Worker ($noDouble.exitCode -eq 0) 'a session that compacts on its closing turn still completes'
    Assert-Worker ($noDouble.stdout -match 'compaction: turn=2 reason=threshold') 'the closing turn itself is what triggers the compaction'
    Assert-Worker ($noDouble.stdout -notmatch 'reason=final') 'a reduction is not repeated immediately after a compaction that just ran on the same turn'

    # --- a file read once windowed and once whole is recorded once, correctly ----------
    $rereadWorkspace = Join-Path $testRoot 'reread/ws'
    New-Item -ItemType Directory -Path $rereadWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $rereadWorkspace 'a.txt') -Encoding utf8NoBOM -Value (1..50 | ForEach-Object { "line $_" })
    $reread = Invoke-WorkerAgainstStub -Workspace $rereadWorkspace -Responses @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'a.txt'; start_line = 1; max_lines = 5 }))),
        (New-AssistantResponse -PromptTokens 25000 -ToolCalls @((New-ToolCall 'read_file' @{ path = 'a.txt' }))),
        (New-AssistantResponse -Content $summaryJson),
        (New-AssistantResponse -Content 'done'),
        (New-AssistantResponse -Content $structuredResult)
    )
    Assert-Worker ($reread.exitCode -eq 0) 'reading a file both windowed and in full still completes'
    # requests[0]=turn1, [1]=turn2 (triggers compaction), [2]=the summarization call itself,
    # [3]=turn3's request, which carries the rebuilt history the compaction produced.
    $rereadBlock = [string](($reread.requests[3] | ConvertFrom-Json -AsHashtable).messages[2].content)
    Assert-Worker ($rereadBlock -match 'Files read: a\.txt$' -or $rereadBlock -match 'Files read: a\.txt\r?\n') 'a file read once partially and later in full is recorded once, as whole'
    Assert-Worker ($rereadBlock -notmatch 'a\.txt \(partial\)') 'the earlier partial record does not survive alongside the later whole one'

    # --- a whole read of a file containing the truncation marker text is not misread ---
    # workers/hdo-ollama-worker.ps1 itself contains the literal marker substrings this test
    # checks for, which is exactly the self-referential case the structural flag exists to
    # get right instead of by matching the returned text.
    $markerWorkspace = Join-Path $testRoot 'marker/ws'
    New-Item -ItemType Directory -Path $markerWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $markerWorkspace 'quote.txt') -Encoding utf8NoBOM -Value @(
        'this file quotes error text that looks like a truncation marker:',
        '...[truncated after 20000 characters; call read_file again with start_line=1 to continue]',
        '...[stopped at max_lines; call read_file with start_line=2 to continue]'
    )
    $marker = Invoke-WorkerAgainstStub -Workspace $markerWorkspace -Responses @(
        (New-AssistantResponse -PromptTokens 25000 -ToolCalls @((New-ToolCall 'read_file' @{ path = 'quote.txt' }))),
        (New-AssistantResponse -Content $summaryJson),
        (New-AssistantResponse -Content 'done'),
        (New-AssistantResponse -Content $structuredResult)
    )
    Assert-Worker ($marker.exitCode -eq 0) 'reading a file that itself contains truncation marker text still completes'
    # requests[0]=turn1 (triggers compaction), [1]=the summarization call, [2]=turn2's
    # request, which carries the rebuilt history.
    $markerBlock = [string](($marker.requests[2] | ConvertFrom-Json -AsHashtable).messages[2].content)
    Assert-Worker ($markerBlock -match 'Files read: quote\.txt$' -or $markerBlock -match 'Files read: quote\.txt\r?\n') 'a whole read is recorded as whole even when its content contains truncation marker text'

    # --- compaction survives a summarizer that returns nothing usable ------------------
    $degradedWorkspace = Join-Path $testRoot 'degraded/ws'
    New-Item -ItemType Directory -Path $degradedWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $degradedWorkspace 'a.txt') -Value 'original text' -Encoding utf8NoBOM
    $emptyReply = New-AssistantResponse -Content ''
    $degraded = Invoke-WorkerAgainstStub -Workspace $degradedWorkspace -KeepRecentMessages 2 `
        -Responses @($readCall, $editCall, $emptyReply, $finishedReply, $emptyReply, $structuredReply)
    Assert-Worker ($degraded.exitCode -eq 0) 'an unusable summary does not fail a step whose work is already on disk'
    $degradedBlock = [string](($degraded.requests[3] | ConvertFrom-Json -AsHashtable).messages[2].content)
    Assert-Worker ($degradedBlock -match 'Files changed: a\.txt') 'the worker-observed state survives even when the summarizer returns nothing'
    Assert-Worker ($degradedBlock -match 'unavailable') 'a missing summary is stated rather than silently left blank'

    # --- compaction can be turned off --------------------------------------------------
    $disabledWorkspace = Join-Path $testRoot 'disabled/ws'
    New-Item -ItemType Directory -Path $disabledWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $disabledWorkspace 'a.txt') -Value 'original text' -Encoding utf8NoBOM
    $disabled = Invoke-WorkerAgainstStub -Workspace $disabledWorkspace -CompactAtPercent 0 -KeepRecentMessages 2 `
        -Responses @($readCall, $editCall, $finishedReply, $structuredReply)
    Assert-Worker ($disabled.exitCode -eq 0) 'disabling compaction keeps the worker working'
    Assert-Worker ($disabled.stdout -notmatch 'compaction:') 'no compaction happens when it is disabled, however large the prompt gets'
    $disabledFinal = @(($disabled.requests[-1] | ConvertFrom-Json -AsHashtable).messages)
    Assert-Worker ($disabledFinal.Count -eq 8) 'the full history is still replayed when compaction is disabled'
    Assert-Worker ((@($disabledFinal | Where-Object { $_.role -eq 'tool' })).Count -eq 2) 'every tool result is still present when compaction is disabled'

    # --- the final report does not replay an expensive tool loop -----------------------
    # The scripted prompt_eval_count stays at 100, so nothing compacts during the loop; the
    # 4096-token window is what makes the accumulated transcript expensive enough for the
    # final reduction to be worth doing.
    $finalWorkspace = Join-Path $testRoot 'finalctx/ws'
    New-Item -ItemType Directory -Path $finalWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $finalWorkspace 'big.txt') -Encoding utf8NoBOM `
        -Value (1..100 | ForEach-Object { "line $_ of the file under inspection" })
    # Every read here is windowed (max_lines short of the file's length), so the file is
    # never read whole across the scenario and the partial marker stays meaningful.
    $expensiveReads = @(
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'big.txt'; start_line = 1; max_lines = 50 }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'big.txt'; start_line = 2; max_lines = 50 }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'big.txt'; start_line = 3; max_lines = 50 }))),
        (New-AssistantResponse -ToolCalls @((New-ToolCall 'read_file' @{ path = 'big.txt'; start_line = 4; max_lines = 50 }))),
        (New-AssistantResponse -Content 'done')
    )
    # The model stops calling tools on the turn that crossed the threshold, so the loop
    # breaks before any compaction runs and the reduction has to produce the summary itself:
    # hence a summarization response before the structured one.
    $finalReduced = Invoke-WorkerAgainstStub -Workspace $finalWorkspace -ContextTokens 4096 -KeepRecentMessages 2 `
        -Prompt 'inspect big.txt four times' -Responses ($expensiveReads + @(
            (New-AssistantResponse -Content $summaryJson),
            (New-AssistantResponse -Content $structuredResult)))
    Assert-Worker ($finalReduced.exitCode -eq 0) 'reducing the history before the final report keeps the run successful'
    Assert-Worker ($finalReduced.stdout -match 'compaction: turn=5 reason=final') 'the reduction before the final report is reported in the diagnostics'
    $finalMessages = @(($finalReduced.requests[-1] | ConvertFrom-Json -AsHashtable).messages)
    Assert-Worker ($finalMessages.Count -lt 11) 'the final structured turn does not replay the whole tool loop'
    Assert-Worker ([string]$finalMessages[1].content -match 'inspect big\.txt four times') 'the original task is still present for the final report'
    Assert-Worker ([string]$finalMessages[2].content -match 'HDO WORKING STATE') 'the final report is given the compacted working state'
    Assert-Worker ([string]$finalMessages[2].content -match 'Files read: big\.txt') 'the compacted working state carries what the worker observed'
    Assert-Worker ([string]$finalMessages[2].content -match 'big\.txt \(partial\)') 'a windowed read is recorded as partial, not as a file already read in full'
    Assert-Worker ([string]$finalMessages[2].content -match 'Current state: the edit is applied' -and
        [string]$finalMessages[2].content -notmatch 'unavailable') 'a reduction with no earlier summary writes one instead of reporting from facts alone'
    Assert-Worker ([string]$finalMessages[-1].content -match 'matching the required schema') 'the final instruction still closes the reduced conversation'

    # --- a transcript the run can still afford is not thrown away ----------------------
    # Same shape, but a window wide enough that the accumulated history is cheap. Replacing
    # it would cost the final report its actual transcript and hand it only the terse
    # verified facts, because no compaction has run to write the model half of the block.
    $affordableWorkspace = Join-Path $testRoot 'affordable/ws'
    New-Item -ItemType Directory -Path $affordableWorkspace -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $affordableWorkspace 'big.txt') -Encoding utf8NoBOM `
        -Value (1..100 | ForEach-Object { "line $_ of the file under inspection" })
    $affordable = Invoke-WorkerAgainstStub -Workspace $affordableWorkspace -KeepRecentMessages 2 `
        -Prompt 'inspect big.txt four times' -Responses ($expensiveReads + @((New-AssistantResponse -Content $structuredResult)))
    Assert-Worker ($affordable.exitCode -eq 0) 'a run whose history fits the window still completes'
    Assert-Worker ($affordable.stdout -notmatch 'reason=final') 'a history that comfortably fits the window is not reduced'
    $affordableMessages = @(($affordable.requests[-1] | ConvertFrom-Json -AsHashtable).messages)
    Assert-Worker ($affordableMessages.Count -eq 12) 'the whole transcript still reaches the final report when it is affordable'
    Assert-Worker ((@($affordableMessages | Where-Object { $_.role -eq 'tool' })).Count -eq 4) 'every tool result is still available to the final report'
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($failures -gt 0) {
    Write-Host "$failures lean worker check(s) failed."
    exit 1
}
Write-Host 'Lean worker checks passed.'
exit 0
