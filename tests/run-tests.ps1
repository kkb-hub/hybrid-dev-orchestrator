[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testAppData = Join-Path $repositoryRoot "test-results/appdata-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $testAppData -Force | Out-Null
$env:APPDATA = $testAppData
$modulePath = Join-Path $repositoryRoot 'src/HybridDevOrchestrator/HybridDevOrchestrator.psd1'
Import-Module $modulePath -Force
$module = Get-Module HybridDevOrchestrator
$failures = [Collections.Generic.List[string]]::new()
$passes = 0

function Assert-Hdo {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if ($Condition) {
        $script:passes++
        Write-Host "PASS: $Message"
    }
    else {
        $script:failures.Add($Message)
        Write-Host "FAIL: $Message" -ForegroundColor Red
    }
}

function Copy-HdoObject {
    param($Value)
    $json = $Value | ConvertTo-Json -Depth 100
    return (& $module { param($Json) ConvertFrom-HdoJson -Json $Json -Depth 100 -AsHashtable } $json)
}

function Remove-HdoTestDirectory {
    param([Parameter(Mandatory)][string]$Path)
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        if (-not (Test-Path -LiteralPath $Path)) { return }
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force
            return
        }
        catch {
            if ($attempt -eq 10) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

try {
    $config = Get-HdoConfig -RepositoryPath $repositoryRoot
    Assert-Hdo ($config.resolvedProfile -eq 'claude-only') 'default profile is claude-only'
    $defaultRunnerTypes = @($config.steps.Values | ForEach-Object { $config.runners[[string]$_].type } | Sort-Object -Unique)
    Assert-Hdo ($defaultRunnerTypes.Count -eq 1 -and $defaultRunnerTypes[0] -eq 'claude') 'default profile routes every step to a Claude runner'
    Assert-Hdo ($config.runners['claude-planner'].passEnvironment -is [array]) 'empty JSON arrays remain arrays after configuration merge'
    Assert-Hdo ($config.runners['claude-planner'].passEnvironment.Count -eq 0) 'empty passEnvironment remains empty'

    $userConfigDirectory = Join-Path $testAppData 'hdo'
    New-Item -ItemType Directory -Path $userConfigDirectory -Force | Out-Null
    $userConfigPath = Join-Path $userConfigDirectory 'config.json'
    $explicitConfigPath = Join-Path $testAppData 'explicit.json'
    $secondExplicitConfigPath = Join-Path $testAppData 'explicit-second.json'
    [ordered]@{
        workflow = [ordered]@{ maxFixAttempts = 1 }
        github = [ordered]@{ priorityOrder = @('hdo:priority/p3') }
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $userConfigPath -Encoding utf8NoBOM
    [ordered]@{
        workflow = [ordered]@{ maxFixAttempts = 3 }
        github = [ordered]@{ priorityOrder = @('hdo:priority/p2', 'hdo:priority/p1') }
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $explicitConfigPath -Encoding utf8NoBOM
    [ordered]@{
        workflow = [ordered]@{ maxFixAttempts = 4 }
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $secondExplicitConfigPath -Encoding utf8NoBOM
    $precedenceConfig = Get-HdoConfig -RepositoryPath $repositoryRoot -ConfigPath $explicitConfigPath
    Assert-Hdo ($precedenceConfig.workflow.maxFixAttempts -eq 3) 'explicit config overrides user config and distribution defaults'
    Assert-Hdo ($precedenceConfig.github.priorityOrder.Count -eq 2 -and $precedenceConfig.github.priorityOrder[0] -eq 'hdo:priority/p2') 'configuration arrays replace instead of concatenate during merge'
    $multipleExplicitConfig = Get-HdoConfig -RepositoryPath $repositoryRoot -ConfigPath @($explicitConfigPath, $secondExplicitConfigPath)
    Assert-Hdo ($multipleExplicitConfig.workflow.maxFixAttempts -eq 4) 'multiple explicit configs are merged in the supplied order with the later file winning'
    Assert-Hdo ($multipleExplicitConfig.configSources[-2] -eq $explicitConfigPath -and $multipleExplicitConfig.configSources[-1] -eq $secondExplicitConfigPath) 'multiple explicit config sources preserve their supplied order'
    Remove-Item -LiteralPath $userConfigPath, $explicitConfigPath, $secondExplicitConfigPath -Force

    $platformUserConfigDirectory = & $module { param($Kind) Get-HdoPlatformDirectory -Kind $Kind } 'UserConfig'
    Assert-Hdo ($platformUserConfigDirectory -eq $env:APPDATA) 'Get-HdoPlatformDirectory UserConfig matches the redirected APPDATA environment variable'

    $localAppDataWorktreePath = & $module { param($Path, $Repository) Expand-HdoPath $Path $Repository } '%LOCALAPPDATA%/hdo/worktrees' $repositoryRoot
    $expectedLocalAppDataWorktreePath = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'hdo/worktrees'))
    Assert-Hdo ($localAppDataWorktreePath -eq $expectedLocalAppDataWorktreePath) 'Expand-HdoPath resolves %LOCALAPPDATA% via the environment variable when it is set'

    $savedLocalAppData = $env:LOCALAPPDATA
    try {
        $env:LOCALAPPDATA = $null
        $fallbackDataDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData, [Environment+SpecialFolderOption]::DoNotVerify)
        $expectedFallbackWorktreePath = [IO.Path]::GetFullPath((Join-Path $fallbackDataDirectory 'hdo/worktrees'))
        $expectedFallbackArtifactPath = [IO.Path]::GetFullPath((Join-Path $fallbackDataDirectory 'hdo/runs'))

        $fallbackWorktreePath = & $module { param($Path, $Repository) Expand-HdoPath $Path $Repository } '%LOCALAPPDATA%/hdo/worktrees' $repositoryRoot
        Assert-Hdo ($fallbackWorktreePath -eq $expectedFallbackWorktreePath) 'Expand-HdoPath falls back to the .NET known folder when LOCALAPPDATA is unset'
        $fallbackIsRooted = [IO.Path]::IsPathRooted($fallbackWorktreePath)
        $fallbackWithinRepository = & $module { param($Path, $Root) Test-HdoPathWithinRoot $Path $Root } $fallbackWorktreePath $repositoryRoot
        Assert-Hdo ($fallbackIsRooted -and -not $fallbackWithinRepository) 'the LOCALAPPDATA fallback path is rooted and outside the repository'

        $lowercaseFallbackWorktreePath = & $module { param($Path, $Repository) Expand-HdoPath $Path $Repository } '%localappdata%/hdo/worktrees' $repositoryRoot
        Assert-Hdo ($lowercaseFallbackWorktreePath -eq $expectedFallbackWorktreePath) 'Expand-HdoPath resolves the lowercase %localappdata% token the same way as the uppercase token'

        $fallbackPathConfig = Get-HdoConfig -RepositoryPath $repositoryRoot
        Assert-Hdo ($fallbackPathConfig.paths.worktreeRoot -eq $expectedFallbackWorktreePath) 'Get-HdoConfig resolves paths.worktreeRoot through the LOCALAPPDATA fallback end to end (AC-03)'
        Assert-Hdo ($fallbackPathConfig.paths.artifactRoot -eq $expectedFallbackArtifactPath) 'Get-HdoConfig resolves paths.artifactRoot through the LOCALAPPDATA fallback end to end (AC-03)'
    }
    finally {
        $env:LOCALAPPDATA = $savedLocalAppData
    }

    $savedAppData = $env:APPDATA
    try {
        $env:APPDATA = $null
        $expectedFallbackUserConfigDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData, [Environment+SpecialFolderOption]::DoNotVerify)
        $fallbackUserConfigDirectory = & $module { param($Kind) Get-HdoPlatformDirectory -Kind $Kind } 'UserConfig'
        Assert-Hdo ($fallbackUserConfigDirectory -and $fallbackUserConfigDirectory -eq $expectedFallbackUserConfigDirectory) 'Get-HdoPlatformDirectory UserConfig falls back to the .NET ApplicationData known folder when APPDATA is unset'

        $fallbackUserConfigPath = & $module { param($Path, $Repository) Expand-HdoPath $Path $Repository } '%AppData%/hdo/config.json' $repositoryRoot
        $expectedFallbackUserConfigPath = [IO.Path]::GetFullPath((Join-Path $expectedFallbackUserConfigDirectory 'hdo/config.json'))
        Assert-Hdo ($fallbackUserConfigPath -eq $expectedFallbackUserConfigPath) 'Expand-HdoPath falls back to the .NET ApplicationData known folder for %AppData% when APPDATA is unset'
    }
    finally {
        $env:APPDATA = $savedAppData
    }

    $savedLocalAppDataForMixedToken = $env:LOCALAPPDATA
    $savedAppDataForMixedToken = $env:APPDATA
    try {
        $env:LOCALAPPDATA = $null
        $env:APPDATA = $null
        $mixedTokenLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData, [Environment+SpecialFolderOption]::DoNotVerify)
        $mixedTokenAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData, [Environment+SpecialFolderOption]::DoNotVerify)
        $expectedMixedTokenPath = [IO.Path]::GetFullPath($mixedTokenLocalAppData + '/x/' + $mixedTokenAppData + '/y')
        $mixedTokenPath = & $module { param($Path, $Repository) Expand-HdoPath $Path $Repository } '%LocalAppData%/x/%AppData%/y' $repositoryRoot
        Assert-Hdo ($mixedTokenPath -eq $expectedMixedTokenPath) 'Expand-HdoPath resolves both %LocalAppData% and %AppData% fallbacks within a single path when both environment variables are unset'
    }
    finally {
        $env:LOCALAPPDATA = $savedLocalAppDataForMixedToken
        $env:APPDATA = $savedAppDataForMixedToken
    }

    $defaultPathConfig = Get-HdoConfig -RepositoryPath $repositoryRoot
    $expectedDefaultWorktreeRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'hdo/worktrees'))
    Assert-Hdo ([IO.Path]::IsPathRooted($defaultPathConfig.paths.worktreeRoot) -and $defaultPathConfig.paths.worktreeRoot -eq $expectedDefaultWorktreeRoot) 'default configuration still resolves paths.worktreeRoot through %LOCALAPPDATA% unchanged'

    $otherRepository = Join-Path $testAppData 'target-repository'
    New-Item -ItemType Directory -Path (Join-Path $otherRepository '.hdo') -Force | Out-Null
    & git -C $otherRepository init --quiet
    & git -C $otherRepository config user.email 'hdo-tests@example.invalid'
    & git -C $otherRepository config user.name 'HDO Tests'
    & git -C $otherRepository config commit.gpgSign false
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'config/examples/repository-ollama-hybrid.json') -Destination (Join-Path $otherRepository '.hdo/config.json')
    Set-Content -LiteralPath (Join-Path $otherRepository 'README.md') -Value 'repository config test' -Encoding utf8NoBOM
    & git -C $otherRepository add -- .hdo/config.json README.md
    & git -C $otherRepository commit --quiet -m baseline
    $repositoryConfig = Get-HdoConfig -RepositoryPath $otherRepository
    Assert-Hdo ($repositoryConfig.resolvedProfile -eq 'ollama-hybrid') 'committed repository .hdo/config.json is loaded automatically'
    Assert-Hdo ($repositoryConfig.repositoryConfig.loaded -and $repositoryConfig.repositoryConfig.blob -and $repositoryConfig.repositoryConfig.sha256) 'repository config records its fixed commit, blob, and SHA-256 identity'
    Assert-Hdo ($repositoryConfig.runners['claude-ollama-implementer'].command -eq 'claude') 'new repository runners receive the fixed built-in adapter command'
    Assert-Hdo ($repositoryConfig.runners['claude-ollama-implementer'].passEnvironment.Count -eq 0 -and $repositoryConfig.runners['claude-ollama-implementer'].extraArgs.Count -eq 0) 'new repository runners cannot inject environment variables or extra arguments'
    Assert-Hdo ($repositoryConfig.runners['claude-ollama-implementer'].model -eq 'qwen3.8:27b-q4_K_M') 'repository routing selects the exact configured Ollama model'
    Assert-Hdo ($repositoryConfig.runners['claude-ollama-implementer'].contextTokens -eq 65536) 'repository routing ships a context window large enough for real repository-sized tasks'
    $repositoryExecution = Get-HdoExecutionPlan $repositoryConfig
    Assert-Hdo ($repositoryExecution.steps.plan.provider -eq 'cloud' -and $repositoryExecution.steps.review.provider -eq 'cloud' -and
        $repositoryExecution.steps.implement.provider -eq 'ollama' -and $repositoryExecution.steps.fix.provider -eq 'ollama') 'repository routing sends only implementation and fix roles to Ollama'
    Assert-Hdo ($config.resolvedProfile -eq 'claude-only' -and $config.steps.implement -eq 'claude-implementer') 'loading repository routing does not mutate an already resolved parent configuration'

    '{"schemaVersion":1,"activeProfile":"must-not-load"}' | Set-Content -LiteralPath (Join-Path $otherRepository '.hdo/config.json') -Encoding utf8NoBOM
    $headPinnedConfig = Get-HdoConfig -RepositoryPath $otherRepository
    Assert-Hdo ($headPinnedConfig.resolvedProfile -eq 'ollama-hybrid') 'automatic repository configuration is read from fixed HEAD rather than uncommitted working-tree content'
    & git -C $otherRepository restore -- .hdo/config.json

    $ignoredRepositoryConfig = Get-HdoConfig -RepositoryPath $otherRepository -IgnoreRepositoryConfig
    Assert-Hdo ($ignoredRepositoryConfig.resolvedProfile -eq 'claude-only' -and $ignoredRepositoryConfig.repositoryConfig.ignored) 'IgnoreRepositoryConfig restores distribution and user defaults'

    $alternativeConfigPath = Join-Path $otherRepository '.hdo/config.alternative.json'
    '{"activeProfile":"claude-only"}' | Set-Content -LiteralPath $alternativeConfigPath -Encoding utf8NoBOM
    $alternativeConfig = Get-HdoConfig -RepositoryPath $otherRepository -ConfigPath '.hdo/config.alternative.json'
    Assert-Hdo ($alternativeConfig.resolvedProfile -eq 'claude-only') 'an explicitly selected repository-relative config overrides automatic repository routing'
    Assert-Hdo ($alternativeConfig.configSources[-1] -eq $alternativeConfigPath) 'explicit repository-relative config records its resolved source path'

    $snapshotMatches = & $module { param($Config, $Repository) Assert-HdoRepositoryConfigSnapshot $Config $Repository } $repositoryConfig $otherRepository
    Assert-Hdo $snapshotMatches 'repository configuration snapshot matches the fixed HEAD used by the worktree'
    $mismatchedSnapshotConfig = Copy-HdoObject $repositoryConfig
    $mismatchedSnapshotConfig.repositoryConfig.sha256 = '0' * 64
    $snapshotMismatchRejected = $false
    try { $null = & $module { param($Config, $Repository) Assert-HdoRepositoryConfigSnapshot $Config $Repository } $mismatchedSnapshotConfig $otherRepository }
    catch { $snapshotMismatchRejected = $true }
    Assert-Hdo $snapshotMismatchRejected 'repository configuration snapshot mismatch fails closed'

    [ordered]@{
        runners = [ordered]@{
            'user-command-implementer' = [ordered]@{
                type = 'command'
                provider = 'custom'
                command = 'pwsh'
                sandbox = 'workspace-write'
                timeoutSeconds = 60
                passEnvironment = @()
                extraArgs = @()
            }
        }
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $userConfigPath -Encoding utf8NoBOM
    $explicitCommandOverridePath = Join-Path $otherRepository '.hdo/config.command-override.json'
    [ordered]@{
        profiles = [ordered]@{
            'ollama-hybrid' = [ordered]@{
                steps = [ordered]@{
                    plan = 'codex-cloud-planner'
                    implement = 'user-command-implementer'
                    review = 'codex-cloud-reviewer'
                    fix = 'user-command-implementer'
                }
            }
        }
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $explicitCommandOverridePath -Encoding utf8NoBOM
    $explicitCommandConfig = Get-HdoConfig -RepositoryPath $otherRepository -ConfigPath $explicitCommandOverridePath
    Assert-Hdo ($explicitCommandConfig.steps.implement -eq 'user-command-implementer') 'explicit trusted configuration may intentionally select a user-defined command runner'

    $repositoryCommandRoute = Get-Content -LiteralPath (Join-Path $otherRepository '.hdo/config.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    $repositoryCommandRoute.profiles['ollama-hybrid'].steps.implement = 'user-command-implementer'
    $repositoryCommandRoute.profiles['ollama-hybrid'].steps.fix = 'user-command-implementer'
    $repositoryCommandRoute | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $otherRepository '.hdo/config.json') -Encoding utf8NoBOM
    & git -C $otherRepository add -- .hdo/config.json
    & git -C $otherRepository commit --quiet -m 'unsafe repository command route'
    $repositoryCommandRouteRejected = $false
    try { $null = Get-HdoConfig -RepositoryPath $otherRepository }
    catch { $repositoryCommandRouteRejected = $_.Exception.Message -like 'Repository configuration cannot route*command runner*' }
    Assert-Hdo $repositoryCommandRouteRejected 'automatic repository routing cannot select a user-defined command runner'

    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'config/examples/repository-ollama-hybrid.json') -Destination (Join-Path $otherRepository '.hdo/config.json') -Force
    & git -C $otherRepository add -- .hdo/config.json
    & git -C $otherRepository commit --quiet -m 'restore safe repository config'
    Remove-Item -LiteralPath $userConfigPath -Force

    $forbiddenRepositoryConfig = Get-Content -LiteralPath (Join-Path $otherRepository '.hdo/config.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    $forbiddenRepositoryConfig.runners['claude-ollama-implementer']['command'] = 'arbitrary-command'
    $forbiddenRepositoryConfig | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $otherRepository '.hdo/config.json') -Encoding utf8NoBOM
    & git -C $otherRepository add -- .hdo/config.json
    & git -C $otherRepository commit --quiet -m 'forbidden repository config'
    $forbiddenRepositoryConfigRejected = $false
    try { $null = Get-HdoConfig -RepositoryPath $otherRepository }
    catch { $forbiddenRepositoryConfigRejected = $_.Exception.Message -like 'Repository configuration schema validation failed*' }
    Assert-Hdo $forbiddenRepositoryConfigRejected 'repository config rejects executable command injection'

    $uncommittedRepository = Join-Path $testAppData 'uncommitted-repository-config'
    New-Item -ItemType Directory -Path (Join-Path $uncommittedRepository '.hdo') -Force | Out-Null
    & git -C $uncommittedRepository init --quiet
    & git -C $uncommittedRepository config user.email 'hdo-tests@example.invalid'
    & git -C $uncommittedRepository config user.name 'HDO Tests'
    Set-Content -LiteralPath (Join-Path $uncommittedRepository 'README.md') -Value 'baseline' -Encoding utf8NoBOM
    & git -C $uncommittedRepository add -- README.md
    & git -C $uncommittedRepository -c commit.gpgSign=false commit --quiet -m baseline
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'config/examples/repository-ollama-hybrid.json') -Destination (Join-Path $uncommittedRepository '.hdo/config.json')
    $uncommittedRepositoryConfigRejected = $false
    try { $null = Get-HdoConfig -RepositoryPath $uncommittedRepository }
    catch { $uncommittedRepositoryConfigRejected = $_.Exception.Message -like 'Repository configuration must be committed*' }
    Assert-Hdo $uncommittedRepositoryConfigRejected 'uncommitted automatic repository config is rejected instead of executed'

    $nonGitDirectory = Join-Path $testAppData 'non-git-directory'
    New-Item -ItemType Directory -Path $nonGitDirectory -Force | Out-Null
    $nonGitConfig = Get-HdoConfig -RepositoryPath $nonGitDirectory
    Assert-Hdo ($nonGitConfig.resolvedProfile -eq 'claude-only' -and -not $nonGitConfig.repositoryConfig.loaded -and -not $nonGitConfig.repositoryConfig.ignored) 'configuration resolution outside a Git repository falls back instead of throwing'

    $newRunnerMissingFieldsRepository = Join-Path $testAppData 'new-runner-missing-fields'
    New-Item -ItemType Directory -Path (Join-Path $newRunnerMissingFieldsRepository '.hdo') -Force | Out-Null
    & git -C $newRunnerMissingFieldsRepository init --quiet
    & git -C $newRunnerMissingFieldsRepository config user.email 'hdo-tests@example.invalid'
    & git -C $newRunnerMissingFieldsRepository config user.name 'HDO Tests'
    '{"schemaVersion":1,"activeProfile":"p","profiles":{"p":{"steps":{"plan":"r","implement":"r","review":"r","fix":"r"}}},"runners":{"r":{"type":"codex","model":"m"}}}' |
        Set-Content -LiteralPath (Join-Path $newRunnerMissingFieldsRepository '.hdo/config.json') -Encoding utf8NoBOM
    Set-Content -LiteralPath (Join-Path $newRunnerMissingFieldsRepository 'README.md') -Value 'baseline' -Encoding utf8NoBOM
    & git -C $newRunnerMissingFieldsRepository add -- '.hdo/config.json' 'README.md'
    & git -C $newRunnerMissingFieldsRepository -c commit.gpgSign=false commit --quiet -m baseline
    $newRunnerMissingFieldsMessage = $null
    try { $null = Get-HdoConfig -RepositoryPath $newRunnerMissingFieldsRepository }
    catch { $newRunnerMissingFieldsMessage = $_.Exception.Message }
    Assert-Hdo ($newRunnerMissingFieldsMessage -eq "Repository runner 'r' is new and must declare provider, sandbox, timeoutSeconds in .hdo/config.json.") 'a new repository runner missing required fields reports which fields are missing'

    $invalidOverrideRejected = $false
    try { $null = Get-HdoConfig -RepositoryPath $repositoryRoot -Overrides @{ unknownRootProperty = $true } }
    catch { $invalidOverrideRejected = $true }
    Assert-Hdo $invalidOverrideRejected 'public configuration overrides remain subject to JSON Schema validation'

    $invalidStepRejected = $false
    try { $null = Get-HdoConfig -RepositoryPath $repositoryRoot -StepOverrides @{ deploy = 'cloud-implementer' } }
    catch { $invalidStepRejected = $true }
    Assert-Hdo $invalidStepRejected 'unknown programmatic step overrides are rejected'

    $plan = Get-HdoExecutionPlan $config
    $providers = @($plan.runners.Values | ForEach-Object { $_.provider } | Sort-Object -Unique)
    Assert-Hdo ($providers.Count -eq 1 -and $providers[0] -eq 'cloud') 'default execution plan does not select Ollama'
    Assert-Hdo (-not $plan.implicitFallback) 'implicit fallback is disabled'

    $legalTransitions = @(
        @('CREATED', 'ISSUE_SELECTED'),
        @('PREFLIGHT', 'ISSUE_CLAIMED'),
        @('PREFLIGHT', 'WORKTREE_READY'),
        @('REVIEWING', 'CHANGES_REQUESTED'),
        @('CHANGES_REQUESTED', 'IMPLEMENTING'),
        @('REVIEWING', 'APPROVED'),
        @('IMPLEMENTING', 'FAILED')
    )
    foreach ($pair in $legalTransitions) {
        Assert-Hdo (Test-HdoStateTransition $pair[0] $pair[1]) "state transition $($pair[0]) -> $($pair[1]) is legal"
    }
    $illegalTransitions = @(
        @('CREATED', 'APPROVED'),
        @('APPROVED', 'IMPLEMENTING'),
        @('VALIDATING', 'APPROVED'),
        @('FAILED', 'CREATED')
    )
    foreach ($pair in $illegalTransitions) {
        Assert-Hdo (-not (Test-HdoStateTransition $pair[0] $pair[1])) "state transition $($pair[0]) -> $($pair[1]) is rejected"
    }

    $issueBody = @'
