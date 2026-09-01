#requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$failures = [System.Collections.Generic.List[string]]::new()
$passCount = 0

function Invoke-SchemaCase {
    param(
        [Parameter(Mandatory)]
        [string] $Name,

        [Parameter(Mandatory)]
        [string] $JsonPath,

        [Parameter(Mandatory)]
        [string] $SchemaPath,

        [Parameter(Mandatory)]
        [bool] $ExpectedValid
    )

    $jsonFullPath = Join-Path $repoRoot $JsonPath
    $schemaFullPath = Join-Path $repoRoot $SchemaPath

    if (-not (Test-Path -LiteralPath $jsonFullPath -PathType Leaf)) {
        $failures.Add("${Name}: JSON file not found: $JsonPath")
        Write-Host "[FAIL] $Name"
        return
    }

    if (-not (Test-Path -LiteralPath $schemaFullPath -PathType Leaf)) {
        $failures.Add("${Name}: schema file not found: $SchemaPath")
        Write-Host "[FAIL] $Name"
        return
    }

    $validationErrors = @()
    try {
        $json = Get-Content -LiteralPath $jsonFullPath -Raw
        $actualValid = $json | Test-Json `
            -SchemaFile $schemaFullPath `
            -ErrorAction SilentlyContinue `
            -ErrorVariable validationErrors
    }
    catch {
        $actualValid = $false
        $validationErrors += $_
    }

    if ([bool] $actualValid -eq $ExpectedValid) {
        $script:passCount++
        Write-Host "[PASS] $Name"
        return
    }

    $expectation = if ($ExpectedValid) { 'valid' } else { 'invalid' }
    $details = ($validationErrors | ForEach-Object { $_.Exception.Message }) -join ' | '
    if ([string]::IsNullOrWhiteSpace($details)) {
        $details = "Test-Json unexpectedly returned $actualValid."
    }

    $failures.Add("${Name}: expected $expectation. $details")
    Write-Host "[FAIL] $Name"
}

$validCases = @(
    @{
        Name = 'default config'
        JsonPath = 'config/hdo.default.json'
        SchemaPath = 'schemas/hdo-config.schema.json'
    },
    @{
        Name = 'cloud-only config'
        JsonPath = 'config/examples/cloud-only.json'
        SchemaPath = 'schemas/hdo-config.schema.json'
    },
    @{
        Name = 'Ollama hybrid config'
        JsonPath = 'config/examples/ollama-hybrid.json'
        SchemaPath = 'schemas/hdo-config.schema.json'
    },
    @{
        Name = 'project contract'
        JsonPath = '.hdo/project.json'
        SchemaPath = 'schemas/project-contract.schema.json'
    },
    @{
        Name = 'issue contract fixture'
        JsonPath = 'tests/fixtures/schema/issue.valid.json'
        SchemaPath = 'schemas/issue-contract.schema.json'
    },
    @{
        Name = 'task contract fixture'
        JsonPath = 'tests/fixtures/schema/task.valid.json'
        SchemaPath = 'schemas/task-contract.schema.json'
    },
    @{
        Name = 'worker result fixture'
        JsonPath = 'tests/fixtures/schema/worker.valid.json'
        SchemaPath = 'schemas/worker-result.schema.json'
    },
    @{
        Name = 'review result fixture'
        JsonPath = 'tests/fixtures/schema/review.valid.json'
        SchemaPath = 'schemas/review-result.schema.json'
    }
)

$invalidCases = @(
    @{
        Name = 'request_changes rejects empty findings'
        JsonPath = 'tests/fixtures/schema/review.invalid-request-changes-empty.json'
        SchemaPath = 'schemas/review-result.schema.json'
    },
    @{
        Name = 'approve rejects an open blocker'
        JsonPath = 'tests/fixtures/schema/review.invalid-approve-open-blocker.json'
        SchemaPath = 'schemas/review-result.schema.json'
    },
    @{
        Name = 'non-escalate rejects missing viewpoints'
        JsonPath = 'tests/fixtures/schema/review.invalid-missing-viewpoint-non-escalate.json'
        SchemaPath = 'schemas/review-result.schema.json'
    }
)

foreach ($case in $validCases) {
    Invoke-SchemaCase @case -ExpectedValid $true
}

foreach ($case in $invalidCases) {
    Invoke-SchemaCase @case -ExpectedValid $false
}

if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Host "Schema validation failed ($($failures.Count) case(s)):" -ForegroundColor Red
    foreach ($failure in $failures) {
        Write-Host " - $failure" -ForegroundColor Red
    }
    exit 1
}

Write-Host ''
Write-Host "Schema validation passed ($passCount case(s))." -ForegroundColor Green
exit 0
