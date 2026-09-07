@{
    RootModule = 'HybridDevOrchestrator.psm1'
    ModuleVersion = '0.14.0'
    GUID = 'ee118cd5-4d93-44e1-9a9d-2875cc9b3c1c'
    Author = 'kkb-hub'
    CompanyName = 'kkb-hub'
    Copyright = '(c) 2026 kkb-hub. Released under the MIT License.'
    Description = 'GitHub Issue driven implementation and review orchestrator.'
    PowerShellVersion = '7.2'
    FunctionsToExport = @(
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
    CmdletsToExport = @()
    VariablesToExport = @()
    AliasesToExport = @()
    PrivateData = @{
        PSData = @{
            Tags = @('GitHub', 'LLM', 'Ollama', 'Codex', 'Orchestration')
            ProjectUri = 'https://github.com/kkb-hub/hybrid-dev-orchestrator'
            LicenseUri = 'https://github.com/kkb-hub/hybrid-dev-orchestrator/blob/main/LICENSE'
        }
    }
}