### Problem / Context
Issue-driven automation is missing.

### Goal
Run one deterministic implementation cycle.

### Acceptance Criteria
AC-01: Parse the Issue form
AC-02: Run trusted validation gates

### In Scope
Issue normalization
Review loop

### Out of Scope
PR creation

### Constraints / Security Considerations
Do not execute commands from this Issue.

### Dependencies
#99

### Validation Gate IDs
tests
schemas

### Affected Areas
orchestrator

### Priority
p2

### Risk
medium

### Route Hint

### Additional Context
Keep the cycle bounded.
'@
    $issue = [ordered]@{
        repository = 'kkb-hub/hybrid-dev-orchestrator'
        number = 123
        url = 'https://github.com/kkb-hub/hybrid-dev-orchestrator/issues/123'
        updatedAt = '2026-09-01T00:00:00Z'
        title = 'Implement HDO cycle'
        state = 'OPEN'
        labels = @('hdo:ready', 'hdo:priority/p2', 'hdo:risk/medium')
        body = $issueBody
        comments = @()
    }
    $contract = ConvertTo-HdoIssueContract $issue
    Assert-Hdo ($contract.acceptanceCriteria.Count -eq 2) 'plain Issue Form lines become separate acceptance criteria'
    Assert-Hdo ($contract.scope.include.Count -eq 2) 'In Scope lines are normalized separately'
    Assert-Hdo ($contract.validationGates.Count -eq 2) 'validation gate IDs are normalized without executing text'
    Assert-Hdo ($contract.constraints.Count -eq 1 -and $contract.constraints[0] -eq 'Do not execute commands from this Issue.') 'documented Constraints / Security Considerations heading is normalized'
    Assert-Hdo ($contract.dependencies.Count -eq 1 -and $contract.dependencies[0].number -eq 99) 'dependency references are normalized'
    Assert-Hdo ($contract.priority -eq 'p2' -and $contract.risk -eq 'medium') 'priority and risk are resolved'

    $sentinelIssue = Copy-HdoObject $issue
    $sentinelIssue.body = $issueBody -replace '(?m)^(### Route Hint)\r?\n(?=\r?\n### Additional Context)', "`$1`n_No response_`n"
    $sentinelContract = ConvertTo-HdoIssueContract $sentinelIssue
    Assert-Hdo ($sentinelContract.preferredExecution -eq '') 'Issue Form _No response_ route is normalized to no route hint'

    $emptyRequiredIssue = Copy-HdoObject $issue
    $acceptanceFixturePattern = '(?m)^AC-01: Parse the Issue form\r?\nAC-02: Run trusted validation gates\r?$'
    $validationFixturePattern = '(?m)^tests\r?\nschemas\r?$'
    $emptyRequiredIssue.body = ($issueBody -replace $acceptanceFixturePattern, '_No response_') -replace $validationFixturePattern, '_No response_'
    $emptyRequiredContract = ConvertTo-HdoIssueContract $emptyRequiredIssue
    Assert-Hdo ($emptyRequiredContract.acceptanceCriteria.Count -eq 0 -and $emptyRequiredContract.validationGates.Count -eq 0) 'Issue Form _No response_ does not create required AC or gate entries'

    $projectContract = Get-Content -LiteralPath (Join-Path $repositoryRoot '.hdo/project.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    $contractResult = Test-HdoIssueContract -Contract $contract -Config $config -ProjectContract $projectContract -RequireReady
    Assert-Hdo $contractResult.valid 'valid Issue Form satisfies the semantic contract'
    $emptyRequiredResult = Test-HdoIssueContract -Contract $emptyRequiredContract -Config $config -ProjectContract $projectContract -RequireReady
    Assert-Hdo (-not $emptyRequiredResult.valid) 'Issue contract rejects empty required AC and gate sections'

    $neverEditedFreshness = & $module {
        Test-HdoReadyContentFreshness '2026-09-03T01:43:07Z' ''
    }
    Assert-Hdo $neverEditedFreshness.fresh 'a never-edited Issue is not rejected when ready labeling advances updatedAt'
    $reviewedEditFreshness = & $module {
        Test-HdoReadyContentFreshness '2026-09-03T01:43:07Z' '2026-09-03T01:43:07Z'
    }
    Assert-Hdo $reviewedEditFreshness.fresh 'an Issue content edit at or before ready remains authorized'
    $staleReadyFreshness = & $module {
        Test-HdoReadyContentFreshness '2026-09-03T01:43:07Z' '2026-09-03T01:43:08Z'
    }
    Assert-Hdo (-not $staleReadyFreshness.fresh) 'an Issue content edit after ready requires re-authorization'
    $invalidEditFreshness = & $module {
        Test-HdoReadyContentFreshness '2026-09-03T01:43:07Z' 'not-a-timestamp'
    }
    Assert-Hdo (-not $invalidEditFreshness.fresh) 'an invalid Issue content edit timestamp fails closed'

    $duplicateAcceptance = Copy-HdoObject $contract
    $duplicateAcceptance.acceptanceCriteria += [ordered]@{ id = 'AC-01'; text = 'A conflicting duplicate id.' }
    $duplicateAcceptanceResult = Test-HdoIssueContract -Contract $duplicateAcceptance -Config $config -ProjectContract $projectContract -RequireReady
    Assert-Hdo (-not $duplicateAcceptanceResult.valid) 'duplicate acceptance criterion IDs are rejected'

    $conflicting = Copy-HdoObject $contract
    $conflicting.issue.labels += @('hdo:status/claimed', 'hdo:status/review')
    $conflictResult = Test-HdoIssueContract -Contract $conflicting -Config $config -ProjectContract $projectContract -RequireReady
    Assert-Hdo (-not $conflictResult.valid) 'multiple lifecycle labels are rejected'

    $unknownGate = Copy-HdoObject $contract
    $unknownGate.validationGates = @('does-not-exist')
    $unknownGateResult = Test-HdoIssueContract -Contract $unknownGate -Config $config -ProjectContract $projectContract -RequireReady
    Assert-Hdo (-not $unknownGateResult.valid) 'unknown validation gate IDs are rejected'

    # Regression coverage for issue #50: `gh issue list ... --json ...` printing the
    # top-level JSON array `[]` (the common "no eligible Issue" case) must not crash
    # `Get-HdoIssueCandidate` / `Invoke-HdoGhJson`'s callers. Without -NoEnumerate,
    # ConvertFrom-Json round-trips "[]" as $null, and `@(Invoke-HdoGhJson ...)` at the call
    # site then wraps that $null into a 1-element array holding $null instead of an empty
    # array, so `foreach ($issue in $issues) { $issue['repository'] = ... }` throws
    # "Cannot index into a null array." on the very first (and only) $null iteration.
    $originalGhPath = $env:PATH
    try {
        $mockGhEmptyDirectory = Join-Path $testAppData 'mock-gh-empty-array'
        New-Item -ItemType Directory -Path $mockGhEmptyDirectory -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $mockGhEmptyDirectory 'gh.cmd') -Value "@echo off`r`necho []`r`nexit /b 0`r`n" -Encoding utf8NoBOM
        $env:PATH = "$mockGhEmptyDirectory;$originalGhPath"
        $emptyCandidatesError = $null
        $emptyCandidates = $null
        try { $emptyCandidates = @(Get-HdoIssueCandidate -Config $config -Repository 'owner/repo-with-no-candidates') }
        catch { $emptyCandidatesError = $_.Exception.Message }
        Assert-Hdo ($null -eq $emptyCandidatesError -and $emptyCandidates.Count -eq 0) 'Get-HdoIssueCandidate returns an empty array instead of crashing when gh issue list prints the empty JSON array []'

        # A single-element JSON array must still come back as a genuine 1-element array
        # (not unrolled to a scalar, and not nested under a spurious extra wrapper) so
        # `@(Invoke-HdoGhJson ...)` callers keep iterating exactly once. This is checked
        # directly against Invoke-HdoGhJson (rather than the full Get-HdoIssueCandidate
        # pipeline) because reaching a real candidate also requires mocking the ready-label
        # authorization and claim-comment gh calls Get-HdoIssueCandidate makes per issue;
        # those are exercised indirectly by test-cli.ps1 / the smoke tests instead.
        $mockGhOneDirectory = Join-Path $testAppData 'mock-gh-one-element-array'
        New-Item -ItemType Directory -Path $mockGhOneDirectory -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $mockGhOneDirectory 'gh.cmd') -Value ('@echo off' + "`r`n" + 'echo [{"number":7,"title":"t"}]' + "`r`n" + 'exit /b 0' + "`r`n") -Encoding utf8NoBOM
        $env:PATH = "$mockGhOneDirectory;$originalGhPath"
        $oneElementResult = @(& $module {
            param($WorkingDirectory)
            Invoke-HdoGhJson @('issue', 'list', '--repo', 'owner/repo', '--state', 'open', '--label', 'hdo:ready', '--limit', '1000', '--json', 'number,title') $WorkingDirectory
        } $repositoryRoot)
        Assert-Hdo ($oneElementResult.Count -eq 1 -and [int]$oneElementResult[0].number -eq 7) 'Invoke-HdoGhJson still returns a genuine 1-element array (not unrolled, not nested) for a single-element gh JSON array'
    }
    finally { $env:PATH = $originalGhPath }

    # R1-1 regression: `Get-HdoIssueCandidate`'s final `Sort-Object` (GitHub.ps1, end of
    # the function) must actually re-sort its candidates by
    # (priorityRank asc, createdAt asc, number asc), not silently pass them through in
    # `gh issue list`'s response order. The candidates flowing through that Sort-Object
    # are always [ordered] dictionaries (ConvertTo-HdoHashtable's own decoding), and a
    # plain calculated-property Sort-Object Expression does not bind against an
    # OrderedDictionary - see the comment on that return statement for the full
    # explanation. `tests/fixtures/cli/gh/issue-list.json` is deliberately NOT listed in
    # the intended output order for exactly this reason, so this exercises a genuine
    # re-order rather than a no-op pass-through.
    #
    # This full round-trip through Get-HdoIssueCandidate (rather than unit-testing
    # Sort-Object in isolation) also has to satisfy contract validation, ready-label
    # authorization, dependency resolution, and claim-comment checks for every fixture
    # issue, so it reuses the same mock `gh` (`tests/fixtures/cli/gh/gh.cmd`, a superset
    # of `tests/fixtures/workflow/gh/gh.cmd` that also answers `issue list`) and
    # supporting fixture data `src/cli/issuesParity.test.ts` uses for its own PS/TS
    # parity coverage of this same function.
    #
    # The config's repository directory is created OUTSIDE this repository (under the
    # OS temp directory, not $testAppData) so `git rev-parse --show-toplevel` fails to
    # find a `.git` there and `Get-HdoConfig` resolves `.hdo/project.json` from that
    # directory itself, instead of walking up and picking up this repository's own
    # (gate-id-incompatible) project contract.
    $orderingCliGhFixtures = Join-Path $repositoryRoot 'tests/fixtures/cli/gh'
    $orderingWorkflowGhFixtures = Join-Path $repositoryRoot 'tests/fixtures/workflow/gh'
    $orderingRepositoryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "hdo-issue-candidate-ordering-$([guid]::NewGuid().ToString('N'))"
    $orderingGhDirectory = Join-Path $testAppData 'mock-gh-issue-candidate-ordering'
    try {
        New-Item -ItemType Directory -Path (Join-Path $orderingRepositoryDirectory '.hdo') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repositoryRoot 'tests/fixtures/workflow/project.json') -Destination (Join-Path $orderingRepositoryDirectory '.hdo/project.json') -Force
        New-Item -ItemType Directory -Path $orderingGhDirectory -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $orderingCliGhFixtures 'gh.cmd') -Destination (Join-Path $orderingGhDirectory 'gh.cmd') -Force
        Copy-Item -LiteralPath (Join-Path $orderingCliGhFixtures 'issue-list.json') -Destination (Join-Path $orderingGhDirectory 'issue-list.json') -Force
        Copy-Item -LiteralPath (Join-Path $orderingWorkflowGhFixtures 'issue-events.json') -Destination (Join-Path $orderingGhDirectory 'issue-events.json') -Force
        Copy-Item -LiteralPath (Join-Path $orderingWorkflowGhFixtures 'issue-comments.json') -Destination (Join-Path $orderingGhDirectory 'issue-comments.json') -Force
        Copy-Item -LiteralPath (Join-Path $orderingWorkflowGhFixtures 'graphql-last-edited.json') -Destination (Join-Path $orderingGhDirectory 'graphql-last-edited.json') -Force

        $env:PATH = "$orderingGhDirectory;$originalGhPath"
        $orderingConfig = Get-HdoConfig -RepositoryPath $orderingRepositoryDirectory
        Assert-Hdo (-not $orderingConfig.repositoryConfig.loaded) 'Get-HdoIssueCandidate ordering fixture repository is resolved on its own (outside the real repository) so it picks up the fixture project contract'
        $orderedCandidates = @(Get-HdoIssueCandidate -Config $orderingConfig -Repository 'hdo-fixture/repo')
        $orderedNumbers = @($orderedCandidates | ForEach-Object { [int]$_.number }) -join ','
        Assert-Hdo ($orderedNumbers -eq '103,102,101') "Get-HdoIssueCandidate re-sorts candidates by (priorityRank asc, createdAt asc, number asc) instead of passing gh issue list's (out-of-order) response order through unchanged (R1-1). Got: $orderedNumbers"
    }
    finally {
        $env:PATH = $originalGhPath
        if (Test-Path -LiteralPath $orderingRepositoryDirectory) { Remove-Item -LiteralPath $orderingRepositoryDirectory -Recurse -Force }
    }

    # Regression coverage for review finding B-4: without -NoEnumerate, ConvertFrom-HdoJson
    # must be a true drop-in for ConvertFrom-Json, i.e. a multi-element top-level JSON array
    # comes back as a genuine multi-element array (not re-wrapped as a single nested array).
    $multiElementArrayResult = @(& $module { param($Json) ConvertFrom-HdoJson -Json $Json } '[1,2]')
    Assert-Hdo ($multiElementArrayResult.Count -eq 2) 'ConvertFrom-HdoJson without -NoEnumerate returns a genuine 2-element array for a multi-element JSON array, matching ConvertFrom-Json (issue B-4)'
    # R2-1: with -NoEnumerate a JSON object / scalar / null must come back bare, not
    # wrapped in a 1-element collection (the caller-facing shape of ConvertFrom-Json).
    $noEnumerateObject = & $module { param($Json) $v = ConvertFrom-HdoJson -Json $Json -NoEnumerate; return [pscustomobject]@{ isCollection = ($v -is [System.Collections.IEnumerable] -and $v -isnot [string]); a = $v.a } } '{"a":1}'
    Assert-Hdo ((-not $noEnumerateObject.isCollection) -and $noEnumerateObject.a -eq 1) 'ConvertFrom-HdoJson -NoEnumerate returns a JSON object bare (not wrapped in a collection)'
    $noEnumerateScalar = & $module { param($Json) $v = ConvertFrom-HdoJson -Json $Json -NoEnumerate; return [pscustomobject]@{ type = $v.GetType().Name; value = $v } } '7'
    Assert-Hdo ($noEnumerateScalar.type -in @('Int64', 'Int32') -and $noEnumerateScalar.value -eq 7) 'ConvertFrom-HdoJson -NoEnumerate returns a JSON scalar bare'
    $noEnumerateArray = & $module { param($Json) $v = ConvertFrom-HdoJson -Json $Json -NoEnumerate; return [pscustomobject]@{ count = $v.Count; isArray = ($v -is [array]) } } '[1,2]'
    Assert-Hdo ($noEnumerateArray.isArray -and $noEnumerateArray.count -eq 2) 'ConvertFrom-HdoJson -NoEnumerate returns a two-element array as one bare array'

    # Regression coverage for issue #62: ConvertFrom-Json converts every ISO-8601-shaped
    # string value to [DateTime] regardless of field name, and a value with a numeric
    # offset (the shape Get-HdoUtcTimestamp produced before #62) round-trips through
    # ConvertTo-Json in the LOCAL time zone with fewer fractional digits. Read-HdoJsonFile /
    # Write-HdoJsonFile's read-modify-write cycle must preserve such strings byte for byte.
    $dateRoundTripPath = Join-Path $testAppData 'date-roundtrip.json'
    '{"t":"2026-01-01T00:00:00.0000000+00:00","u":"2026-01-01T00:00:00.1234567Z","v":"2026-01-01T00:00:00Z"}' |
        Set-Content -LiteralPath $dateRoundTripPath -Encoding utf8NoBOM
    $dateRoundTripValue = & $module { param($Path) Read-HdoJsonFile $Path } $dateRoundTripPath
    & $module { param($Path, $Value) Write-HdoJsonFile $Path $Value } $dateRoundTripPath $dateRoundTripValue
    $dateRoundTripText = Get-Content -LiteralPath $dateRoundTripPath -Raw
    Assert-Hdo ($dateRoundTripText -match [regex]::Escape('2026-01-01T00:00:00.0000000+00:00')) 'Read-HdoJsonFile/Write-HdoJsonFile preserve a numeric-offset timestamp byte for byte across a read-modify-write cycle (issue #62)'
    Assert-Hdo ($dateRoundTripText -match [regex]::Escape('2026-01-01T00:00:00.1234567Z')) 'Read-HdoJsonFile/Write-HdoJsonFile preserve a Z-suffixed timestamp with 7 fractional digits byte for byte (issue #62)'
    Assert-Hdo ($dateRoundTripText -match [regex]::Escape('2026-01-01T00:00:00Z')) 'Read-HdoJsonFile/Write-HdoJsonFile preserve a Z-suffixed timestamp with no fractional digits byte for byte (issue #62)'

    $badConfig = Copy-HdoObject $config
    $badConfig.steps.review = 'claude-implementer'
    $badConfigResult = Test-HdoConfiguration $badConfig
    Assert-Hdo (-not $badConfigResult.valid) 'review cannot use a workspace-write runner'

    $claudeContextConfig = Copy-HdoObject $config
    $claudeContextConfig.runners['claude-planner'].contextTokens = 8192
    $claudeContextResult = Test-HdoConfiguration $claudeContextConfig
    Assert-Hdo (-not $claudeContextResult.valid) 'Claude cloud runner rejects unsupported contextTokens configuration'

    $claudeOllamaContextConfig = Copy-HdoObject $config
    $claudeOllamaContextConfig.runners['claude-implementer'].provider = 'ollama'
    $claudeOllamaContextConfig.runners['claude-implementer'].model = 'qwen3.8:27b-q4_K_M'
    $claudeOllamaContextConfig.runners['claude-implementer'].reasoningEffort = ''
    $claudeOllamaContextConfig.runners['claude-implementer'].contextTokens = 65536
    $claudeOllamaContextResult = Test-HdoConfiguration $claudeOllamaContextConfig
    Assert-Hdo $claudeOllamaContextResult.valid 'Claude/Ollama runner accepts contextTokens now that HDO enforces it via a derived local model'

    # The CLI withholds 23000 tokens of the declared window before it will send anything, so
    # values under the floor fail every step with 'Prompt is too long' rather than merely
    # compacting more often. Measured: 32768/40960/49152 all fail a trivial read; 57344 works.
    $claudeOllamaLowContextConfig = Copy-HdoObject $claudeOllamaContextConfig
    $claudeOllamaLowContextConfig.runners['claude-implementer'].contextTokens = 32768
    $claudeOllamaLowContextResult = Test-HdoConfiguration $claudeOllamaLowContextConfig
    Assert-Hdo (-not $claudeOllamaLowContextResult.valid) 'Claude/Ollama runner rejects a contextTokens below the usable floor instead of failing every step at runtime'
    Assert-Hdo (@(@($claudeOllamaLowContextResult.errors) -match 'below the usable floor of 57344').Count -gt 0) 'the contextTokens floor error explains the Claude CLI reserve that causes it'
    $claudeOllamaFloorConfig = Copy-HdoObject $claudeOllamaContextConfig
    $claudeOllamaFloorConfig.runners['claude-implementer'].contextTokens = 57344
    Assert-Hdo (Test-HdoConfiguration $claudeOllamaFloorConfig).valid 'the smallest contextTokens measured to work is accepted'
    # Codex sizes its own window through --config model_context_window and has no such reserve.
    $codexLowContextConfig = Copy-HdoObject $claudeOllamaContextConfig
    $codexLowContextConfig.runners['claude-implementer'].type = 'codex'
    $codexLowContextConfig.runners['claude-implementer'].provider = 'cloud'
    $codexLowContextConfig.runners['claude-implementer'].contextTokens = 8192
    Assert-Hdo (Test-HdoConfiguration $codexLowContextConfig).valid 'the Claude/Ollama contextTokens floor does not constrain Codex runners'

    $claudeEffortConfig = Copy-HdoObject $config
    $claudeEffortConfig.runners['claude-planner'].reasoningEffort = 'ultra'
    $claudeEffortResult = Test-HdoConfiguration $claudeEffortConfig
    Assert-Hdo (-not $claudeEffortResult.valid) 'Claude runner rejects effort values the Claude CLI would silently ignore'

    $claudeExtraArgsConfig = Copy-HdoObject $config
    $claudeExtraArgsConfig.runners['claude-planner'].extraArgs = @('--mcp-config', 'servers.json')
    $claudeExtraArgsResult = Test-HdoConfiguration $claudeExtraArgsConfig
    Assert-Hdo (-not $claudeExtraArgsResult.valid) 'Claude runner rejects extraArgs so isolation flags cannot be bypassed'

    $claudeWriteArguments = & $module {
        param($Runner)
        Get-HdoClaudeArguments -Runner $Runner -SchemaJson '{}'
    } ([ordered]@{ sandbox = 'workspace-write'; model = 'opus'; reasoningEffort = 'HIGH'; allowedTools = @('Read', 'Bash'); extraArgs = @() })
    $effortIndex = [Array]::IndexOf($claudeWriteArguments, '--effort')
    Assert-Hdo ($effortIndex -ge 0 -and $claudeWriteArguments[$effortIndex + 1] -ceq 'high') 'reasoningEffort is passed to --effort in canonical lowercase'
    Assert-Hdo ($claudeWriteArguments -contains '--safe-mode') 'Claude adapter disables user customizations with --safe-mode'
    $permissionModeIndex = [Array]::IndexOf($claudeWriteArguments, '--permission-mode')
    Assert-Hdo ($permissionModeIndex -ge 0 -and $claudeWriteArguments[$permissionModeIndex + 1] -eq 'acceptEdits') 'workspace-write maps to the acceptEdits permission mode'
    $allowedToolsIndex = [Array]::IndexOf($claudeWriteArguments, '--allowedTools')
    Assert-Hdo ($allowedToolsIndex -ge 0 -and $claudeWriteArguments[$allowedToolsIndex + 1] -eq 'Read,Bash') 'allowedTools is passed as the --allowedTools permission allowlist, not --tools'
    Assert-Hdo ($claudeWriteArguments -notcontains '--tools') 'Claude adapter does not use the ambiguous --tools flag'
    $ollamaClaudeArguments = & $module {
        param($Runner)
        Get-HdoClaudeArguments -Runner $Runner -SchemaJson '{"type":"object"}'
    } ([ordered]@{ sandbox = 'workspace-write'; type = 'claude'; provider = 'ollama'; model = 'qwen3.8:27b-q4_K_M'; reasoningEffort = 'medium'; extraArgs = @() })
    Assert-Hdo ($ollamaClaudeArguments -notcontains '--json-schema' -and $ollamaClaudeArguments -notcontains '--effort') 'Claude/Ollama route avoids SDK options that reject arbitrary local model IDs'
    $ollamaToolsIndex = [Array]::IndexOf($ollamaClaudeArguments, '--tools')
    Assert-Hdo ($ollamaToolsIndex -ge 0 -and $ollamaClaudeArguments[$ollamaToolsIndex + 1] -eq 'Read,Write,Edit,Glob,Grep') 'Claude/Ollama implementation exposes only bounded file tools and structurally removes shell execution'
    $ollamaReadOnlyArguments = & $module {
        param($Runner)
        Get-HdoClaudeArguments -Runner $Runner -SchemaJson '{"type":"object"}'
    } ([ordered]@{ sandbox = 'read-only'; type = 'claude'; provider = 'ollama'; model = 'qwen3.8:27b-q4_K_M'; extraArgs = @() })
    $ollamaReadOnlyToolsIndex = [Array]::IndexOf($ollamaReadOnlyArguments, '--tools')
    Assert-Hdo ($ollamaReadOnlyToolsIndex -ge 0 -and $ollamaReadOnlyArguments[$ollamaReadOnlyToolsIndex + 1] -eq 'Read,Glob,Grep') 'Claude/Ollama read-only runner does not expose file-editing tools'

    $contextModelName = & $module {
        param($Model, $ContextTokens)
        Get-HdoOllamaContextModelName -Model $Model -ContextTokens $ContextTokens
    } 'qwen3.8:27b-q4_K_M' 65536
    Assert-Hdo ($contextModelName -match '^hdo-ctx-qwen3\.8-27b-q4_K_M-[0-9a-f]{8}-65536$') 'Get-HdoOllamaContextModelName sanitizes the model ID into a deterministic derived model tag'
    $contextModelNameRepeat = & $module {
        param($Model, $ContextTokens)
        Get-HdoOllamaContextModelName -Model $Model -ContextTokens $ContextTokens
    } 'qwen3.8:27b-q4_K_M' 65536
    Assert-Hdo ($contextModelName -eq $contextModelNameRepeat) 'Get-HdoOllamaContextModelName is deterministic for the same model and contextTokens'
    $collidingContextModelName = & $module {
        param($Model, $ContextTokens)
        Get-HdoOllamaContextModelName -Model $Model -ContextTokens $ContextTokens
    } 'qwen3.8-27b-q4_K_M' 65536
    Assert-Hdo (([regex]::Replace('qwen3.8:27b-q4_K_M', '[^a-zA-Z0-9._-]', '-')) -eq 'qwen3.8-27b-q4_K_M') 'test fixture sanity check: the two model IDs below sanitize to the identical text'
    Assert-Hdo ($contextModelName -ne $collidingContextModelName) 'Get-HdoOllamaContextModelName keeps model IDs that sanitize to the same text from colliding on the same derived model'

    $modelOverrideArguments = & $module {
        param($Runner, $ModelOverride)
        Get-HdoClaudeArguments -Runner $Runner -SchemaJson '{"type":"object"}' -ModelOverride $ModelOverride
    } ([ordered]@{ sandbox = 'workspace-write'; type = 'claude'; provider = 'ollama'; model = 'qwen3.8:27b-q4_K_M'; extraArgs = @() }) $contextModelName
    $modelOverrideIndex = [Array]::IndexOf($modelOverrideArguments, '--model')
    Assert-Hdo ($modelOverrideIndex -ge 0 -and $modelOverrideArguments[$modelOverrideIndex + 1] -eq $contextModelName) 'Get-HdoClaudeArguments passes the derived context model instead of the configured model when overridden'

    $originalOllamaPath = $env:PATH
    try {
        $mockOllamaSuccessDirectory = Join-Path $testAppData 'mock-ollama-success'
        New-Item -ItemType Directory -Path $mockOllamaSuccessDirectory -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $mockOllamaSuccessDirectory 'ollama.cmd') -Value "@echo off`r`nexit /b 0`r`n" -Encoding utf8NoBOM
        $env:PATH = "$mockOllamaSuccessDirectory;$originalOllamaPath"
        $resolvedContextModel = & $module {
            param($Model, $ContextTokens, $WorkingDirectory)
            Resolve-HdoOllamaContextModel -Model $Model -ContextTokens $ContextTokens -WorkingDirectory $WorkingDirectory -TimeoutSeconds 60
        } 'qwen3.8:27b-q4_K_M' 65536 $repositoryRoot
        Assert-Hdo ($resolvedContextModel -eq $contextModelName) 'Resolve-HdoOllamaContextModel returns the derived model name after ollama create succeeds'

        $mockOllamaFailureDirectory = Join-Path $testAppData 'mock-ollama-failure'
        New-Item -ItemType Directory -Path $mockOllamaFailureDirectory -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $mockOllamaFailureDirectory 'ollama.cmd') -Value "@echo off`r`necho Error: model requires more system memory than is available 1>&2`r`nexit /b 1`r`n" -Encoding utf8NoBOM
        $env:PATH = "$mockOllamaFailureDirectory;$originalOllamaPath"
        $resolveContextModelError = $null
        try {
            & $module {
                param($Model, $ContextTokens, $WorkingDirectory)
                Resolve-HdoOllamaContextModel -Model $Model -ContextTokens $ContextTokens -WorkingDirectory $WorkingDirectory -TimeoutSeconds 60
            } 'qwen3.8:27b-q4_K_M' 65536 $repositoryRoot
        }
        catch { $resolveContextModelError = $_.Exception.Message }
        Assert-Hdo ($resolveContextModelError -match 'model requires more system memory') 'Resolve-HdoOllamaContextModel surfaces the ollama create failure instead of failing silently'
    }
    finally { $env:PATH = $originalOllamaPath }

    # Regression coverage for issue #35: PowerShell's Get-Command provider resolution
    # order returns an ExternalScript (.ps1) before a sibling Application (.cmd/.exe) on
    # the same PATH entry, which is exactly the layout an npm-global install leaves for
    # `claude` / `codex` (<name>, <name>.cmd, <name>.ps1 all present). Invoke-HdoProcess
    # cannot start a .ps1 via ProcessStartInfo, and doctor's runner check used to report
    # such a runner as present anyway. -CommandType Application must resolve to the
    # launchable .cmd shim instead, and Invoke-HdoProcess must run it successfully.
    $originalShimPath = $env:PATH
    try {
        $shimBothDirectory = Join-Path $testAppData 'hdo-shim-probe-both'
        New-Item -ItemType Directory -Path $shimBothDirectory -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $shimBothDirectory 'hdo-shim-probe.ps1') -Value "throw 'ps1 must not run'`r`n" -Encoding utf8NoBOM
        Set-Content -LiteralPath (Join-Path $shimBothDirectory 'hdo-shim-probe.cmd') -Value "@echo off`r`necho cmd-ok`r`nexit /b 0`r`n" -Encoding utf8NoBOM
        $env:PATH = "$shimBothDirectory;$originalShimPath"

        # AC-03: a bare command name that resolves to a `.ps1` + `.cmd` pair must run the
        # `.cmd` and return a bounded, successful result instead of throwing.
        $shimProcessError = $null
        $shimProcessResult = $null
        try {
            $shimProcessResult = & $module {
                param($WorkingDirectory)
                Invoke-HdoProcess -Command 'hdo-shim-probe' -WorkingDirectory $WorkingDirectory -TimeoutSeconds 30
            } $repositoryRoot
        }
        catch { $shimProcessError = $_.Exception.Message }
        Assert-Hdo ($null -eq $shimProcessError -and $shimProcessResult.exitCode -eq 0 -and $shimProcessResult.stdout.Trim() -eq 'cmd-ok') 'Invoke-HdoProcess runs the .cmd shim instead of the .ps1 that Get-Command would otherwise prefer (AC-03)'

        # AC-02: doctor's runner check must still pass (the runner is genuinely launchable
        # via its .cmd shim) but also surface the existing batch-shim warning.
        $shimDoctorConfig = Copy-HdoObject $config
        $shimDoctorConfig.runners['claude-planner'].command = 'hdo-shim-probe'
        $shimDoctorResult = Test-HdoEnvironment -Config $shimDoctorConfig -ReadOnly
        $shimPlannerCheck = @($shimDoctorResult.checks | Where-Object name -eq 'runner:claude-planner')
        $shimWarningCheck = @($shimDoctorResult.checks | Where-Object name -eq 'runner:claude-planner:shim')
        Assert-Hdo ($shimPlannerCheck.Count -eq 1 -and $shimPlannerCheck[0].status -eq 'pass') 'doctor reports a runner resolved to its .cmd shim as pass, not silently launchable-but-wrong (AC-02)'
        Assert-Hdo ($shimWarningCheck.Count -eq 1 -and $shimWarningCheck[0].status -eq 'warning') 'doctor still emits the existing batch-shim warning for a runner resolved via -CommandType Application (AC-02)'

        # AC-01 / AC-04: a directory that has only the `.ps1` (no `.cmd`/`.exe` sibling)
        # must be treated as not found, both by Invoke-HdoProcess and by doctor.
        $shimPs1OnlyDirectory = Join-Path $testAppData 'hdo-shim-probe-ps1-only'
        New-Item -ItemType Directory -Path $shimPs1OnlyDirectory -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $shimPs1OnlyDirectory 'hdo-ps1-only.ps1') -Value "throw 'ps1 must not run'`r`n" -Encoding utf8NoBOM
        $env:PATH = "$shimPs1OnlyDirectory;$originalShimPath"

        $ps1OnlyProcessError = $null
        try {
            $null = & $module {
                param($WorkingDirectory)
                Invoke-HdoProcess -Command 'hdo-ps1-only' -WorkingDirectory $WorkingDirectory -TimeoutSeconds 30
            } $repositoryRoot
        }
        catch { $ps1OnlyProcessError = $_.Exception.Message }
        Assert-Hdo ($ps1OnlyProcessError -eq 'Command was not found: hdo-ps1-only') 'Invoke-HdoProcess treats a .ps1-only resolution as not found rather than trying to launch it (AC-01)'

        $ps1OnlyDoctorConfig = Copy-HdoObject $config
        $ps1OnlyDoctorConfig.runners['claude-planner'].command = 'hdo-ps1-only'
        $ps1OnlyDoctorResult = Test-HdoEnvironment -Config $ps1OnlyDoctorConfig -ReadOnly
        $ps1OnlyPlannerCheck = @($ps1OnlyDoctorResult.checks | Where-Object name -eq 'runner:claude-planner')
        Assert-Hdo ($ps1OnlyPlannerCheck.Count -eq 1 -and $ps1OnlyPlannerCheck[0].status -eq 'fail') 'doctor no longer false-passes a runner that only resolves to a non-launchable .ps1 (AC-04)'
    }
    finally { $env:PATH = $originalShimPath }

    # Regression coverage for issue #8: doctor checked runner commands but never
    # validationGates[].command, so a gate whose command cannot be started sailed
    # through preflight and only surfaced as a confusing failure at run time.
    # The overall `ok` flag also depends on unrelated environmental checks (e.g.
    # github:authentication, which fails on a machine where `gh auth login` was never
    # run). Rather than assert on `.ok` directly, compare the set of *required* failures
    # before/after the new gate:<id> checks are added: since they are always
    # required=false, they must never change that set.
    $defaultDoctorResult = Test-HdoEnvironment -Config $config -ReadOnly
    $gateTestsCheck = @($defaultDoctorResult.checks | Where-Object name -eq 'gate:tests')
    $gateSchemasCheck = @($defaultDoctorResult.checks | Where-Object name -eq 'gate:schemas')
    Assert-Hdo ($gateTestsCheck.Count -eq 1 -and $gateTestsCheck[0].status -eq 'pass' -and $gateTestsCheck[0].required -eq $false) "doctor reports gate:tests as a non-required pass when its command (pwsh) resolves (issue #8; got: $($gateTestsCheck | ConvertTo-Json -Compress))"
    Assert-Hdo ($gateSchemasCheck.Count -eq 1 -and $gateSchemasCheck[0].status -eq 'pass') 'doctor reports gate:schemas as pass when its command resolves (issue #8)'
    $defaultRequiredFailureNames = @($defaultDoctorResult.checks | Where-Object { $_.required -and $_.status -eq 'fail' } | ForEach-Object { $_.name }) | Sort-Object

    $bogusGateProjectPath = Join-Path $testAppData 'hdo-bogus-gate-project.json'
    $bogusGateProject = Copy-HdoObject (& $module { param($Config) Get-HdoProjectContract $Config } $config)
    $bogusGateProject.validationGates = @([ordered]@{
        id = 'bogus'
        command = 'hdo-gate-command-that-does-not-exist'
        args = @()
        workingDirectory = '.'
        timeoutSeconds = 30
        required = $true
        exitCodes = [ordered]@{ passed = @(0); failed = @(1); indeterminate = @(2, 124, 125, 126, 127) }
        continueAfterFailure = $true
    })
    $bogusGateProject | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $bogusGateProjectPath -Encoding utf8NoBOM
    $bogusGateConfig = Copy-HdoObject $config
    $bogusGateConfig.projectContractPath = $bogusGateProjectPath
    $bogusGateDoctorResult = Test-HdoEnvironment -Config $bogusGateConfig -ReadOnly
    $bogusGateCheck = @($bogusGateDoctorResult.checks | Where-Object name -eq 'gate:bogus')
    Assert-Hdo ($bogusGateCheck.Count -eq 1 -and $bogusGateCheck[0].status -eq 'warning' -and $bogusGateCheck[0].required -eq $false) "doctor reports an unresolvable gate command as a non-required warning, not a hard failure, so #16's runtime setup-failure guard stays reachable (issue #8; got: $($bogusGateCheck | ConvertTo-Json -Compress))"
    $bogusRequiredFailureNames = @($bogusGateDoctorResult.checks | Where-Object { $_.required -and $_.status -eq 'fail' } | ForEach-Object { $_.name }) | Sort-Object
    Assert-Hdo ((@($defaultRequiredFailureNames) -join ',') -eq (@($bogusRequiredFailureNames) -join ',')) 'a warning-level gate:<id> check for an unresolvable command introduces no new required failure, so it never flips overall preflight ok to false (issue #8, §7 Q1)'

    $ollamaClaudeInput = & $module {
        param($Runner)
        Get-HdoClaudeInputText -Runner $Runner -Prompt 'work' -SchemaJson '{"type":"object"}'
    } ([ordered]@{ provider = 'ollama' })
    Assert-Hdo ($ollamaClaudeInput -match 'work' -and $ollamaClaudeInput -match 'Return only one JSON object' -and $ollamaClaudeInput -match '"type":"object"') 'Claude/Ollama route embeds the transport schema into the local prompt'
    Assert-Hdo ($ollamaClaudeInput -match 'Do not use a shell' -and $ollamaClaudeInput -match 'HDO runs trusted validation gates') 'Claude/Ollama prompt keeps shell and validation work in the orchestrator'
    $ollamaClaudeEnvironment = & $module {
        param($Runner)
        Get-HdoRunnerEnvironment -Runner $Runner
    } ([ordered]@{
        type = 'claude'
        provider = 'ollama'
        passEnvironment = @()
    })
    Assert-Hdo ($ollamaClaudeEnvironment.ANTHROPIC_BASE_URL -eq 'http://127.0.0.1:11434') 'Claude/Ollama route is pinned to the loopback Ollama Anthropic endpoint'
    Assert-Hdo ($ollamaClaudeEnvironment.ANTHROPIC_AUTH_TOKEN -eq 'ollama' -and $ollamaClaudeEnvironment.ANTHROPIC_API_KEY -eq '') 'Claude/Ollama route uses local non-secret authentication instead of Anthropic credentials'
    Assert-Hdo ($ollamaClaudeEnvironment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -eq '1') 'Claude/Ollama route disables nonessential Claude CLI traffic'
    Assert-Hdo (-not $ollamaClaudeEnvironment.Contains('CLAUDE_CODE_MAX_CONTEXT_TOKENS')) 'Claude/Ollama route leaves the context window undeclared when the runner sets no contextTokens'
    $ollamaClaudeContextEnvironment = & $module {
        param($Runner)
        Get-HdoRunnerEnvironment -Runner $Runner
    } ([ordered]@{
        type = 'claude'
        provider = 'ollama'
        contextTokens = 65536
        passEnvironment = @()
    })
    # Without this the CLI assumes 200000 tokens for an unrecognized model id and only
    # compacts near that, so a long agentic run always outgrows the smaller local window
    # first and dies as an Ollama 'no user query found in messages' 500.
    Assert-Hdo ($ollamaClaudeContextEnvironment.CLAUDE_CODE_MAX_CONTEXT_TOKENS -eq '65536') 'Claude/Ollama route declares contextTokens as the CLI context window so auto-compaction fires below the Ollama limit'

    # Get-HdoSafeEnvironment forwards every non-secret ambient variable, and anyone
    # debugging this route is exactly the person likely to have exported this one by hand.
    # The runner definition, not the operator's shell, has to decide the window.
    $originalMaxContextTokens = $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS
    try {
        $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = '4096'
        $inheritedContextEnvironment = & $module {
            param($Runner)
            Get-HdoRunnerEnvironment -Runner $Runner
        } ([ordered]@{ type = 'claude'; provider = 'ollama'; passEnvironment = @() })
        Assert-Hdo (-not $inheritedContextEnvironment.Contains('CLAUDE_CODE_MAX_CONTEXT_TOKENS')) 'an inherited context window is stripped from a Claude/Ollama runner that declares no contextTokens'
        $overriddenContextEnvironment = & $module {
            param($Runner)
            Get-HdoRunnerEnvironment -Runner $Runner
        } ([ordered]@{ type = 'claude'; provider = 'ollama'; contextTokens = 65536; passEnvironment = @() })
        Assert-Hdo ($overriddenContextEnvironment.CLAUDE_CODE_MAX_CONTEXT_TOKENS -eq '65536') 'the runner contextTokens wins over an inherited context window'
        # Only the Ollama route is HDO's to pin. HDO does not fix a cloud runner's endpoint
        # either, so a gateway-backed cloud runner behind an unrecognized model id keeps its
        # operator-declared window -- contextTokens is a hard error there, leaving no
        # in-config alternative.
        $cloudInheritedEnvironment = & $module {
            param($Runner)
            Get-HdoRunnerEnvironment -Runner $Runner
        } ([ordered]@{ type = 'claude'; provider = 'cloud'; passEnvironment = @() })
        Assert-Hdo ($cloudInheritedEnvironment.CLAUDE_CODE_MAX_CONTEXT_TOKENS -eq '4096') 'cloud Claude runners keep an operator-declared context window that HDO has no configuration path to express'
    }
    finally { $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = $originalMaxContextTokens }
    $claudeReadArguments = & $module {
        param($Runner)
        Get-HdoClaudeArguments -Runner $Runner -SchemaJson '{}'
    } ([ordered]@{ sandbox = 'read-only'; extraArgs = @('--injected-extra-argument') })
    $readPermissionIndex = [Array]::IndexOf($claudeReadArguments, '--permission-mode')
    Assert-Hdo ($readPermissionIndex -ge 0 -and $claudeReadArguments[$readPermissionIndex + 1] -eq 'plan') 'read-only maps to the plan permission mode'
    Assert-Hdo ($claudeReadArguments -notcontains '--injected-extra-argument') 'the Claude adapter never forwards extraArgs, even from an unvalidated runner'

    $ollamaClaudeEffortConfig = Copy-HdoObject $config
    $ollamaClaudeEffortConfig.runners['claude-implementer'].provider = 'ollama'
    $ollamaClaudeEffortConfig.runners['claude-implementer'].model = 'qwen3.8:27b-q4_K_M'
    $ollamaClaudeEffortConfig.runners['claude-implementer'].reasoningEffort = 'medium'
    $ollamaClaudeEffortResult = Test-HdoConfiguration $ollamaClaudeEffortConfig
    Assert-Hdo (-not $ollamaClaudeEffortResult.valid) 'Claude/Ollama runner rejects cloud-only reasoningEffort configuration'

    $normalizedReviewJson = ''
    foreach ($claudeSchemaName in @('task-contract', 'worker-result', 'review-result')) {
        $normalizedSchemaJson = & $module { param($Path) ConvertTo-HdoClaudeJsonSchema $Path } (Join-Path $repositoryRoot "schemas/$claudeSchemaName.schema.json")
        Assert-Hdo ($normalizedSchemaJson -notmatch '"\$schema"' -and $normalizedSchemaJson -notmatch '"minContains"') "Claude-normalized $claudeSchemaName schema drops `$schema and default minContains"
        $normalizedSchemaObject = $normalizedSchemaJson | ConvertFrom-Json -AsHashtable -Depth 100
        # The Anthropic API rejects tools[].custom.input_schema with a 400 when the
        # document root carries oneOf/allOf/anyOf, even though the CLI's own Ajv strict
        # mode accepts it (regression coverage for the review-result 400: issue #21).
        Assert-Hdo (-not ($normalizedSchemaObject.Contains('oneOf') -or $normalizedSchemaObject.Contains('allOf') -or $normalizedSchemaObject.Contains('anyOf'))) "Claude-normalized $claudeSchemaName schema has no top-level oneOf/allOf/anyOf"
        if ($claudeSchemaName -eq 'review-result') { $normalizedReviewJson = $normalizedSchemaJson }
    }
    $normalizedReview = $normalizedReviewJson | ConvertFrom-Json -AsHashtable -Depth 100
    Assert-Hdo ([string]$normalizedReview.properties.findings.items.'$ref' -eq '#/$defs/finding') 'Claude-normalized review schema keeps referencing the finding definition'
    Assert-Hdo ([string]$normalizedReview.'$defs'.finding.allOf[0].if.properties.actionable.const -eq $true) 'Claude schema normalization keeps nested (non-root) composition under $defs'
    $normalizedReviewSchemaPath = Join-Path $testAppData 'claude-review-result.schema.json'
    Set-Content -LiteralPath $normalizedReviewSchemaPath -Value $normalizedReviewJson -Encoding utf8NoBOM
    $validReviewJson = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tests/fixtures/schema/review.valid.json') -Raw
    Assert-Hdo ([bool]($validReviewJson | Test-Json -SchemaFile $normalizedReviewSchemaPath -ErrorAction SilentlyContinue)) 'valid review fixture passes the Claude-normalized schema'
    # Dropping the root allOf from the transport copy trades away its guidance to the
    # model, not enforcement: the adapter re-validates the final output against the
    # untouched canonical schema (Test-HdoJsonSchema, tests/test-schemas.ps1), which still
    # rejects these fixtures.

    $arrayKeywordSchemaPath = Join-Path $testAppData 'claude-array-keyword.schema.json'
    Set-Content -LiteralPath $arrayKeywordSchemaPath -Encoding utf8NoBOM -Value (@'
{"type":"object","properties":{"tags":{"minItems":1,"uniqueItems":true}}}
'@)
    $normalizedArrayKeyword = (& $module { param($Path) ConvertTo-HdoClaudeJsonSchema $Path } $arrayKeywordSchemaPath) | ConvertFrom-Json -AsHashtable -Depth 100
    Assert-Hdo ([string]$normalizedArrayKeyword.properties.tags.type -eq 'array') 'Claude schema normalization adds the explicit array type strict mode requires'

    # const/enum/default hold data values, not schemas; normalization must never rewrite
    # them or the CLI's structured output would fail re-validation against the canonical schema.
    $dataKeywordSchemaPath = Join-Path $testAppData 'claude-data-keyword.schema.json'
    Set-Content -LiteralPath $dataKeywordSchemaPath -Encoding utf8NoBOM -Value (@'
{"type":"object","properties":{"x":{"enum":[{"$schema":"literal","minItems":1}],"default":{"minContains":1}}}}
'@)
    $normalizedDataKeyword = (& $module { param($Path) ConvertTo-HdoClaudeJsonSchema $Path } $dataKeywordSchemaPath) | ConvertFrom-Json -AsHashtable -Depth 100
    $enumLiteral = $normalizedDataKeyword.properties.x.enum[0]
    Assert-Hdo ([string]$enumLiteral['$schema'] -eq 'literal' -and [int]$enumLiteral.minItems -eq 1 -and -not $enumLiteral.Contains('type')) 'Claude schema normalization leaves enum data values untouched'
    Assert-Hdo ([int]$normalizedDataKeyword.properties.x.default.minContains -eq 1 -and -not $normalizedDataKeyword.properties.x.default.Contains('type')) 'Claude schema normalization leaves default data values untouched'

    $codexSchemas = @{}
    foreach ($codexSchemaName in @('task-contract', 'worker-result', 'review-result')) {
        $normalizedSchemaJson = & $module { param($Path) ConvertTo-HdoCodexJsonSchema $Path } (Join-Path $repositoryRoot "schemas/$codexSchemaName.schema.json")
        $codexSchemas[$codexSchemaName] = $normalizedSchemaJson | ConvertFrom-Json -AsHashtable -Depth 100
        Assert-Hdo ($normalizedSchemaJson -notmatch '"\$schema"|"allOf"|"oneOf"|"if"|"then"|"contains"') "Codex-normalized $codexSchemaName schema drops unsupported Structured Outputs keywords"
        Assert-Hdo ([string]$codexSchemas[$codexSchemaName].properties.schemaVersion.type -eq 'integer') "Codex-normalized $codexSchemaName schema infers the integer const type"
    }
    Assert-Hdo ([string]$codexSchemas['review-result'].properties.decision.type -eq 'string') 'Codex schema normalization infers string enum types'
    Assert-Hdo ($codexSchemas['review-result'].required -contains 'escalationReason') 'Codex review schema requires every root property'
    Assert-Hdo (@($codexSchemas['review-result'].properties.escalationReason.type) -contains 'null') 'Codex review schema represents the non-escalate reason as null'
    $codexReviewSchemaPath = Join-Path $testAppData 'codex-review-result.schema.json'
    $codexSchemas['review-result'] | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $codexReviewSchemaPath -Encoding utf8NoBOM
    Assert-Hdo ([bool]($validReviewJson | Test-Json -SchemaFile $codexReviewSchemaPath -ErrorAction SilentlyContinue)) 'valid review fixture passes the Codex transport schema'

    # Regression coverage for issue #22: OpenAI Structured Outputs (used by Codex's
    # --output-schema) supports anyOf but rejects oneOf, the same asymmetry #21 already
    # fixed for the Claude route's allOf/oneOf/anyOf. A nested (non-root) oneOf must be
    # dropped from the Codex transport copy, while anyOf -- which Codex does support --
    # must be preserved.
    $codexOneOfSchemaPath = Join-Path $testAppData 'codex-oneof-keyword.schema.json'
    '{"type":"object","additionalProperties":false,"required":["v"],"properties":{"v":{"oneOf":[{"type":"string"},{"type":"null"}]}}}' |
        Set-Content -LiteralPath $codexOneOfSchemaPath -Encoding utf8NoBOM
    $normalizedOneOfJson = & $module { param($Path) ConvertTo-HdoCodexJsonSchema $Path } $codexOneOfSchemaPath
    Assert-Hdo ($normalizedOneOfJson -notmatch '"oneOf"') 'Codex schema normalization drops a nested oneOf that OpenAI Structured Outputs does not support'

    $codexAnyOfSchemaPath = Join-Path $testAppData 'codex-anyof-keyword.schema.json'
    '{"type":"object","additionalProperties":false,"required":["v"],"properties":{"v":{"anyOf":[{"type":"string"},{"type":"null"}]}}}' |
        Set-Content -LiteralPath $codexAnyOfSchemaPath -Encoding utf8NoBOM
    $normalizedAnyOfJson = & $module { param($Path) ConvertTo-HdoCodexJsonSchema $Path } $codexAnyOfSchemaPath
    Assert-Hdo ($normalizedAnyOfJson -match '"anyOf"') 'Codex schema normalization keeps anyOf, which OpenAI Structured Outputs does support'

    $optionalSchemaPath = Join-Path $testAppData 'codex-optional-property.schema.json'
    '{"type":"object","additionalProperties":false,"properties":{"requiredValue":{"type":"string"},"optionalValue":{"type":"string"}},"required":["requiredValue"]}' |
        Set-Content -LiteralPath $optionalSchemaPath -Encoding utf8NoBOM
    $optionalSchemaRejected = $false
    try { $null = & $module { param($Path) ConvertTo-HdoCodexJsonSchema $Path } $optionalSchemaPath }
    catch { $optionalSchemaRejected = $_.Exception.Message -match 'requires every object property' }
    Assert-Hdo $optionalSchemaRejected 'Codex schema normalization fails locally when a property is optional'

    $codexArgumentRunner = [ordered]@{
        sandbox = 'workspace-write'
        provider = 'ollama'
        model = 'local-model'
        reasoningEffort = 'medium'
        contextTokens = 32768
        extraArgs = @()
    }
    $codexArguments = @(& $module {
        param($Runner, $WorkingDirectory, $SchemaPath, $FinalPath)
        Get-HdoCodexArguments -Runner $Runner -WorkingDirectory $WorkingDirectory -SchemaPath $SchemaPath -FinalPath $FinalPath
    } $codexArgumentRunner 'C:\worktree' 'C:\artifacts\schema.json' 'C:\artifacts\final.json')
    Assert-Hdo ($codexArguments -contains '--ignore-user-config' -and $codexArguments -contains '--ignore-rules') 'Codex runner excludes personal configuration and execpolicy rules from unattended runs'
    Assert-Hdo (($codexArguments -join ' ') -match '--oss --local-provider ollama' -and ($codexArguments -join ' ') -match '--model local-model') 'Codex runner preserves explicit local provider and model routing'

    $codexFailureJsonl = @'
{"type":"thread.started","thread_id":"test"}
{"type":"error","message":"{\"error\":{\"code\":\"invalid_json_schema\",\"message\":\"Invalid schema for response_format: schema must have a type key.\"},\"status\":400}"}
{"type":"turn.failed","error":{"message":"{\"error\":{\"code\":\"invalid_json_schema\",\"message\":\"Invalid schema for response_format: schema must have a type key.\"},\"status\":400}"}}
'@
    $codexFailureDetail = & $module {
        param($Output)
        Get-HdoCodexFailureDetail $Output 'unrelated warning on stderr'
    } $codexFailureJsonl
    Assert-Hdo ($codexFailureDetail -eq 'Invalid schema for response_format: schema must have a type key.') 'Codex failures surface the de-duplicated JSONL error instead of unrelated stderr warnings'
    $codexToolFailure = & $module {
        param($Output, $ErrorOutput)
        Get-HdoCodexFailureDetail $Output $ErrorOutput
    } '{"type":"turn.failed","error":{"message":"stream disconnected before completion: no user query found in messages"}}' '2026-09-03 ERROR codex_core::tools::router: error=unsupported call: bash'
    Assert-Hdo ($codexToolFailure -like 'Codex tool router rejected an unsupported call: bash*') 'Codex failures preserve the tool-router root cause before downstream stream errors'
    $codexFailureFallback = & $module { Get-HdoCodexFailureDetail '' 'plain stderr failure' }
    Assert-Hdo ($codexFailureFallback -eq 'plain stderr failure') 'Codex failure reporting falls back to stderr when no JSONL error event exists'

    $claudeExampleConfig = Get-HdoConfig -RepositoryPath $repositoryRoot -ConfigPath (Join-Path $repositoryRoot 'config/examples/claude-only.json')
    Assert-Hdo ($claudeExampleConfig.resolvedProfile -eq 'claude-only' -and [string]$claudeExampleConfig.steps.fix -eq 'claude-fixer') 'claude-only example overlays the default config into a valid merged configuration'
    Assert-Hdo ([string]$claudeExampleConfig.runners['claude-fixer'].model -eq 'sonnet') 'claude-only example adds the claude-fixer runner through the merge'

    $plainResultText = & $module { ConvertFrom-HdoClaudeOutput '{"type":"result","result":"plain text"}' }
    Assert-Hdo ($plainResultText -eq 'plain text') 'Claude envelope conversion returns string results as-is'
    $structuredResultText = & $module { ConvertFrom-HdoClaudeOutput '{"type":"result","result":"ignored","structured_output":{"schemaVersion":1}}' }
    Assert-Hdo (($structuredResultText | ConvertFrom-Json).schemaVersion -eq 1) 'Claude envelope conversion prefers structured_output over result'

    $claudeFailureEnvelope = @'
{"is_error":true,"terminal_reason":"api_error","result":"API Error: response exceeded the output token maximum.","permission_denials":[{"tool_name":"Bash"},{"tool_name":"Bash"}]}
'@
    $claudeFailureDetail = & $module {
        param($Output, $ErrorOutput)
        Get-HdoClaudeFailureDetail $Output $ErrorOutput
    } $claudeFailureEnvelope '[claude-code:unrecognized_model] local-model'
    Assert-Hdo ($claudeFailureDetail -like 'API Error: response exceeded*') 'Claude failures prefer the result envelope root cause over a misleading stderr warning'
    Assert-Hdo ($claudeFailureDetail -match 'terminal_reason: api_error' -and $claudeFailureDetail -match '2 permission denial\(s\): Bash') 'Claude failures retain terminal reason and permission-denial context'
    Assert-Hdo ($claudeFailureDetail -match 'stderr: \[claude-code:unrecognized_model\]') 'Claude failures retain stderr as secondary diagnostic context'
    $claudeFailureFallback = & $module { Get-HdoClaudeFailureDetail '' 'plain stderr failure' }
    Assert-Hdo ($claudeFailureFallback -eq 'stderr: plain stderr failure') 'Claude failure reporting falls back to stderr when no envelope is available'

    # Ollama reports context-window exhaustion with a message that names neither the
    # context window nor Ollama, which is why the original report took two full runs to
    # diagnose. The long envelope also proves the hint survives detail truncation.
    # The marker sits past the 4096-character detail cap here, which is the realistic shape:
    # a run long enough to exhaust the context window also produces a long envelope.
    $claudeContextOverflowEnvelope = @"
{"is_error":true,"terminal_reason":"api_error","result":"$('x' * 5000) API Error: 500 no user query found in messages."}
"@
    $claudeContextOverflowDetail = & $module {
        param($Output, $ErrorOutput)
        Get-HdoClaudeFailureDetail $Output $ErrorOutput
    } $claudeContextOverflowEnvelope ''
    Assert-Hdo ($claudeContextOverflowDetail -match '\.\.\.\[truncated\]') 'test fixture sanity check: the failure detail below is long enough to be truncated'
    Assert-Hdo ($claudeContextOverflowDetail -match 'HDO diagnosis: the conversation outgrew the local model context window') 'Ollama context-window exhaustion is reported as such instead of as its misleading upstream message'
    Assert-Hdo ($claudeContextOverflowDetail -match 'contextTokens') 'the context-window diagnosis names the setting that fixes it'
    Assert-Hdo ($claudeFailureDetail -notmatch 'HDO diagnosis') 'unrelated Claude failures are not annotated with the context-window diagnosis'
    # The error comes from the Ollama server, so the Codex/Ollama route surfaces the same
    # misleading string and needs the same explanation.
    $codexContextOverflowDetail = & $module {
        param($Output, $ErrorOutput)
        Get-HdoCodexFailureDetail $Output $ErrorOutput
    } '{"type":"turn.failed","error":{"message":"no user query found in messages"}}' ''
    Assert-Hdo ($codexContextOverflowDetail -match 'HDO diagnosis: the conversation outgrew the local model context window') 'the Codex/Ollama route explains the same Ollama context-window exhaustion'
    Assert-Hdo ($codexFailureFallback -notmatch 'HDO diagnosis') 'unrelated Codex failures are not annotated with the context-window diagnosis'

    $contextTokenExpansion = & $module {
        Expand-HdoArgumentTemplate '--context={contextTokens}' ([ordered]@{ contextTokens = 8192 })
    }
    Assert-Hdo ($contextTokenExpansion -eq '--context=8192') 'command argument templates can explicitly consume contextTokens'

    # A command runner's process working directory is the target repository, so a worker
    # shipped with HDO is unreachable by relative path and would otherwise have to be
    # named by an absolute path that differs on every machine.
    $hdoRootExpansion = & $module {
        Expand-HdoArgumentTemplate '{hdoRoot}/workers/hdo-ollama-worker.ps1' ([ordered]@{ hdoRoot = 'C:\install\hdo' })
    }
    Assert-Hdo ($hdoRootExpansion -eq 'C:\install\hdo/workers/hdo-ollama-worker.ps1') 'command argument templates can locate files shipped alongside HDO'
    $leanWorkerConfig = Get-HdoConfig -RepositoryPath $repositoryRoot -ConfigPath (Join-Path $repositoryRoot 'config/examples/ollama-lean-worker.json')
    $leanWorkerRunner = $leanWorkerConfig.runners['ollama-lean-implementer']
    Assert-Hdo ($leanWorkerRunner.type -eq 'command' -and $leanWorkerRunner.provider -eq 'ollama') 'the lean worker example routes local work through a command runner'
    Assert-Hdo ($leanWorkerRunner.promptTransport -eq 'file') 'the lean worker example receives its prompt as a file rather than on stdin'
    # The whole point of the lean harness: it has no Claude CLI reserve to pay for, so it
    # can use a window that fits entirely in a 24 GB GPU.
    Assert-Hdo ([int]$leanWorkerRunner.contextTokens -eq 32768) 'the lean worker example uses the VRAM-friendly window the Claude CLI route cannot support'
    Assert-Hdo (@($leanWorkerRunner.extraArgs) -contains '{hdoRoot}/workers/hdo-ollama-worker.ps1') 'the lean worker example locates its worker without a machine-specific absolute path'
    Assert-Hdo (Test-Path -LiteralPath (Join-Path $repositoryRoot 'workers/hdo-ollama-worker.ps1') -PathType Leaf) 'the worker the example names is actually shipped'

    $badLabelPrefixConfig = Copy-HdoObject $config
    $badLabelPrefixConfig.github.labels.statusPrefix = 'custom:status/'
    $badLabelPrefixResult = Test-HdoConfiguration $badLabelPrefixConfig
    Assert-Hdo (-not $badLabelPrefixResult.valid) 'managed status labels remain inside the reserved hdo:status namespace'

    $duplicateLabelConfig = Copy-HdoObject $config
    $duplicateLabelConfig.github.labels.skip = $duplicateLabelConfig.github.labels.ready
    $duplicateLabelResult = Test-HdoConfiguration $duplicateLabelConfig
    Assert-Hdo (-not $duplicateLabelResult.valid) 'managed label names must be unique'

    $axisCollisionConfig = Copy-HdoObject $config
    $axisCollisionConfig.github.labels.ready = 'hdo:risk/low'
    $axisCollisionResult = Test-HdoConfiguration $axisCollisionConfig
    Assert-Hdo (-not $axisCollisionResult.valid) 'eligibility labels cannot collide with fixed priority or risk labels'
    $invalidLabelSyncRejected = $false
    try { $null = Sync-HdoLabels -Config $axisCollisionConfig -Repository 'owner/repository' }
    catch { $invalidLabelSyncRejected = $true }
    Assert-Hdo $invalidLabelSyncRejected 'label synchronization rejects collisions before contacting GitHub'

    $routeCollisionConfig = Copy-HdoObject $config
    $routeCollisionConfig.github.labels.ready = 'hdo:route/cloud-only'
    $routeCollisionResult = Test-HdoConfiguration $routeCollisionConfig
    Assert-Hdo (-not $routeCollisionResult.valid) 'eligibility labels cannot collide with generated route labels'

    $insideRepositoryConfig = Copy-HdoObject $config
    $insideRepositoryConfig.paths.artifactRoot = Join-Path $repositoryRoot 'test-results/unsafe-artifacts'
    $insideRepositoryResult = Test-HdoConfiguration $insideRepositoryConfig
    Assert-Hdo (-not $insideRepositoryResult.valid) 'artifact root inside the target repository is rejected'

    $fileSystemRoot = [System.IO.Path]::GetPathRoot($repositoryRoot)
    $normalizedRoot = & $module { param($Path) Get-HdoNormalizedFullPath $Path } $fileSystemRoot
    Assert-Hdo ($normalizedRoot -eq [System.IO.Path]::GetFullPath($fileSystemRoot)) 'path normalization preserves a filesystem root separator'

    if ($IsWindows) {
        $physicalRoot = & $module {
            param($Path)
            [HybridDevOrchestrator.Internal.FinalPathResolver]::Resolve($Path)
        } $repositoryRoot
        $aliasComparable = & $module { param($Path) Get-HdoComparableFullPath $Path } $repositoryRoot
        $physicalComparable = & $module { param($Path) Get-HdoComparableFullPath $Path } $physicalRoot
        Assert-Hdo ($aliasComparable -eq $physicalComparable) 'path comparison treats a Windows path alias and its physical path as identical'
        $missingAlias = Join-Path $repositoryRoot 'future/child'
        $missingPhysical = Join-Path $physicalRoot 'future/child'
        $missingAliasComparable = & $module { param($Path) Get-HdoComparableFullPath $Path } $missingAlias
        $missingPhysicalComparable = & $module { param($Path) Get-HdoComparableFullPath $Path } $missingPhysical
        Assert-Hdo ($missingAliasComparable -eq $missingPhysicalComparable) 'path comparison canonicalizes missing descendants through their nearest existing ancestor'
    }

    $reparseRoot = Join-Path $testAppData 'reparse-root'
    $reparseTarget = Join-Path $testAppData 'reparse-target'
    $reparseLink = Join-Path $reparseRoot 'linked-working-directory'
    New-Item -ItemType Directory -Path $reparseRoot, $reparseTarget -Force | Out-Null
    try {
        New-Item -ItemType Junction -Path $reparseLink -Target $reparseTarget | Out-Null
        $reparseRejected = & $module {
            param($Candidate, $Root)
            Test-HdoReparsePointInPath $Candidate $Root
        } $reparseLink $reparseRoot
        Assert-Hdo $reparseRejected 'validation working directories reject junction and symbolic-link boundaries'
    }
    finally {
        if (Test-Path -LiteralPath $reparseLink) { [System.IO.Directory]::Delete($reparseLink) }
        Remove-HdoTestDirectory $reparseRoot
        Remove-HdoTestDirectory $reparseTarget
    }

    $hybrid = Get-HdoConfig -RepositoryPath $repositoryRoot -ConfigPath (Join-Path $repositoryRoot 'config/examples/ollama-hybrid.json')
    $hybridPlan = Get-HdoExecutionPlan $hybrid
    Assert-Hdo (@($hybridPlan.runners.Values | Where-Object provider -eq 'ollama').Count -eq 1) 'explicit hybrid configuration remains supported alongside automatic repository routing'

    $redacted = & $module { Protect-HdoText 'token=ghp_abcdefghijklmnopqrstuvwxyz123456 password=secret-value' }
    Assert-Hdo ($redacted -notmatch 'ghp_|secret-value') 'known credential forms are redacted'
    $emptyRedacted = & $module { Protect-HdoText '' }
    Assert-Hdo ($emptyRedacted -eq '') 'empty runner output remains a valid redaction input'
    $emptyHash = & $module { Get-HdoSha256 '' }
    Assert-Hdo ($emptyHash -eq 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') 'an unchanged worktree can hash an empty diff'

    # Regression coverage for issue #62: Get-HdoUtcTimestamp must produce a Z-suffixed
    # (Kind=Utc) timestamp, not a "+00:00" numeric-offset one, so it survives a
    # ConvertFrom-Json/ConvertTo-Json round trip without sliding into the local time zone.
    $utcTimestamp = & $module { Get-HdoUtcTimestamp }
    Assert-Hdo ($utcTimestamp -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$') "Get-HdoUtcTimestamp produces a Z-suffixed timestamp with 7 fractional digits, not a numeric UTC offset (issue #62; got: $utcTimestamp)"

    # Regression coverage for issue #63: names ending in a bare "_KEY" (e.g. an admin key
    # that is not literally an API_KEY) previously passed the safe-environment filter and
    # would be forwarded to gate/agent child processes.
    $originalAdminKey = $env:ANTHROPIC_ADMIN_KEY
    $originalSigningKey = $env:SOME_SIGNING_KEY
    $originalKeyboard = $env:KEYBOARD
    try {
        $env:ANTHROPIC_ADMIN_KEY = 'admin-secret'
        $env:SOME_SIGNING_KEY = 'signing-secret'
        $env:KEYBOARD = 'not-a-secret'
        $safeEnvironment = & $module { Get-HdoSafeEnvironment }
        Assert-Hdo (-not $safeEnvironment.Contains('ANTHROPIC_ADMIN_KEY')) 'Get-HdoSafeEnvironment blocks a variable ending in "_KEY" (issue #63)'
        Assert-Hdo (-not $safeEnvironment.Contains('SOME_SIGNING_KEY')) 'Get-HdoSafeEnvironment blocks any variable name ending in "_KEY", not just a fixed list (issue #63)'
        Assert-Hdo ($safeEnvironment.Contains('KEYBOARD') -and $safeEnvironment.KEYBOARD -eq 'not-a-secret') 'Get-HdoSafeEnvironment still forwards a variable that merely contains "KEY" without a "_KEY" suffix'
        $allowedEnvironment = & $module { Get-HdoSafeEnvironment @('ANTHROPIC_ADMIN_KEY') }
        Assert-Hdo ($allowedEnvironment.Contains('ANTHROPIC_ADMIN_KEY') -and $allowedEnvironment.ANTHROPIC_ADMIN_KEY -eq 'admin-secret') '-PassEnvironment re-allows a variable that would otherwise be blocked by the "_KEY" suffix'
    }
    finally {
        if ($null -eq $originalAdminKey) { Remove-Item -LiteralPath Env:ANTHROPIC_ADMIN_KEY -ErrorAction SilentlyContinue } else { $env:ANTHROPIC_ADMIN_KEY = $originalAdminKey }
        if ($null -eq $originalSigningKey) { Remove-Item -LiteralPath Env:SOME_SIGNING_KEY -ErrorAction SilentlyContinue } else { $env:SOME_SIGNING_KEY = $originalSigningKey }
        if ($null -eq $originalKeyboard) { Remove-Item -LiteralPath Env:KEYBOARD -ErrorAction SilentlyContinue } else { $env:KEYBOARD = $originalKeyboard }
    }

    # Regression coverage for issue #61 item 4 (same shape as #50): a 0-element result
    # must round-trip as a genuine empty array, not collapse to $null one level up.
    $noLabels = & $module { param($Labels) Get-HdoLabelNames $Labels } @()
    Assert-Hdo ($null -ne $noLabels -and $noLabels.Count -eq 0) 'Get-HdoLabelNames returns an empty array instead of $null when an Issue has no labels'
    $oneLabel = & $module { param($Labels) Get-HdoLabelNames $Labels } @('hdo:ready')
    Assert-Hdo ($oneLabel.Count -eq 1 -and $oneLabel[0] -eq 'hdo:ready') 'Get-HdoLabelNames still returns a genuine 1-element array for a single label'

    $redactedJson = & $module { Protect-HdoText '{"password":"json-secret","api_key":"opaque-value","token":"plain-token"}' }
    Assert-Hdo ($redactedJson -notmatch 'json-secret|opaque-value|plain-token') 'quoted JSON credential values are redacted'

    $validationArtifact = Join-Path $repositoryRoot "test-results/validation-redaction-$([guid]::NewGuid().ToString('N'))"
    try {
        $redactionIssue = [ordered]@{ validationGates = @('redaction') }
        $redactionProject = [ordered]@{
            validationGates = @(
                [ordered]@{
                    id = 'redaction'
                    command = 'pwsh'
                    args = @('-NoProfile', '-File', 'tests/fixtures/runtime/validation-pass.ps1', '-Value', 'password=validation-secret')
                    workingDirectory = '.'
                    timeoutSeconds = 30
                    required = $true
                    exitCodes = [ordered]@{ passed = @(0); failed = @(1); indeterminate = @(2, 124, 125, 126, 127) }
                    continueAfterFailure = $true
                }
            )
        }
        $validationRedactionResult = & $module {
            param($IssueContract, $ProjectContract, $Worktree, $Artifact)
            Invoke-HdoValidation $IssueContract $ProjectContract $Worktree $Artifact
        } $redactionIssue $redactionProject $repositoryRoot $validationArtifact
        $validationArtifactText = ($validationRedactionResult | ConvertTo-Json -Depth 30) + (Get-Content -LiteralPath (Join-Path $validationArtifact 'redaction.log') -Raw)
        Assert-Hdo ($validationArtifactText -notmatch 'validation-secret') 'validation command arguments are redacted from JSON and log artifacts'
    }
    finally {
        Remove-HdoTestDirectory $validationArtifact
    }

    # Regression coverage for issue #16: a setup failure (the gate command itself could
    # not be started) must be distinguished from a product failure (the gate started and
    # its exit code is classified 'failed'), and a setup failure must always stop
    # remaining gates regardless of continueAfterFailure (AC-01/AC-02/AC-05/AC-06), while
    # an ordinary product failure still follows continueAfterFailure (AC-03).
    $setupFailureArtifact = Join-Path $repositoryRoot "test-results/validation-setup-failure-$([guid]::NewGuid().ToString('N'))"
    try {
        $setupFailureIssue = [ordered]@{ validationGates = @('missing', 'after') }
        $setupFailureProject = [ordered]@{
            validationGates = @(
                [ordered]@{
                    id = 'missing'
                    command = 'hdo-gate-command-that-does-not-exist'
                    args = @()
                    workingDirectory = '.'
                    timeoutSeconds = 30
                    required = $true
                    exitCodes = [ordered]@{ passed = @(0); failed = @(1); indeterminate = @(2, 124, 125, 126, 127) }
                    continueAfterFailure = $true
                },
                [ordered]@{
                    id = 'after'
                    command = 'pwsh'
                    args = @('-NoProfile', '-File', 'tests/fixtures/runtime/validation-pass.ps1')
                    workingDirectory = '.'
                    timeoutSeconds = 30
                    required = $true
                    exitCodes = [ordered]@{ passed = @(0); failed = @(1); indeterminate = @(2, 124, 125, 126, 127) }
                    continueAfterFailure = $true
                }
            )
        }
        $setupFailureResult = & $module {
            param($IssueContract, $ProjectContract, $Worktree, $Artifact)
            Invoke-HdoValidation $IssueContract $ProjectContract $Worktree $Artifact
        } $setupFailureIssue $setupFailureProject $repositoryRoot $setupFailureArtifact
        Assert-Hdo ($setupFailureResult.gates[0].status -eq 'indeterminate' -and $setupFailureResult.gates[0].failureClass -eq 'setup' -and $null -eq $setupFailureResult.gates[0].exitCode -and -not $setupFailureResult.gates[0].skipped) "a gate command that cannot be started is classified indeterminate/setup, not folded into a generic indeterminate (issue #16 AC-01/AC-05; got status=$($setupFailureResult.gates[0].status) failureClass=$($setupFailureResult.gates[0].failureClass))"
        Assert-Hdo ($setupFailureResult.gates[1].status -eq 'indeterminate' -and $setupFailureResult.gates[1].failureClass -eq 'skipped' -and $setupFailureResult.gates[1].skipped -eq $true) 'a later gate is skipped after a setup failure even though continueAfterFailure is true (issue #16 AC-02/AC-06)'
        Assert-Hdo ($setupFailureResult.indeterminate -eq 2 -and $setupFailureResult.passed -eq 0 -and $setupFailureResult.failed -eq 0) 'the validation summary counts both the setup failure and the gate it skipped as indeterminate'
        $skippedLogText = Get-Content -LiteralPath (Join-Path $setupFailureArtifact 'after.log') -Raw
        Assert-Hdo ($skippedLogText -match "(?m)^reason: skipped after a previous gate failed to start\r?$") "the skipped-gate log names the setup failure as the reason, on its own line (issue #16 AC-05; got: $skippedLogText)"
    }
    finally {
        Remove-HdoTestDirectory $setupFailureArtifact
    }

    $productFailureArtifact = Join-Path $repositoryRoot "test-results/validation-product-failure-$([guid]::NewGuid().ToString('N'))"
    $productFailureGateScript = Join-Path $testAppData 'gate-fail.ps1'
    try {
        Set-Content -LiteralPath $productFailureGateScript -Value "Write-Output 'validation failed'`nexit 1`n" -Encoding utf8NoBOM
        $productFailureIssue = [ordered]@{ validationGates = @('fails', 'passes') }
        $productFailureProject = [ordered]@{
            validationGates = @(
                [ordered]@{
                    id = 'fails'
                    command = 'pwsh'
                    args = @('-NoProfile', '-File', $productFailureGateScript)
                    workingDirectory = '.'
                    timeoutSeconds = 30
                    required = $true
                    exitCodes = [ordered]@{ passed = @(0); failed = @(1); indeterminate = @(2, 124, 125, 126, 127) }
                    continueAfterFailure = $true
                },
                [ordered]@{
                    id = 'passes'
                    command = 'pwsh'
                    args = @('-NoProfile', '-File', 'tests/fixtures/runtime/validation-pass.ps1')
                    workingDirectory = '.'
                    timeoutSeconds = 30
                    required = $true
                    exitCodes = [ordered]@{ passed = @(0); failed = @(1); indeterminate = @(2, 124, 125, 126, 127) }
                    continueAfterFailure = $true
                }
            )
        }
        $productFailureResult = & $module {
            param($IssueContract, $ProjectContract, $Worktree, $Artifact)
            Invoke-HdoValidation $IssueContract $ProjectContract $Worktree $Artifact
        } $productFailureIssue $productFailureProject $repositoryRoot $productFailureArtifact
        Assert-Hdo ($productFailureResult.gates[0].status -eq 'fail' -and $productFailureResult.gates[0].failureClass -eq 'product') 'an exit code explicitly in exitCodes.failed is classified fail/product (issue #16 AC-03)'
        Assert-Hdo ($productFailureResult.gates[1].status -eq 'pass' -and $null -eq $productFailureResult.gates[1].failureClass -and -not $productFailureResult.gates[1].skipped) 'a product failure with continueAfterFailure=true still runs the next gate, and a passing gate has a null failureClass (issue #16 AC-03)'
        Assert-Hdo ($productFailureResult.failed -eq 1 -and $productFailureResult.passed -eq 1 -and $productFailureResult.indeterminate -eq 0) 'the validation summary counts the product failure and the subsequent pass correctly'
        $productFailureLogText = Get-Content -LiteralPath (Join-Path $productFailureArtifact 'fails.log') -Raw
        Assert-Hdo ($productFailureLogText -match "(?m)^failureClass: product$") "the gate log records failureClass on its own line after status (issue #16 AC-05; got: $productFailureLogText)"
    }
    finally {
        Remove-HdoTestDirectory $productFailureArtifact
    }

    $redactedObject = & $module { Protect-HdoObject ([ordered]@{ apiKey = 'plain-secret'; argument = 'ghp_abcdefghijklmnopqrstuvwxyz123456' }) }
    Assert-Hdo ($redactedObject.apiKey -eq '[REDACTED]' -and $redactedObject.argument -eq '[REDACTED]') 'effective configuration object redacts sensitive keys and token-shaped values'

    $rawDefault = Get-Content -LiteralPath (Join-Path $repositoryRoot 'config/hdo.default.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    $rawDefault['unknownRootProperty'] = $true
    $runtimeSchemaResult = & $module { param($Value) Test-HdoObjectSchema $Value 'hdo-config' } $rawDefault
    Assert-Hdo (-not $runtimeSchemaResult.valid) 'runtime configuration schema rejects unknown root properties'

    $previousReview = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tests/fixtures/schema/review.valid.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    $missingFindingReview = Copy-HdoObject $previousReview
    $missingFindingReview.reviewRound = 2
    $missingFindingReview.decision = 'approve'
    $missingFindingReview.summary = 'The prior finding disappeared.'
    $missingFindingReview.findings = @()
    $reviewContinuity = & $module {
        param($Current, $Previous)
        Test-HdoReviewResult $Current $Previous 2
    } $missingFindingReview $previousReview
    Assert-Hdo (-not $reviewContinuity.valid) 'review findings cannot disappear across rounds'

    $carriedFindingReview = Copy-HdoObject $previousReview
    $carriedFindingReview.reviewRound = 2
    $carriedFindingReview.decision = 'approve'
    $carriedFindingReview.summary = 'The prior finding is resolved.'
    $carriedFindingReview.findings[0].status = 'resolved'
    $carriedFindingReview.findings[0].actionable = $false
    $carriedFindingReview.findings[0].requiredAction = $null
    $reviewCarryResult = & $module {
        param($Current, $Previous)
        Test-HdoReviewResult $Current $Previous 2
    } $carriedFindingReview $previousReview
    Assert-Hdo $reviewCarryResult.valid 'review findings can be carried forward with a terminal status'

    $duplicateFindingReview = Copy-HdoObject $previousReview
    $caseVariantFinding = Copy-HdoObject $previousReview.findings[0]
    $caseVariantFinding.id = ([string]$caseVariantFinding.id).ToLowerInvariant()
    $duplicateFindingReview.findings += $caseVariantFinding
    $duplicateFindingResult = & $module {
        param($Current)
        Test-HdoReviewResult $Current
    } $duplicateFindingReview
    Assert-Hdo (-not $duplicateFindingResult.valid) 'review finding IDs are unique without regard to case'

    $diffRepository = Join-Path $repositoryRoot "test-results/diff-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $diffRepository -Force | Out-Null
    try {
        & git -C $diffRepository init --quiet
        & git -C $diffRepository config user.email 'hdo-tests@example.invalid'
        & git -C $diffRepository config user.name 'HDO Tests'
        & git -C $diffRepository config commit.gpgSign false
        & git -C $diffRepository config core.autocrlf false
        Set-Content -LiteralPath (Join-Path $diffRepository 'tracked.txt') -Value 'baseline' -Encoding utf8NoBOM
        & git -C $diffRepository add -- tracked.txt
        & git -C $diffRepository commit --quiet -m baseline
        $baseCommit = (& git -C $diffRepository rev-parse HEAD).Trim()
        Set-Content -LiteralPath (Join-Path $diffRepository 'untracked file.txt') -Value 'untracked evidence' -Encoding utf8NoBOM
        $capturedDiff = & $module {
            param($Repository, $BaseCommit)
            Get-HdoDiff $Repository $BaseCommit
        } $diffRepository $baseCommit
        Assert-Hdo ($capturedDiff.hasChanges -and $capturedDiff.patch -match 'untracked evidence' -and $capturedDiff.patch -match 'untracked file\.txt' -and $capturedDiff.numstat -match 'untracked file\.txt') 'diff capture includes untracked content and filenames with spaces'
    }
    finally {
        Remove-HdoTestDirectory $diffRepository
    }

    $mockRunner = [ordered]@{
        type = 'command'
        provider = 'custom'
        command = 'pwsh'
        sandbox = 'read-only'
        timeoutSeconds = 30
        passEnvironment = @()
        promptTransport = 'stdin'
        extraArgs = @(
            '-NoProfile',
            '-File',
            (Join-Path $repositoryRoot 'tests/fixtures/runtime/mock-agent.ps1'),
            '-SchemaFile',
            '{schemaFile}',
            '-OutputFile',
            '{outputFile}',
            '-DelayMilliseconds',
            '1500'
        )
    }
    $runnerConfig = Copy-HdoObject $config
    $runnerConfig.runners['mock-plan'] = $mockRunner
    $runnerConfig.steps.plan = 'mock-plan'
    $tempRoot = Join-Path $repositoryRoot "test-results/runtime-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        $run = [ordered]@{
            schemaVersion = 1
            id = 'test-run'
            state = 'PLANNING'
            iteration = 0
            createdAt = '2026-09-04T00:00:00.0000000+00:00'
            updatedAt = '2026-09-04T00:00:00.0000000+00:00'
            artifactPath = $tempRoot
        }
        $trackedAgent = & $module {
            param($RunnerConfig, $Run, $WorkingDirectory, $ArtifactDirectory)
            $events = [Collections.Generic.List[object]]::new()
            $result = Invoke-HdoAgentStep $RunnerConfig $Run 'plan' 0 $WorkingDirectory 'mock prompt' $ArtifactDirectory 'task-contract' -ProgressIntervalSeconds 1 -ActivityCallback {
                param($Event)
                $events.Add($Event)
            }
            return [pscustomobject]@{ result = $result; events = [object[]]$events; activity = $Run.activity }
        } $runnerConfig $run $repositoryRoot $tempRoot
        $agentResult = $trackedAgent.result
        Assert-Hdo ($agentResult.status -eq 'succeeded') 'generic command runner accepts prompt on stdin and returns structured output'
        Assert-Hdo ($agentResult.output.schemaVersion -eq 1) 'generic command runner output is schema validated'
        Assert-Hdo ($trackedAgent.events.Count -ge 1 -and $trackedAgent.events[0].type -eq 'agent.progress' -and $trackedAgent.events[0].phase -eq 'started' -and $trackedAgent.events[0].runId -eq 'test-run') 'agent progress exposes the run ID before the process completes'
        Assert-Hdo (@($trackedAgent.events | Where-Object phase -eq 'heartbeat').Count -ge 1) 'agent progress persists and emits a heartbeat while the process is running'
        $storedRun = Get-Content -LiteralPath (Join-Path $tempRoot 'run.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 100
        Assert-Hdo ($null -eq $trackedAgent.activity -and $null -eq $storedRun.activity) 'agent activity is cleared from memory and durable run state after process completion'

        $invalidRunner = Copy-HdoObject $mockRunner
        $invalidRunner.extraArgs += '-InvalidOutput'
        $invalidRunnerConfig = Copy-HdoObject $runnerConfig
        $invalidRunnerConfig.runners['invalid-mock-plan'] = $invalidRunner
        $invalidRunnerConfig.steps.plan = 'invalid-mock-plan'
        $invalidOutputRejected = $false
        try {
            $invalidArtifact = Join-Path $tempRoot 'invalid'
            $null = & $module {
                param($RunnerConfig, $Run, $WorkingDirectory, $ArtifactDirectory)
                Invoke-HdoAgentStep $RunnerConfig $Run 'plan' 0 $WorkingDirectory 'mock prompt' $ArtifactDirectory 'task-contract'
            } $invalidRunnerConfig $run $repositoryRoot $invalidArtifact
        }
        catch { $invalidOutputRejected = $true }
        Assert-Hdo $invalidOutputRejected 'exit-zero agent output is rejected when it fails the output schema'

        $claudeMockRunner = [ordered]@{
            type = 'claude'
            provider = 'cloud'
            command = (Join-Path $repositoryRoot 'tests/fixtures/runtime/mock-claude.cmd')
            sandbox = 'read-only'
            timeoutSeconds = 30
            passEnvironment = @()
            extraArgs = @()
        }
        $claudeRunnerConfig = Copy-HdoObject $config
        $claudeRunnerConfig.runners['mock-claude-plan'] = $claudeMockRunner
        $claudeRunnerConfig.steps.plan = 'mock-claude-plan'
        $claudeArtifact = Join-Path $tempRoot 'claude'
        $claudeStepResult = & $module {
            param($RunnerConfig, $Run, $WorkingDirectory, $ArtifactDirectory)
            Invoke-HdoAgentStep $RunnerConfig $Run 'plan' 0 $WorkingDirectory 'mock prompt' $ArtifactDirectory 'task-contract'
        } $claudeRunnerConfig $run $repositoryRoot $claudeArtifact
        Assert-Hdo ($claudeStepResult.status -eq 'succeeded') 'Claude adapter extracts and validates structured output from the result envelope'
        Assert-Hdo ($claudeStepResult.output.objective -eq 'Implement the normalized issue delivery cycle.') 'Claude adapter final output comes from structured_output'
        $claudeEnvelopeArtifact = [string]$claudeStepResult.artifacts.events
        Assert-Hdo (([IO.Path]::GetFileName($claudeEnvelopeArtifact) -eq 'envelope.json') -and (Test-Path -LiteralPath $claudeEnvelopeArtifact -PathType Leaf)) 'Claude adapter stores its single JSON envelope as envelope.json instead of events.jsonl'

        $ollamaRunner = Copy-HdoObject $claudeMockRunner
        $ollamaRunner.provider = 'ollama'
        $ollamaRunner.command = Join-Path $repositoryRoot 'tests/fixtures/runtime/mock-claude-ollama-prose.cmd'
        $ollamaConfig = Copy-HdoObject $claudeRunnerConfig
        $ollamaConfig.runners['mock-ollama'] = $ollamaRunner
        $ollamaConfig.steps.implement = 'mock-ollama'
        $ollamaArtifact = Join-Path $tempRoot 'ollama-prose'
        $recovered = & $module {
            param($Config, $Run, $Work, $Artifacts)
            Invoke-HdoAgentStep $Config $Run 'implement' 0 $Work 'mock prompt' $Artifacts 'worker-result'
        } $ollamaConfig $run $tempRoot $ollamaArtifact
        Assert-Hdo ($recovered.status -eq 'succeeded') 'Ollama prose fixture recovers through the real adapter after a file edit'
        Assert-Hdo ((Get-Content (Join-Path $tempRoot 'hdo-ollama-smoke.txt') -Raw).Trim() -eq 'HDO_OLLAMA_SMOKE_OK') 'response recovery preserves the worker file edit'
        $diagnostic = Get-Content (Join-Path $ollamaArtifact 'structured-output.json') -Raw | ConvertFrom-Json
        Assert-Hdo ($diagnostic.recovery -eq 'succeeded' -and $diagnostic.attempts -eq 1) 'recovery is classified and bounded to one attempt'
        foreach ($name in @('envelope.json', 'result.original.txt', 'recovery.input.txt', 'recovery.output.txt', 'structured-output.json')) {
            Assert-Hdo (Test-Path (Join-Path $ollamaArtifact $name)) "Ollama recovery preserves $name"
        }
        $fixture = Get-Content (Join-Path $repositoryRoot 'tests/fixtures/runtime/claude-ollama-prose.json') -Raw | ConvertFrom-Json -AsHashtable
        $validJson = $recovered.output | ConvertTo-Json -Compress -Depth 100
        $schema = Join-Path $repositoryRoot 'schemas/worker-result.schema.json'
        $inlineEnvelope = Get-Content (Join-Path $repositoryRoot 'tests/fixtures/runtime/claude-ollama-inline-prose.json') -Raw
        $inlineRecovered = & $module { param($E, $S, $A) Resolve-HdoOllamaStructuredOutput $E $S $A } $inlineEnvelope $schema $ollamaArtifact
        Assert-Hdo (($inlineRecovered | ConvertFrom-Json).schemaVersion -eq 1) 'real Ollama smoke prose with inline code recovers without changing JSON'
        $listEnvelope = Get-Content (Join-Path $repositoryRoot 'tests/fixtures/runtime/claude-ollama-list-prose.json') -Raw
        $listRecovered = & $module { param($E, $S, $A) Resolve-HdoOllamaStructuredOutput $E $S $A } $listEnvelope $schema $ollamaArtifact
        Assert-Hdo (($listRecovered | ConvertFrom-Json).schemaVersion -eq 1) 'real Ollama smoke prose with bullet formatting recovers without changing JSON'
        $symbolEnvelope = Get-Content (Join-Path $repositoryRoot 'tests/fixtures/runtime/claude-ollama-symbol-prose.json') -Raw
        $symbolRecovered = & $module { param($E, $S, $A) Resolve-HdoOllamaStructuredOutput $E $S $A } $symbolEnvelope $schema $ollamaArtifact
        Assert-Hdo (($symbolRecovered | ConvertFrom-Json).schemaVersion -eq 1) 'real Ollama smoke prose with Unicode symbols recovers without changing JSON'
        foreach ($bad in @('', ' ', ('```json' + "`n$validJson"), ('Unclosed `token' + "`n$validJson"), "Done.`n{}", "Done.`n$validJson`n{}", "Done.`n$validJson trailing", "[prefix]`n$validJson", "Quoted `"prefix`"`n$validJson", "Done. $validJson", "Done.`n{broken`n$validJson", "Done.`n[$validJson]", (('x' * 1048577) + "`n$validJson"))) {
            $fixture.result = $bad
            $failure = ''
            try {
                $null = & $module {
                    param($Envelope, $Schema, $Artifacts)
                    Resolve-HdoOllamaStructuredOutput $Envelope $Schema $Artifacts
                } ($fixture | ConvertTo-Json -Depth 100) $schema $ollamaArtifact
            } catch { $failure = $_.Exception.Message }
            Assert-Hdo ($failure -match 'structured-output noncompliance; recovery rejected') 'invalid, multiple, ambiguous, and oversized output fails closed with recovery diagnosis'
            $failedDiagnostic = Get-Content (Join-Path $ollamaArtifact 'structured-output.json') -Raw | ConvertFrom-Json
            Assert-Hdo ($failedDiagnostic.recovery -eq 'rejected' -and $failedDiagnostic.finalValidationError) 'failed recovery retains final validation error'
        }
        $fixture.result = $validJson
        $unchanged = & $module { param($E, $S, $A) Resolve-HdoOllamaStructuredOutput $E $S $A } ($fixture | ConvertTo-Json -Depth 100) $schema $ollamaArtifact
        Assert-Hdo ($unchanged -ceq $validJson) 'valid JSON-only Ollama result is unchanged'

        $claudeFailureRunner = Copy-HdoObject $claudeMockRunner
        $claudeFailureRunner.command = Join-Path $repositoryRoot 'tests/fixtures/runtime/mock-claude-failure.cmd'
        $claudeFailureRunnerConfig = Copy-HdoObject $claudeRunnerConfig
        $claudeFailureRunnerConfig.runners['mock-claude-failure'] = $claudeFailureRunner
        $claudeFailureRunnerConfig.steps.plan = 'mock-claude-failure'
        $claudeFailureArtifact = Join-Path $tempRoot 'claude-failure'
        $claudeFailureMessage = ''
        try {
            $null = & $module {
                param($RunnerConfig, $Run, $WorkingDirectory, $ArtifactDirectory)
                Invoke-HdoAgentStep $RunnerConfig $Run 'plan' 0 $WorkingDirectory 'mock prompt' $ArtifactDirectory 'task-contract'
            } $claudeFailureRunnerConfig $run $repositoryRoot $claudeFailureArtifact
        }
        catch { $claudeFailureMessage = $_.Exception.Message }
        Assert-Hdo ($claudeFailureMessage -match 'API Error: response exceeded the output token maximum\..*terminal_reason: api_error.*stderr: \[claude-code:unrecognized_model\]') 'Claude adapter reports the envelope root cause before secondary stderr on a failed process'
        Assert-Hdo (Test-Path -LiteralPath (Join-Path $claudeFailureArtifact 'envelope.json') -PathType Leaf) 'Claude adapter preserves the failure envelope artifact before throwing'
    }
    finally {
        if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
    }

    if ($IsWindows) {
        # Regression tests for issue #25: git deletes its worktree admin entry (and tracked
        # files) before failing with "Filename too long" on a deep node_modules path, leaving
        # the directory behind while `git worktree list` no longer shows it. Invoke-HdoGit
        # forces core.longpaths=true per invocation (effective only when no config file sets
        # the key), and Remove-HdoRunWorktree finishes the removal on the filesystem plus
        # `git worktree prune` when git has already unregistered the worktree.
        #
        # git config is isolated for the whole block: a developer's global core.longpaths=true
        # would otherwise make every case pass against unfixed code.
        $longPathRepository = Join-Path $repositoryRoot "test-results/longpath-repo-$([guid]::NewGuid().ToString('N'))"
        $longPathWorktreeRoot = Join-Path $repositoryRoot "test-results/longpath-worktrees-$([guid]::NewGuid().ToString('N'))"
        $longPathArtifactRoot = Join-Path $repositoryRoot "test-results/longpath-artifacts-$([guid]::NewGuid().ToString('N'))"
        $longPathGlobalConfig = Join-Path $repositoryRoot "test-results/longpath-gitconfig-$([guid]::NewGuid().ToString('N'))"
        $savedGitEnvironment = @{}
        foreach ($name in @('GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM')) {
            $savedGitEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
        }
        New-Item -ItemType Directory -Path $longPathRepository -Force | Out-Null
        try {
            [IO.File]::WriteAllText($longPathGlobalConfig, '')
            $env:GIT_CONFIG_GLOBAL = $longPathGlobalConfig
            $env:GIT_CONFIG_NOSYSTEM = '1'
            & git -C $longPathRepository init --quiet
            & git -C $longPathRepository config user.email 'hdo-tests@example.invalid'
            & git -C $longPathRepository config user.name 'HDO Tests'
            & git -C $longPathRepository config commit.gpgSign false
            Set-Content -LiteralPath (Join-Path $longPathRepository 'README.md') -Value 'longpath cleanup regression fixture' -Encoding utf8NoBOM
            & git -C $longPathRepository add -- README.md
            & git -C $longPathRepository commit --quiet -m baseline

            $longPathConfigOverride = Join-Path $longPathRepository 'hdo-longpath-override.json'
            [ordered]@{
                paths = [ordered]@{
                    worktreeRoot = $longPathWorktreeRoot
                    artifactRoot = $longPathArtifactRoot
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $longPathConfigOverride -Encoding utf8NoBOM
            $longPathConfig = Get-HdoConfig -RepositoryPath $longPathRepository -ConfigPath $longPathConfigOverride -IgnoreRepositoryConfig

            # Creates a worktree + run.json for $RunId and, unless -SkipDeepPath, a pnpm-shaped
            # nested path inside it that exceeds MAX_PATH. Returns the worktree record.
            $newLongPathRun = {
                param($RunId, [switch]$SkipDeepPath)
                $worktree = & $module {
                    param($Config, $RunId, $IssueNumber)
                    New-HdoWorktree -Config $Config -RunId $RunId -IssueNumber $IssueNumber
                } $longPathConfig $RunId 25
                $artifactPath = Join-Path $longPathArtifactRoot $RunId
                New-Item -ItemType Directory -Path $artifactPath -Force | Out-Null
                [ordered]@{
                    schemaVersion = 1
                    id = $RunId
                    state = 'IMPLEMENTING'
                    iteration = 0
                    createdAt = '2026-09-05T00:00:00.0000000+00:00'
                    updatedAt = '2026-09-05T00:00:00.0000000+00:00'
                    artifactPath = $artifactPath
                    worktree = $worktree
                } | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $artifactPath 'run.json') -Encoding utf8NoBOM
                if (-not $SkipDeepPath) {
                    $deepSegmentOne = ".pnpm-$('x' * 120)"
                    $deepSegmentTwo = "pkg-$('y' * 120)"
                    $deepDirectory = Join-Path $worktree.path (Join-Path 'node_modules' (Join-Path $deepSegmentOne (Join-Path 'node_modules' $deepSegmentTwo)))
                    $deepFilePath = Join-Path $deepDirectory 'deeply-nested-file.txt'
                    [IO.Directory]::CreateDirectory($deepDirectory) | Out-Null
                    [IO.File]::WriteAllText($deepFilePath, 'long path regression fixture')
                    Assert-Hdo ($deepFilePath.Length -gt 300) "the regression fixture path for '$RunId' exceeds 300 characters (issue #25 reproduction shape)"
                }
                return $worktree
            }
            $listedWorktreeCount = {
                param($Path)
                $comparable = & $module { param($Path) Get-HdoComparableFullPath $Path } $Path
                return @(& git -C $longPathRepository worktree list --porcelain | Where-Object { $_ -like 'worktree *' } |
                    ForEach-Object { $_.Substring('worktree '.Length) } |
                    Where-Object { (& $module { param($Path) Get-HdoComparableFullPath $Path } $_) -eq $comparable }).Count
            }

            # Case 1: no config file sets core.longpaths, so Invoke-HdoGit's -c takes effect and
            # `git worktree remove` itself succeeds on the long path.
            $longPathWorktree = & $newLongPathRun 'issue-25-longpath'
            Assert-Hdo ((& $listedWorktreeCount $longPathWorktree.path) -eq 1) 'git lists the long-path worktree before cleanup (porcelain path comparison is live)'
            $cleanupResult = Remove-HdoRunWorktree -RunId 'issue-25-longpath' -RepositoryPath $longPathRepository -ConfigPath $longPathConfigOverride -IgnoreRepositoryConfig -Force -Confirm:$false
            Assert-Hdo ($cleanupResult.removed -eq $true) 'cleanup reports success for a worktree containing paths beyond MAX_PATH on Windows (issue #25)'
            Assert-Hdo (-not (Test-Path -LiteralPath $longPathWorktree.path)) 'the long-path worktree directory no longer exists on disk after cleanup (issue #25)'
            Assert-Hdo ((& $listedWorktreeCount $longPathWorktree.path) -eq 0) 'git no longer lists the long-path worktree after cleanup (issue #25)'

            # Case 2: a global config FILE with core.longpaths=false beats the -c that
            # Invoke-HdoGit prepends (git fixes the value while it is still reading its config
            # files; GIT_CONFIG_COUNT would NOT override -c), so `git worktree remove` fails with
            # "Filename too long" after unregistering the worktree and the filesystem fallback
            # has to finish the job. The raw-git probe first proves that this environment really
            # produces the failure, so the fallback assertions below cannot pass vacuously.
            $longPathFalseConfig = Join-Path $repositoryRoot "test-results/longpath-gitconfig-false-$([guid]::NewGuid().ToString('N'))"
            [IO.File]::WriteAllText($longPathFalseConfig, "[core]`n`tlongpaths = false`n")
            $env:GIT_CONFIG_GLOBAL = $longPathFalseConfig
            $probeWorktree = & $newLongPathRun 'issue-25-probe'
            & git -C $longPathRepository -c core.longpaths=true worktree remove --force $probeWorktree.path 2>$null
            Assert-Hdo (Test-Path -LiteralPath $probeWorktree.path -PathType Container) 'a global core.longpaths=false makes git worktree remove fail on the long path even with -c core.longpaths=true (fallback precondition)'
            Assert-Hdo ((& $listedWorktreeCount $probeWorktree.path) -eq 0) 'git unregistered the worktree before failing on the long path (fallback precondition)'
            Remove-Item -LiteralPath $probeWorktree.path -Recurse -Force
            & git -C $longPathRepository worktree prune
            $fallbackWorktree = & $newLongPathRun 'issue-25-fallback'
            $fallbackResult = Remove-HdoRunWorktree -RunId 'issue-25-fallback' -RepositoryPath $longPathRepository -ConfigPath $longPathConfigOverride -IgnoreRepositoryConfig -Force -Confirm:$false
            Assert-Hdo ($fallbackResult.removed -eq $true) 'cleanup falls back to a filesystem delete when git fails with Filename too long after unregistering the worktree (issue #25)'
            Assert-Hdo (-not (Test-Path -LiteralPath $fallbackWorktree.path)) 'the fallback removed the long-path worktree directory (issue #25)'
            Assert-Hdo ((& $listedWorktreeCount $fallbackWorktree.path) -eq 0) 'git does not list the worktree after the fallback (issue #25)'

            # Case 3: a worktree that an earlier, unfixed cleanup already orphaned (directory on
            # disk, admin entry gone) is refused without -Force and removed with -Force.
            $orphanWorktree = & $newLongPathRun 'issue-25-orphan'
            & git -C $longPathRepository worktree remove --force $orphanWorktree.path 2>$null
            Assert-Hdo (Test-Path -LiteralPath $orphanWorktree.path -PathType Container) 'plain git worktree remove leaves the long-path directory behind with core.longpaths=false (issue #25 reproduction)'
            Assert-Hdo ((& $listedWorktreeCount $orphanWorktree.path) -eq 0) 'plain git worktree remove already unregistered the orphaned worktree (issue #25 reproduction)'
            $orphanError = $null
            try {
                Remove-HdoRunWorktree -RunId 'issue-25-orphan' -RepositoryPath $longPathRepository -ConfigPath $longPathConfigOverride -IgnoreRepositoryConfig -Confirm:$false | Out-Null
            }
            catch { $orphanError = $_.Exception.Message }
            Assert-Hdo ($orphanError -like 'Refusing cleanup because Git does not list the target as a worktree:*-Force*') "an orphaned worktree is refused without -Force and the message says how to proceed (got: $orphanError)"
            Assert-Hdo (Test-Path -LiteralPath $orphanWorktree.path -PathType Container) 'the orphaned worktree stays on disk when cleanup is refused'
            $orphanResult = Remove-HdoRunWorktree -RunId 'issue-25-orphan' -RepositoryPath $longPathRepository -ConfigPath $longPathConfigOverride -IgnoreRepositoryConfig -Force -Confirm:$false
            Assert-Hdo ($orphanResult.removed -eq $true) 'an orphaned HDO worktree is removed with -Force (issue #25 recovery)'
            Assert-Hdo (-not (Test-Path -LiteralPath $orphanWorktree.path)) 'the orphaned worktree directory is gone after -Force cleanup (issue #25 recovery)'
            $env:GIT_CONFIG_GLOBAL = $longPathGlobalConfig

            # Case 4: the orphan path only ever removes HDO's own worktree slot. A directory at
            # that path that is a Git checkout of its own, or whose run branch is gone, is refused
            # even with -Force.
            $strangerWorktree = & $newLongPathRun 'issue-25-stranger' -SkipDeepPath
            & git -C $longPathRepository worktree remove --force $strangerWorktree.path
            & git -C $longPathRepository worktree prune
            New-Item -ItemType Directory -Path $strangerWorktree.path -Force | Out-Null
            & git -C $strangerWorktree.path init --quiet
            [IO.File]::WriteAllText((Join-Path $strangerWorktree.path 'keep.txt'), 'not an HDO worktree')
            $strangerError = $null
            try {
                Remove-HdoRunWorktree -RunId 'issue-25-stranger' -RepositoryPath $longPathRepository -ConfigPath $longPathConfigOverride -IgnoreRepositoryConfig -Force -Confirm:$false | Out-Null
            }
            catch { $strangerError = $_.Exception.Message }
            Assert-Hdo ($strangerError -eq "Refusing cleanup because Git does not list the target as a worktree: $($strangerWorktree.path)") "a foreign Git checkout at the worktree path is refused even with -Force (got: $strangerError)"
            Assert-Hdo (Test-Path -LiteralPath (Join-Path $strangerWorktree.path 'keep.txt') -PathType Leaf) 'the foreign checkout is left untouched'
            Remove-Item -LiteralPath (Join-Path $strangerWorktree.path '.git') -Recurse -Force
            & git -C $longPathRepository branch -D $strangerWorktree.branch --quiet
            $strangerError = $null
            try {
                Remove-HdoRunWorktree -RunId 'issue-25-stranger' -RepositoryPath $longPathRepository -ConfigPath $longPathConfigOverride -IgnoreRepositoryConfig -Force -Confirm:$false | Out-Null
            }
            catch { $strangerError = $_.Exception.Message }
            Assert-Hdo ($strangerError -eq "Refusing cleanup because Git does not list the target as a worktree: $($strangerWorktree.path)") "a leftover directory whose run branch no longer exists is refused even with -Force (got: $strangerError)"
            Assert-Hdo (Test-Path -LiteralPath (Join-Path $strangerWorktree.path 'keep.txt') -PathType Leaf) 'the directory without a run branch is left untouched'

            # Case 5: the fallback must never delete a worktree that git itself declined to
            # remove for a reason other than "Filename too long": a locked worktree (single
            # --force is not enough for git) surfaces git's own failure and stays on disk.
            $lockedWorktree = & $newLongPathRun 'issue-25-locked' -SkipDeepPath
            & git -C $longPathRepository worktree lock --reason 'hdo test lock' $lockedWorktree.path
            $lockedError = $null
            try {
                Remove-HdoRunWorktree -RunId 'issue-25-locked' -RepositoryPath $longPathRepository -ConfigPath $longPathConfigOverride -IgnoreRepositoryConfig -Force -Confirm:$false | Out-Null
            }
            catch { $lockedError = $_.Exception.Message }
            Assert-Hdo ($lockedError -like "Command 'git' failed with exit code *") "a locked worktree surfaces git's own failure instead of being force-deleted by the long-path fallback (got: $lockedError)"
            Assert-Hdo (Test-Path -LiteralPath $lockedWorktree.path -PathType Container) 'a locked worktree stays on disk when git refuses to remove it (issue #25 fallback guard)'
            & git -C $longPathRepository worktree unlock $lockedWorktree.path
        }
        finally {
            foreach ($name in $savedGitEnvironment.Keys) {
                # SetEnvironmentVariable(name, $null) leaves an empty-string variable behind on
                # pwsh 7 (and GIT_CONFIG_GLOBAL="" makes git ignore the global config entirely),
                # so previously-unset variables are removed rather than assigned.
                if ($null -eq $savedGitEnvironment[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
                else { [Environment]::SetEnvironmentVariable($name, $savedGitEnvironment[$name]) }
            }
            foreach ($cleanupPath in @($longPathWorktreeRoot, $longPathArtifactRoot, $longPathRepository)) {
                try {
                    if (Test-Path -LiteralPath $cleanupPath) { Remove-HdoTestDirectory $cleanupPath }
                }
                catch { Write-Host "WARN: failed to clean up '$cleanupPath': $($_.Exception.Message)" -ForegroundColor Yellow }
            }
            foreach ($configFile in @($longPathGlobalConfig, (Get-Variable -Name longPathFalseConfig -ValueOnly -ErrorAction SilentlyContinue))) {
                if ($configFile -and (Test-Path -LiteralPath $configFile)) { Remove-Item -LiteralPath $configFile -Force -ErrorAction SilentlyContinue }
            }
        }
    }
    else {
        Write-Host 'SKIP: long-path worktree cleanup regression test (issue #25) only runs on Windows.' -ForegroundColor Yellow
    }

    # ADR-0001 phase-6 PS oracle self-check: runs the full plan -> implement -> validate ->
    # review -> fix loop in-process through Invoke-HdoRun -NoWriteBack against the shared
    # workflow fixtures (tests/fixtures/workflow/**), using scenario b (fix-then-approve,
    # exercises the CHANGES_REQUESTED -> IMPLEMENTING fix loop) and scenario g (a validation
    # gate setup failure, issue #16 AC-02/AC-06) - so this oracle is pinned BEFORE any TS
    # implementation is compared against it (§3.6 of the phase-6 plan).
    $workflowFixturesRoot = Join-Path $repositoryRoot 'tests/fixtures/workflow'
    $originalWorkflowPath = $env:PATH
    $originalWorkflowGhToken = $env:GH_TOKEN
    $originalWorkflowGitHubToken = $env:GITHUB_TOKEN
    $workflowTestRoot = Join-Path $testAppData "workflow-oracle-$([guid]::NewGuid().ToString('N'))"
    try {
        function New-HdoWorkflowFixtureRepository {
            param([Parameter(Mandatory)][string]$Path)
            New-Item -ItemType Directory -Path $Path -Force | Out-Null
            & git -C $Path init -q
            & git -C $Path config user.email 'hdo-tests@example.invalid'
            & git -C $Path config user.name 'HDO Tests'
            & git -C $Path config commit.gpgSign false
            & git -C $Path config core.autocrlf false
            New-Item -ItemType Directory -Path (Join-Path $Path '.hdo') -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $Path 'tools') -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $workflowFixturesRoot 'project.json') -Destination (Join-Path $Path '.hdo/project.json') -Force
            Copy-Item -LiteralPath (Join-Path $workflowFixturesRoot 'tools/gate-pass.ps1') -Destination (Join-Path $Path 'tools/gate-pass.ps1') -Force
            Copy-Item -LiteralPath (Join-Path $workflowFixturesRoot 'tools/gate-fail.ps1') -Destination (Join-Path $Path 'tools/gate-fail.ps1') -Force
            Set-Content -LiteralPath (Join-Path $Path 'README.md') -Value 'fixture' -Encoding utf8NoBOM
            Set-Content -LiteralPath (Join-Path $Path 'tracked.txt') -Value 'baseline' -Encoding utf8NoBOM
            & git -C $Path add -A
            & git -C $Path commit -q -m baseline
        }

        function New-HdoWorkflowMockGhDirectory {
            param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string[]]$Gates)
            New-Item -ItemType Directory -Path $Path -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $workflowFixturesRoot 'gh/gh.cmd') -Destination (Join-Path $Path 'gh.cmd') -Force
            Copy-Item -LiteralPath (Join-Path $workflowFixturesRoot 'gh/issue-events.json') -Destination (Join-Path $Path 'issue-events.json') -Force
            Copy-Item -LiteralPath (Join-Path $workflowFixturesRoot 'gh/issue-comments.json') -Destination (Join-Path $Path 'issue-comments.json') -Force
            Copy-Item -LiteralPath (Join-Path $workflowFixturesRoot 'gh/graphql-last-edited.json') -Destination (Join-Path $Path 'graphql-last-edited.json') -Force
            $gateLines = ($Gates | ForEach-Object { "- $_" }) -join '\n'
            $template = Get-Content -LiteralPath (Join-Path $workflowFixturesRoot 'gh/issue-view.template.json') -Raw
            Set-Content -LiteralPath (Join-Path $Path 'issue-view.json') -Value ($template.Replace('__VALIDATION_GATES__', $gateLines)) -Encoding utf8NoBOM
        }

        function New-HdoWorkflowOverlay {
            param(
                [Parameter(Mandatory)][string]$Path,
                [Parameter(Mandatory)][string]$ScenarioId,
                [Parameter(Mandatory)][string]$WorktreeRoot,
                [Parameter(Mandatory)][string]$ArtifactRoot,
                [string]$OnNoDiff = 'fail',
                [string]$OnValidationFailure = 'request-changes',
                [string]$OnMaxFixAttempts = 'escalate'
            )
            $mockRunnerArgs = @(
                '-NoProfile', '-File', '{hdoRoot}/tests/fixtures/workflow/mock-workflow-agent.ps1',
                '-SchemaFile', '{schemaFile}', '-OutputFile', '{outputFile}',
                '-Scenario', "{hdoRoot}/tests/fixtures/workflow/scenarios/$ScenarioId.json"
            )
            $overlay = [ordered]@{
                activeProfile = 'mock'
                profiles = [ordered]@{ mock = [ordered]@{ steps = [ordered]@{ plan = 'mock-plan'; implement = 'mock-implement'; review = 'mock-review'; fix = 'mock-implement' } } }
                runners = [ordered]@{
                    'mock-plan' = [ordered]@{ type = 'command'; provider = 'custom'; command = 'pwsh'; sandbox = 'read-only'; timeoutSeconds = 60; passEnvironment = @(); extraArgs = $mockRunnerArgs; promptTransport = 'stdin' }
                    'mock-implement' = [ordered]@{ type = 'command'; provider = 'custom'; command = 'pwsh'; sandbox = 'workspace-write'; timeoutSeconds = 60; passEnvironment = @(); extraArgs = $mockRunnerArgs; promptTransport = 'stdin' }
                    'mock-review' = [ordered]@{ type = 'command'; provider = 'custom'; command = 'pwsh'; sandbox = 'read-only'; timeoutSeconds = 60; passEnvironment = @(); extraArgs = $mockRunnerArgs; promptTransport = 'stdin' }
                }
                github = [ordered]@{ writeBack = 'status'; trustedActors = @(); assignOnClaim = $false }
                workflow = [ordered]@{ maxFixAttempts = 2; implicitFallback = $false; onNoDiff = $OnNoDiff; onValidationFailure = $OnValidationFailure; onMaxFixAttempts = $OnMaxFixAttempts }
                paths = [ordered]@{ worktreeRoot = $WorktreeRoot; artifactRoot = $ArtifactRoot }
                projectContractPath = '.hdo/project.json'
            }
            $overlay | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM
        }

        function Invoke-HdoWorkflowOracleScenario {
            param(
                [Parameter(Mandatory)][string]$ScenarioId,
                [Parameter(Mandatory)][string[]]$Gates,
                [string]$OnNoDiff = 'fail',
                [string]$OnValidationFailure = 'request-changes',
                [string]$OnMaxFixAttempts = 'escalate'
            )
            $scenarioRoot = Join-Path $workflowTestRoot $ScenarioId
            $fixtureRepository = Join-Path $scenarioRoot 'repo'
            $mockGhDirectory = Join-Path $scenarioRoot 'gh'
            $overlayPath = Join-Path $scenarioRoot 'overlay.json'
            $worktreeRoot = Join-Path $scenarioRoot 'worktrees'
            $artifactRoot = Join-Path $scenarioRoot 'runs'
            New-HdoWorkflowFixtureRepository -Path $fixtureRepository
            New-HdoWorkflowMockGhDirectory -Path $mockGhDirectory -Gates $Gates
            New-HdoWorkflowOverlay -Path $overlayPath -ScenarioId $ScenarioId -WorktreeRoot $worktreeRoot -ArtifactRoot $artifactRoot `
                -OnNoDiff $OnNoDiff -OnValidationFailure $OnValidationFailure -OnMaxFixAttempts $OnMaxFixAttempts
            $env:PATH = "$mockGhDirectory;$originalWorkflowPath"
            $env:GH_TOKEN = $null
            $env:GITHUB_TOKEN = $null
            Remove-Item -LiteralPath Env:GH_TOKEN -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
            return & $module {
                param($IssueNumber, $Repository, $RepositoryPath, $ConfigPath)
                Invoke-HdoRun -IssueNumber $IssueNumber -Repository $Repository -RepositoryPath $RepositoryPath -ConfigPath $ConfigPath -NoWriteBack
            } 7 'hdo-fixture/repo' $fixtureRepository $overlayPath
        }

        # Scenario b (fix-then-approve): round 1 request_changes -> fix iteration 2 ->
        # round 2 approve. Exercises the CHANGES_REQUESTED -> IMPLEMENTING fix loop and the
        # transition list, fixAttempts, and diffHash contract of §2.2-2.4 of the plan.
        $scenarioBRun = Invoke-HdoWorkflowOracleScenario -ScenarioId 'b' -Gates @('gate-pass')
        Assert-Hdo ($scenarioBRun.state -eq 'APPROVED') "scenario b (fix-then-approve) reaches APPROVED (got state=$($scenarioBRun.state), error=$($scenarioBRun.error | ConvertTo-Json -Compress))"
        Assert-Hdo ([int]$scenarioBRun.iteration -eq 2 -and [int]$scenarioBRun.fixAttempts -eq 1) "scenario b runs exactly 2 iterations with 1 fix attempt (got iteration=$($scenarioBRun.iteration) fixAttempts=$($scenarioBRun.fixAttempts))"
        Assert-Hdo ($null -eq $scenarioBRun.github.claim) 'scenario b: -NoWriteBack leaves github.claim null even though the overlay sets github.writeBack to "status"'
        Assert-Hdo ($scenarioBRun.Contains('activity') -and $null -eq $scenarioBRun.activity) 'scenario b: the activity key is present (an agent step ran) and null (no step is currently running) once the run is terminal'
        Assert-Hdo ($scenarioBRun.result.decision -eq 'approve' -and $scenarioBRun.result.summary -eq 'Mock review round 2: approve.') "scenario b result is approve with the round-2 mock summary (got: $($scenarioBRun.result | ConvertTo-Json -Compress -Depth 6))"
        $scenarioBEventLines = Get-Content -LiteralPath (Join-Path $scenarioBRun.artifactPath 'events.jsonl')
        $scenarioBEvents = @($scenarioBEventLines | ForEach-Object { & $module { param($Line) ConvertFrom-HdoJson -Json $Line -AsHashtable } $_ })
        $scenarioBTransitions = @($scenarioBEvents | Where-Object { $_.type -eq 'state.transition' } | ForEach-Object { "$($_.from)->$($_.to)" })
        $expectedScenarioBTransitions = @(
            'CREATED->ISSUE_SELECTED', 'ISSUE_SELECTED->PREFLIGHT', 'PREFLIGHT->WORKTREE_READY', 'WORKTREE_READY->PLANNING',
            'PLANNING->IMPLEMENTING', 'IMPLEMENTING->VALIDATING', 'VALIDATING->REVIEWING', 'REVIEWING->CHANGES_REQUESTED',
            'CHANGES_REQUESTED->IMPLEMENTING', 'IMPLEMENTING->VALIDATING', 'VALIDATING->REVIEWING', 'REVIEWING->APPROVED'
        )
        Assert-Hdo ((($scenarioBTransitions -join ',') -eq ($expectedScenarioBTransitions -join ','))) "scenario b state.transition events match the plan's happy/fix-loop sequence exactly (got: $($scenarioBTransitions -join ' -> '))"
        Assert-Hdo (@($scenarioBEvents | ForEach-Object { $_.type }) -contains 'run.created') 'scenario b events.jsonl begins with a run.created event'
        $scenarioBFinalDiff = & $module { param($Path) Read-HdoJsonFile $Path } (Join-Path $scenarioBRun.artifactPath 'iterations/002/diff.json')
        Assert-Hdo ($scenarioBFinalDiff.hash -eq $scenarioBRun.result.diffHash) 'scenario b result.diffHash equals iterations/002/diff.json hash (the final, second-iteration diff)'

        # Scenario g (gate-setup-failure): the first gate's command cannot be started, so
        # (issue #16 AC-02/AC-06) the second gate must be skipped even though
        # continueAfterFailure is true, and validation.allRequiredPassed must be false.
        $scenarioGRun = Invoke-HdoWorkflowOracleScenario -ScenarioId 'g' -Gates @('gate-setup', 'gate-after') -OnValidationFailure 'escalate'
        Assert-Hdo ($scenarioGRun.state -eq 'ESCALATED') "scenario g (gate-setup-failure) reaches ESCALATED (got state=$($scenarioGRun.state), error=$($scenarioGRun.error | ConvertTo-Json -Compress))"
        Assert-Hdo ($scenarioGRun.result.decision -eq 'escalate' -and $scenarioGRun.result.summary -eq 'Required validation did not pass.') "scenario g escalates with the validation-policy summary (got: $($scenarioGRun.result | ConvertTo-Json -Compress -Depth 6))"
        $scenarioGValidation = & $module { param($Path) Read-HdoJsonFile $Path } (Join-Path $scenarioGRun.artifactPath 'iterations/001/validation/result.json')
        Assert-Hdo (-not $scenarioGValidation.allRequiredPassed -and [int]$scenarioGValidation.indeterminate -eq 2) "scenario g validation summary: allRequiredPassed=false, indeterminate=2 (got: $($scenarioGValidation | ConvertTo-Json -Compress -Depth 5))"
        $scenarioGGateSetup = $scenarioGValidation.gates[0]
        $scenarioGGateAfter = $scenarioGValidation.gates[1]
        Assert-Hdo ($scenarioGGateSetup.status -eq 'indeterminate' -and $scenarioGGateSetup.failureClass -eq 'setup' -and -not $scenarioGGateSetup.skipped) "scenario g gate-setup is classified indeterminate/setup, not skipped (issue #16; got: $($scenarioGGateSetup | ConvertTo-Json -Compress))"
        Assert-Hdo ($scenarioGGateAfter.status -eq 'indeterminate' -and $scenarioGGateAfter.failureClass -eq 'skipped' -and $scenarioGGateAfter.skipped -eq $true) "scenario g gate-after is skipped after the setup failure even though continueAfterFailure is true (issue #16 AC-02/AC-06; got: $($scenarioGGateAfter | ConvertTo-Json -Compress))"
    }
    finally {
        $env:PATH = $originalWorkflowPath
        if ($null -eq $originalWorkflowGhToken) { Remove-Item -LiteralPath Env:GH_TOKEN -ErrorAction SilentlyContinue } else { $env:GH_TOKEN = $originalWorkflowGhToken }
        if ($null -eq $originalWorkflowGitHubToken) { Remove-Item -LiteralPath Env:GITHUB_TOKEN -ErrorAction SilentlyContinue } else { $env:GITHUB_TOKEN = $originalWorkflowGitHubToken }
        if (Test-Path -LiteralPath $workflowTestRoot) { Remove-HdoTestDirectory $workflowTestRoot }
    }
}
catch {
    $failures.Add("Unexpected test error: $($_.Exception.Message)`n$($_.ScriptStackTrace)")
}

if (Test-Path -LiteralPath $testAppData) { Remove-Item -LiteralPath $testAppData -Recurse -Force }

Write-Host "`n$passes assertion(s) passed; $($failures.Count) failed."
if ($failures.Count -gt 0) {
    foreach ($failure in $failures) { Write-Host " - $failure" -ForegroundColor Red }
    exit 1
}
exit 0
