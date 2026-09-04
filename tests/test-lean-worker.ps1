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
    param([string]$Content = '', [array]$ToolCalls, [switch]$OmitTokenCounts)

    $message = [ordered]@{ role = 'assistant'; content = $Content }
    if ($ToolCalls) { $message['tool_calls'] = $ToolCalls }
    $response = [ordered]@{ message = $message; done_reason = 'stop' }
    # Ollama marks the counters omitempty, so a fully cached prompt really does come back
    # without prompt_eval_count.
    if (-not $OmitTokenCounts) { $response['prompt_eval_count'] = 100 }
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
        [int]$MaxTurns = 40
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
            '-WorkingDirectory', $Workspace, '-Model', 'stub-model', '-ContextTokens', '32768',
            '-MaxToolResultChars', "$MaxToolResultChars", '-MaxTurns', "$MaxTurns",
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
