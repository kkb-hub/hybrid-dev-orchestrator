[CmdletBinding()]
param()

# Contract test for the Claude adapter: every schema HDO passes to `claude --json-schema`
# must be accepted by the CLI's strict-mode schema validation. The CLI rejects an invalid
# schema before contacting the API, so an intentionally unavailable model keeps the probe
# free while still proving the schema parse stage passed.

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
$failures = [Collections.Generic.List[string]]::new()
$passes = 0

foreach ($schemaName in @('task-contract', 'worker-result', 'review-result')) {
    $schemaPath = Join-Path $repositoryRoot "schemas/$schemaName.schema.json"
    $normalizedSchemaJson = & $module { param($Path) ConvertTo-HdoClaudeJsonSchema $Path } $schemaPath
    $probe = & $module {
        param($SchemaJson, $WorkingDirectory)
        Invoke-HdoProcess -Command 'claude' -Arguments @(
            '-p', '--output-format', 'json', '--no-session-persistence', '--safe-mode',
            '--permission-mode', 'plan', '--json-schema', $SchemaJson,
            '--model', 'hdo-schema-probe-unavailable-model', 'Reply with the word ok.'
        ) -WorkingDirectory $WorkingDirectory -TimeoutSeconds 120
    } $normalizedSchemaJson $repositoryRoot
    $combinedOutput = "$($probe.stdout)`n$($probe.stderr)"
    if ($combinedOutput -match 'not a valid JSON Schema') {
        $failures.Add("claude rejected the normalized $schemaName schema: $($probe.stderr.Trim())")
        Write-Host "FAIL: claude accepts the normalized $schemaName schema" -ForegroundColor Red
    }
    else {
        $passes++
        Write-Host "PASS: claude accepts the normalized $schemaName schema"
    }
}

Write-Host "`n$passes Claude schema contract check(s) passed; $($failures.Count) failed."
if ($failures.Count -gt 0) {
    foreach ($failure in $failures) { Write-Host " - $failure" -ForegroundColor Red }
    exit 1
}
exit 0
