[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('help', 'doctor', 'config', 'issues', 'inspect', 'run', 'status', 'cleanup', 'labels')]
    [string]$Command = 'help',

    [Alias('IssueNumber')]
    [int]$Issue,
    [switch]$Pick,
    [string]$RunId,
    [string]$Repository,
    [string]$RepositoryPath = (Get-Location).Path,
    [Alias('ConfigPath')]
    [string]$Config,
    [string]$Profile,
    [string[]]$SetStep = @(),
    [switch]$DryRun,
    [switch]$NoWriteBack,
    [switch]$Apply,
    [switch]$Force,
    [switch]$WhatIf,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'src/HybridDevOrchestrator/HybridDevOrchestrator.psd1') -Force

function Write-HdoCliOutput {
    param($Value)
    if ($Json) { $Value | ConvertTo-Json -Depth 100; return }
    $Value
}

function Get-HdoCliConfig {
    return Get-HdoConfig -RepositoryPath $RepositoryPath -ConfigPath $Config -Profile $Profile
}

try {
    switch ($Command) {
        'help' {
            @'
Hybrid Dev Orchestrator

  pwsh ./hdo.ps1 doctor  [-Profile <name>] [-DryRun] [-Json]
  pwsh ./hdo.ps1 config  [-Config <path>] [-Profile <name>] [-Json]
  pwsh ./hdo.ps1 issues  [-Repository owner/repo] [-Json]
  pwsh ./hdo.ps1 inspect -Issue <number> [-Repository owner/repo] [-Json]
  pwsh ./hdo.ps1 run     (-Issue <number> | -Pick) [-Profile <name>] [-SetStep implement=<runner>] [-DryRun] [-NoWriteBack] [-Json]
  pwsh ./hdo.ps1 status  -RunId <id> [-Json]
  pwsh ./hdo.ps1 cleanup -RunId <id> [-Force] [-WhatIf]
  pwsh ./hdo.ps1 labels  [-Repository owner/repo] [-Apply] [-WhatIf]

DryRun performs GitHub reads, contract validation, configuration resolution, and a read-only preflight only.
NoWriteBack runs the local cycle without changing GitHub labels or comments.
'@
        }
        'doctor' {
            $resolved = Get-HdoCliConfig
            $result = Test-HdoEnvironment -Config $resolved -ReadOnly:$DryRun
            if ($Json) { Write-HdoCliOutput $result }
            else { $result.checks | ForEach-Object { [pscustomobject]$_ } | Format-Table name, status, required, message -AutoSize }
            if (-not $result.ok) { exit 3 }
        }
        'config' {
            $resolved = Get-HdoCliConfig
            Write-HdoCliOutput ([ordered]@{
                profile = $resolved.resolvedProfile
                sources = $resolved.configSources
                warnings = $resolved.configurationWarnings
                execution = Get-HdoExecutionPlan $resolved
            })
        }
        'issues' {
            $resolved = Get-HdoCliConfig
            $candidates = @(Get-HdoIssueCandidate -Config $resolved -Repository $Repository)
            if ($Json) { Write-HdoCliOutput $candidates }
            else { $candidates | ForEach-Object { [pscustomobject]$_ } | Select-Object number, priorityRank, createdAt, title, url | Format-Table -AutoSize }
            if ($candidates.Count -eq 0) { exit 4 }
        }
        'inspect' {
            if ($Issue -le 0) { throw 'inspect requires -Issue <number>.' }
            $resolved = Get-HdoCliConfig
            $issueData = Get-HdoIssue -Number $Issue -Config $resolved -Repository $Repository
            $contract = ConvertTo-HdoIssueContract $issueData
            Write-HdoCliOutput ([ordered]@{ issue = $issueData; contract = $contract; validation = Test-HdoIssueContract -Contract $contract -Config $resolved -RequireReady })
        }
        'run' {
            if ($Issue -gt 0 -and $Pick) { throw 'Specify either -Issue or -Pick, not both.' }
            $stepOverrides = [ordered]@{}
            foreach ($override in $SetStep) {
                if ($override -notmatch '^(plan|implement|review|fix)=(?<runner>[A-Za-z0-9._-]+)$') {
                    throw "Invalid -SetStep '$override'. Expected step=runner."
                }
                $stepOverrides[$override.Split('=')[0]] = $Matches.runner
            }
            $result = Invoke-HdoRun -IssueNumber $Issue -Pick:$Pick -RepositoryPath $RepositoryPath -Repository $Repository `
                -ConfigPath $Config -Profile $Profile -StepOverrides $stepOverrides -DryRun:$DryRun -NoWriteBack:$NoWriteBack
            if ($Json -or $DryRun) { Write-HdoCliOutput $result }
            else {
                $worktreePath = if ($result.worktree -and $result.worktree.path) { $result.worktree.path } else { $null }
                $summary = if ($result.result -and $result.result.summary) { $result.result.summary } else { $null }
                $errorMessage = if ($result.error -and $result.error.message) { $result.error.message } else { $null }
                [pscustomobject]@{
                    RunId = $result.id
                    State = $result.state
                    Issue = "#$($result.issue.number) $($result.issue.title)"
                    Profile = $result.profile
                    Iterations = $result.iteration
                    Worktree = $worktreePath
                    Artifacts = $result.artifactPath
                    Summary = $summary
                    Error = $errorMessage
                } | Format-List
            }
            if ($DryRun -and -not $result.preflight.ok) { exit 3 }
            if (-not $DryRun -and $result.error -and $result.error.category -eq 'PREFLIGHT_FAILED') { exit 3 }
            if (-not $DryRun -and $result.state -eq 'ESCALATED') { exit 6 }
            if (-not $DryRun -and $result.state -eq 'FAILED') { exit 5 }
        }
        'status' {
            if (-not $RunId) { throw 'status requires -RunId.' }
            Write-HdoCliOutput (Get-HdoRun -RunId $RunId -RepositoryPath $RepositoryPath -ConfigPath $Config -Profile $Profile)
        }
        'cleanup' {
            if (-not $RunId) { throw 'cleanup requires -RunId.' }
            $parameters = @{
                RunId = $RunId
                RepositoryPath = $RepositoryPath
                ConfigPath = $Config
                Profile = $Profile
                Force = $Force
                Confirm = $false
                WhatIf = $WhatIf
            }
            Write-HdoCliOutput (Remove-HdoRunWorktree @parameters)
        }
        'labels' {
            $resolved = Get-HdoCliConfig
            Write-HdoCliOutput (Sync-HdoLabels -Config $resolved -Repository $Repository -Apply:$Apply -WhatIf:$WhatIf)
        }
    }
}
catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    if ($_.Exception.Message -like 'No eligible HDO Issue*') { exit 4 }
    exit 2
}
