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
    return ($Value | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable -Depth 100)
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
        Assert-Hdo ($normalizedSchemaJson -notmatch '"\$schema"|"allOf"|"if"|"then"|"contains"') "Codex-normalized $codexSchemaName schema drops unsupported Structured Outputs keywords"
        Assert-Hdo ([string]$codexSchemas[$codexSchemaName].properties.schemaVersion.type -eq 'integer') "Codex-normalized $codexSchemaName schema infers the integer const type"
    }
    Assert-Hdo ([string]$codexSchemas['review-result'].properties.decision.type -eq 'string') 'Codex schema normalization infers string enum types'
    Assert-Hdo ($codexSchemas['review-result'].required -contains 'escalationReason') 'Codex review schema requires every root property'
    Assert-Hdo (@($codexSchemas['review-result'].properties.escalationReason.type) -contains 'null') 'Codex review schema represents the non-escalate reason as null'
    $codexReviewSchemaPath = Join-Path $testAppData 'codex-review-result.schema.json'
    $codexSchemas['review-result'] | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $codexReviewSchemaPath -Encoding utf8NoBOM
    Assert-Hdo ([bool]($validReviewJson | Test-Json -SchemaFile $codexReviewSchemaPath -ErrorAction SilentlyContinue)) 'valid review fixture passes the Codex transport schema'

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
