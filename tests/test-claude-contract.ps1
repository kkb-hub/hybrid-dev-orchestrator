[CmdletBinding()]
param()

# Contract test for the Claude adapter: every schema HDO passes to `claude --json-schema`
# must be accepted by the CLI's strict-mode schema validation. The CLI parses the schema
# before contacting the API, so an intentionally unavailable model keeps the probe free
# while still proving the schema parse stage passed: reaching the model lookup means the
# schema was accepted, because a rejected schema aborts with "not a valid JSON Schema"
# before any model resolution.
#
# The oracle is deliberately closed-world so the test cannot silently pass:
# - schema rejection            -> FAIL
# - probe model reported by CLI -> PASS (the run got past schema parsing)
# - unsupported adapter flag    -> FAIL (the installed CLI cannot run the adapter at all)
# - anything else (no auth, network down, timeout) -> SKIP with the output shown

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

$claudeCommand = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeCommand) {
    Write-Host 'SKIP: the claude CLI is not installed; the Claude schema contract was not probed.' -ForegroundColor Yellow
    exit 0
}

Import-Module (Join-Path $repositoryRoot 'src/HybridDevOrchestrator/HybridDevOrchestrator.psd1') -Force
$module = Get-Module HybridDevOrchestrator
$probeModel = 'hdo-schema-probe-unavailable-model'
$failures = [Collections.Generic.List[string]]::new()
$skips = 0
$passes = 0

foreach ($schemaName in @('task-contract', 'worker-result', 'review-result')) {
    $schemaPath = Join-Path $repositoryRoot "schemas/$schemaName.schema.json"
    $probe = & $module {
        param($SchemaPath, $ProbeModel, $WorkingDirectory)
        # Build the argument list with the production helper (plus the probe prompt) and
        # run under the production credential-filtered environment, so the probe exercises
        # the exact command line and auth conditions a real claude step would use.
        $runner = [ordered]@{ sandbox = 'read-only'; model = $ProbeModel }
        $arguments = @(Get-HdoClaudeArguments -Runner $runner -SchemaJson (ConvertTo-HdoClaudeJsonSchema $SchemaPath))
        $arguments += 'Reply with the word ok.'
        Invoke-HdoProcess -Command 'claude' -Arguments $arguments -WorkingDirectory $WorkingDirectory `
            -Environment (Get-HdoSafeEnvironment @()) -TimeoutSeconds 120
    } $schemaPath $probeModel $repositoryRoot
    $combinedOutput = "$($probe.stdout)`n$($probe.stderr)"
    if ($combinedOutput -match 'not a valid JSON Schema') {
        $failures.Add("claude rejected the normalized $schemaName schema: $($probe.stderr.Trim())")
        Write-Host "FAIL: claude rejected the normalized $schemaName schema" -ForegroundColor Red
    }
    elseif ($combinedOutput -match [regex]::Escape($probeModel)) {
        $passes++
        Write-Host "PASS: claude accepts the normalized $schemaName schema (probe reached model resolution)"
    }
    elseif ($combinedOutput -match '(?i)unknown (?:option|argument)') {
        $failures.Add("the installed claude CLI does not support the adapter's arguments: $($combinedOutput.Trim())")
        Write-Host "FAIL: the installed claude CLI does not support the Claude adapter's arguments" -ForegroundColor Red
    }
    else {
        # The probe ended before the schema-parse outcome was observable (no auth,
        # network failure, timeout, ...): the contract is unproven, not violated.
        $skips++
        $reason = if ($probe.timedOut) { 'the probe timed out' } else { "exit code $($probe.exitCode)" }
        Write-Host "SKIP: the $schemaName schema probe was inconclusive ($reason); output follows." -ForegroundColor Yellow
        Write-Host (($combinedOutput.Trim() -split "`r?`n" | Select-Object -First 6) -join "`n") -ForegroundColor Yellow
    }
}

Write-Host "`n$passes Claude schema contract check(s) passed; $skips inconclusive; $($failures.Count) failed."
if ($failures.Count -gt 0) {
    foreach ($failure in $failures) { Write-Host " - $failure" -ForegroundColor Red }
    exit 1
}
exit 0
