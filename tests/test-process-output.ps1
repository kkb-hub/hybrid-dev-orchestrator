[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Import-Module (Join-Path $repositoryRoot 'src/HybridDevOrchestrator/HybridDevOrchestrator.psd1') -Force
$module = Get-Module HybridDevOrchestrator
$temporaryRoot = Join-Path $repositoryRoot "test-results/process-output-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null

try {
    foreach ($stream in @('stdout', 'stderr')) {
        $stdoutPath = Join-Path $temporaryRoot "$stream.stdout.log"
        $stderrPath = Join-Path $temporaryRoot "$stream.stderr.log"
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $result = & $module {
            param($Root, $Stream, $StdoutPath, $StderrPath)
            Invoke-HdoProcess -Command 'pwsh' -Arguments @(
                '-NoProfile',
                '-File',
                (Join-Path $Root 'tests/fixtures/runtime/spam-output.ps1'),
                '-Stream',
                $Stream
            ) -WorkingDirectory $Root -TimeoutSeconds 20 -StandardOutputPath $StdoutPath `
                -StandardErrorPath $StderrPath -MaximumOutputBytes 32768 -OutputTailBytes 4096
        } $repositoryRoot $stream $stdoutPath $stderrPath
        $stopwatch.Stop()

        if ($result.exitCode -ne 125 -or -not $result.outputLimitExceeded -or $result.outputLimitStream -ne $stream) {
            throw "Expected a bounded $stream failure, got: $($result | ConvertTo-Json -Compress -Depth 10)"
        }
        if ($stopwatch.Elapsed.TotalSeconds -ge 10) { throw "$stream spam process was not terminated promptly." }
        $capturedPath = if ($stream -eq 'stdout') { $stdoutPath } else { $stderrPath }
        $capturedLength = (Get-Item -LiteralPath $capturedPath).Length
        if ($capturedLength -ne 32768) { throw "Expected a 32768-byte $stream artifact, got $capturedLength bytes." }
        & $module { param($Path) Protect-HdoLogFile $Path 32768 } $capturedPath
        if ((Get-Item -LiteralPath $capturedPath).Length -gt 32768) { throw "$stream artifact exceeded its cap after redaction." }
        if ([Text.Encoding]::UTF8.GetByteCount([string]$(if ($stream -eq 'stdout') { $result.stdout } else { $result.stderr })) -gt 4096) {
            throw "$stream in-memory tail exceeded 4096 bytes."
        }
    }

    $heartbeatProbe = & $module {
        param($Root)
        $events = [Collections.Generic.List[object]]::new()
        $result = Invoke-HdoProcess -Command 'pwsh' -Arguments @(
            '-NoProfile',
            '-File',
            (Join-Path $Root 'tests/fixtures/runtime/delayed-output.ps1')
        ) -WorkingDirectory $Root -TimeoutSeconds 10 -ProgressIntervalSeconds 1 -ActivityCallback {
            param($Event)
            $events.Add($Event)
        }
        return [pscustomobject]@{ result = $result; events = [object[]]$events }
    } $repositoryRoot
    if ($heartbeatProbe.result.exitCode -ne 0 -or $heartbeatProbe.result.stdout -ne '{"status":"ok"}') {
        throw "Expected the delayed process to succeed, got: $($heartbeatProbe.result | ConvertTo-Json -Compress -Depth 10)"
    }
    if ($heartbeatProbe.events.Count -lt 1 -or $heartbeatProbe.events[0].type -ne 'process.heartbeat' -or $heartbeatProbe.events[0].elapsedSeconds -lt 1) {
        throw "Expected at least one bounded process heartbeat, got: $($heartbeatProbe.events | ConvertTo-Json -Compress -Depth 10)"
    }
    if ($heartbeatProbe.events[0].Contains('command') -or $heartbeatProbe.events[0].Contains('arguments') -or $heartbeatProbe.events[0].Contains('inputText')) {
        throw 'Process heartbeat exposed command, argument, or prompt content.'
    }
    $closedProgressProbe = & $module {
        param($Root)
        Invoke-HdoProcess -Command 'pwsh' -Arguments @(
            '-NoProfile',
            '-File',
            (Join-Path $Root 'tests/fixtures/runtime/delayed-output.ps1')
        ) -WorkingDirectory $Root -TimeoutSeconds 10 -ProgressIntervalSeconds 1 -ActivityCallback {
            'callback output must not pollute the process result'
            throw 'simulated closed progress stream'
        }
    } $repositoryRoot
    if ($closedProgressProbe -isnot [System.Collections.IDictionary] -or $closedProgressProbe.exitCode -ne 0 -or $closedProgressProbe.stdout -ne '{"status":"ok"}') {
        throw "A failed progress callback changed a successful process result: $($closedProgressProbe | ConvertTo-Json -Compress -Depth 10)"
    }

    $childPidPath = Join-Path $temporaryRoot 'detached-child.pid'
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $detachedResult = & $module {
        param($Root, $PidPath)
        Invoke-HdoProcess -Command 'pwsh' -Arguments @(
            '-NoProfile',
            '-File',
            (Join-Path $Root 'tests/fixtures/runtime/hold-output-handle.ps1'),
            '-PidPath',
            $PidPath
        ) -WorkingDirectory $Root -TimeoutSeconds 20 -OutputDrainSeconds 1
    } $repositoryRoot $childPidPath
    $stopwatch.Stop()
    if ($stopwatch.Elapsed.TotalSeconds -ge 6) { throw 'Inherited output handles blocked capture beyond the drain timeout.' }
    if ($IsWindows) {
        if ($detachedResult.exitCode -ne 0 -or $detachedResult.outputDrainTimedOut) {
            throw "Expected the Windows process job to clean up inherited output handles, got: $($detachedResult | ConvertTo-Json -Compress -Depth 10)"
        }
        $childPid = [int]([IO.File]::ReadAllText($childPidPath))
        if (Get-Process -Id $childPid -ErrorAction SilentlyContinue) { throw 'Windows process job did not terminate the detached child.' }
    }
    elseif ($detachedResult.exitCode -ne 127 -or -not $detachedResult.outputDrainTimedOut -or $detachedResult.stderr -notmatch 'remained open') {
        throw "Expected inherited output handles to produce a bounded capture failure, got: $($detachedResult | ConvertTo-Json -Compress -Depth 10)"
    }

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $inputResult = & $module {
        param($Root, $InputText)
        Invoke-HdoProcess -Command 'pwsh' -Arguments @(
            '-NoProfile',
            '-File',
            (Join-Path $Root 'tests/fixtures/runtime/ignore-input.ps1')
        ) -WorkingDirectory $Root -InputText $InputText -TimeoutSeconds 1 -OutputDrainSeconds 1
    } $repositoryRoot ('x' * 5242880)
    $stopwatch.Stop()
    if ($inputResult.exitCode -ne 124 -or -not $inputResult.timedOut) {
        throw "Expected a timed-out non-reading process, got: $($inputResult | ConvertTo-Json -Compress -Depth 10)"
    }
    if ($stopwatch.Elapsed.TotalSeconds -ge 7) { throw 'A blocked stdin write was not cancelled promptly.' }

    $invalidOutputPath = Join-Path $temporaryRoot 'stdout-is-a-directory'
    New-Item -ItemType Directory -Path $invalidOutputPath -Force | Out-Null
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $captureErrorResult = & $module {
        param($Root, $OutputPath)
        Invoke-HdoProcess -Command 'pwsh' -Arguments @(
            '-NoProfile',
            '-File',
            (Join-Path $Root 'tests/fixtures/runtime/ignore-input.ps1')
        ) -WorkingDirectory $Root -TimeoutSeconds 20 -StandardOutputPath $OutputPath -OutputDrainSeconds 1
    } $repositoryRoot $invalidOutputPath
    $stopwatch.Stop()
    if ($captureErrorResult.exitCode -ne 127 -or $captureErrorResult.stderr -notmatch 'Failed to capture') {
        throw "Expected output initialization to fail safely, got: $($captureErrorResult | ConvertTo-Json -Compress -Depth 10)"
    }
    if ($stopwatch.Elapsed.TotalSeconds -ge 7) { throw 'An output initialization failure did not terminate the process promptly.' }

    $invalidFinalPath = Join-Path $temporaryRoot 'invalid-final.json'
    [IO.File]::WriteAllText($invalidFinalPath, '{"apiKey":"sk-proj-12345678901234567890","unexpected":true}', [Text.UTF8Encoding]::new($false))
    & $module { param($Path) Protect-HdoLogFile $Path 32768 } $invalidFinalPath
    $protectedFinal = [IO.File]::ReadAllText($invalidFinalPath)
    if ($protectedFinal -match 'sk-proj-' -or $protectedFinal -notmatch '\[REDACTED\]') {
        throw 'A schema-invalid direct final artifact retained a credential.'
    }

    $diffRepository = Join-Path $temporaryRoot 'aggregate-diff-repository'
    New-Item -ItemType Directory -Path $diffRepository -Force | Out-Null
    & git -C $diffRepository init --quiet
    & git -C $diffRepository config user.email 'hdo-tests@example.invalid'
    & git -C $diffRepository config user.name 'HDO Tests'
    [IO.File]::WriteAllText((Join-Path $diffRepository 'tracked.txt'), 'base', [Text.UTF8Encoding]::new($false))
    & git -C $diffRepository add tracked.txt
    & git -C $diffRepository -c commit.gpgSign=false commit --quiet -m 'base'
    [IO.File]::WriteAllText((Join-Path $diffRepository 'untracked-a.txt'), ('a' * 1500), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $diffRepository 'untracked-b.txt'), ('b' * 1500), [Text.UTF8Encoding]::new($false))
    $aggregateError = $null
    try {
        & $module {
            param($Repository)
            $baseCommit = Get-HdoBaseCommit $Repository
            Get-HdoDiff $Repository $baseCommit -MaximumPatchBytes 2048 | Out-Null
        } $diffRepository
    }
    catch { $aggregateError = $_.Exception.Message }
    if ($aggregateError -notlike 'Aggregate Git diff exceeds*') {
        throw "Expected aggregate untracked diff output to be capped, got: $aggregateError"
    }

    Write-Host 'PASS: stdout/stderr limits, progress heartbeat, and drain timeout bound artifacts, memory, and process lifetime.'
}
finally {
    $childPidPath = Join-Path $temporaryRoot 'detached-child.pid'
    if (Test-Path -LiteralPath $childPidPath -PathType Leaf) {
        $childPid = [int]([IO.File]::ReadAllText($childPidPath))
        Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
