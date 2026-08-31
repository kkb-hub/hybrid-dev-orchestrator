Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:HdoRepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

$privateFiles = @(
    'Private/Common.ps1',
    'Private/Configuration.ps1',
    'Private/State.ps1',
    'Private/Git.ps1',
    'Private/GitHub.ps1',
    'Private/Runner.ps1',
    'Private/Workflow.ps1'
)

foreach ($relativePath in $privateFiles) {
    . (Join-Path $PSScriptRoot $relativePath)
}

Export-ModuleMember -Function @(
    'ConvertTo-HdoIssueContract',
    'Get-HdoConfig',
    'Get-HdoExecutionPlan',
    'Get-HdoIssue',
    'Get-HdoIssueCandidate',
    'Get-HdoRun',
    'Invoke-HdoRun',
    'Remove-HdoRunWorktree',
    'Sync-HdoLabels',
    'Test-HdoConfiguration',
    'Test-HdoEnvironment',
    'Test-HdoIssueContract',
    'Test-HdoStateTransition'
)
