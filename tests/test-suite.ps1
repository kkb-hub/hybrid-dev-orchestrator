[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testScripts = @(
    'tests/run-tests.ps1',
    'tests/test-process-output.ps1',
    'tests/test-cli.ps1',
    'tests/test-claude-contract.ps1'
)

foreach ($relativePath in $testScripts) {
    $scriptPath = Join-Path $repositoryRoot $relativePath
    & pwsh -NoProfile -File $scriptPath
    if ($LASTEXITCODE -ne 0) { throw "Test script failed with exit code $LASTEXITCODE`: $relativePath" }
}

Write-Host "PowerShell test suite passed ($($testScripts.Count) script(s))." -ForegroundColor Green
