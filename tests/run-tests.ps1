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
    Assert-Hdo ($config.resolvedProfile -eq 'cloud-only') 'default profile is cloud-only'
    Assert-Hdo ($config.runners['cloud-planner'].passEnvironment -is [array]) 'empty JSON arrays remain arrays after configuration merge'
    Assert-Hdo ($config.runners['cloud-planner'].passEnvironment.Count -eq 0) 'empty passEnvironment remains empty'

    $userConfigDirectory = Join-Path $testAppData 'hdo'
    New-Item -ItemType Directory -Path $userConfigDirectory -Force | Out-Null
    $userConfigPath = Join-Path $userConfigDirectory 'config.json'
    $explicitConfigPath = Join-Path $testAppData 'explicit.json'
    [ordered]@{
        workflow = [ordered]@{ maxFixAttempts = 1 }
        github = [ordered]@{ priorityOrder = @('hdo:priority/p3') }
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $userConfigPath -Encoding utf8NoBOM
    [ordered]@{
        workflow = [ordered]@{ maxFixAttempts = 3 }
        github = [ordered]@{ priorityOrder = @('hdo:priority/p2', 'hdo:priority/p1') }
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $explicitConfigPath -Encoding utf8NoBOM
    $precedenceConfig = Get-HdoConfig -RepositoryPath $repositoryRoot -ConfigPath $explicitConfigPath
    Assert-Hdo ($precedenceConfig.workflow.maxFixAttempts -eq 3) 'explicit config overrides user config and distribution defaults'
    Assert-Hdo ($precedenceConfig.github.priorityOrder.Count -eq 2 -and $precedenceConfig.github.priorityOrder[0] -eq 'hdo:priority/p2') 'configuration arrays replace instead of concatenate during merge'
    Remove-Item -LiteralPath $userConfigPath, $explicitConfigPath -Force

    $otherRepository = Join-Path $testAppData 'target-repository'
    New-Item -ItemType Directory -Path (Join-Path $otherRepository '.hdo') -Force | Out-Null
    '{"activeProfile":"must-not-load"}' | Set-Content -LiteralPath (Join-Path $otherRepository '.hdo/config.json') -Encoding utf8NoBOM
    $repositoryConfig = Get-HdoConfig -RepositoryPath $otherRepository
    Assert-Hdo ($repositoryConfig.resolvedProfile -eq 'cloud-only') 'repository .hdo/config.json is not loaded implicitly'

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
    Assert-Hdo ($contract.dependencies.Count -eq 1 -and $contract.dependencies[0].number -eq 99) 'dependency references are normalized'
    Assert-Hdo ($contract.priority -eq 'p2' -and $contract.risk -eq 'medium') 'priority and risk are resolved'

    $sentinelIssue = Copy-HdoObject $issue
    $sentinelIssue.body = $issueBody.Replace("### Route Hint`n`n", "### Route Hint`n_No response_`n`n")
    $sentinelContract = ConvertTo-HdoIssueContract $sentinelIssue
    Assert-Hdo ($sentinelContract.preferredExecution -eq '') 'Issue Form _No response_ route is normalized to no route hint'

    $emptyRequiredIssue = Copy-HdoObject $issue
    $emptyRequiredIssue.body = $issueBody.Replace("AC-01: Parse the Issue form`nAC-02: Run trusted validation gates", '_No response_').Replace("tests`nschemas", '_No response_')
    $emptyRequiredContract = ConvertTo-HdoIssueContract $emptyRequiredIssue
    Assert-Hdo ($emptyRequiredContract.acceptanceCriteria.Count -eq 0 -and $emptyRequiredContract.validationGates.Count -eq 0) 'Issue Form _No response_ does not create required AC or gate entries'

    $projectContract = Get-Content -LiteralPath (Join-Path $repositoryRoot '.hdo/project.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    $contractResult = Test-HdoIssueContract -Contract $contract -Config $config -ProjectContract $projectContract -RequireReady
    Assert-Hdo $contractResult.valid 'valid Issue Form satisfies the semantic contract'
    $emptyRequiredResult = Test-HdoIssueContract -Contract $emptyRequiredContract -Config $config -ProjectContract $projectContract -RequireReady
    Assert-Hdo (-not $emptyRequiredResult.valid) 'Issue contract rejects empty required AC and gate sections'

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
    $badConfig.steps.review = 'cloud-implementer'
    $badConfigResult = Test-HdoConfiguration $badConfig
    Assert-Hdo (-not $badConfigResult.valid) 'review cannot use a workspace-write runner'

    $claudeContextConfig = Copy-HdoObject $config
    $claudeContextConfig.runners['cloud-planner'].type = 'claude'
    $claudeContextConfig.runners['cloud-planner'].command = 'claude'
    $claudeContextConfig.runners['cloud-planner'].contextTokens = 8192
    $claudeContextResult = Test-HdoConfiguration $claudeContextConfig
    Assert-Hdo (-not $claudeContextResult.valid) 'Claude runner rejects unsupported contextTokens configuration'

    $contextTokenExpansion = & $module {
        Expand-HdoArgumentTemplate '--context={contextTokens}' ([ordered]@{ contextTokens = 8192 })
    }
    Assert-Hdo ($contextTokenExpansion -eq '--context=8192') 'command argument templates can explicitly consume contextTokens'

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
    Assert-Hdo (@($hybridPlan.runners.Values | Where-Object provider -eq 'ollama').Count -eq 1) 'hybrid profile selects Ollama only through explicit configuration'

    $redacted = & $module { Protect-HdoText 'token=ghp_abcdefghijklmnopqrstuvwxyz123456 password=secret-value' }
    Assert-Hdo ($redacted -notmatch 'ghp_|secret-value') 'known credential forms are redacted'

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
            '{outputFile}'
        )
    }
    $runnerConfig = Copy-HdoObject $config
    $runnerConfig.runners['mock-plan'] = $mockRunner
    $runnerConfig.steps.plan = 'mock-plan'
    $tempRoot = Join-Path $repositoryRoot "test-results/runtime-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        $run = [ordered]@{ id = 'test-run'; state = 'PLANNING'; iteration = 0 }
        $agentResult = & $module {
            param($RunnerConfig, $Run, $WorkingDirectory, $ArtifactDirectory)
            Invoke-HdoAgentStep $RunnerConfig $Run 'plan' 0 $WorkingDirectory 'mock prompt' $ArtifactDirectory 'task-contract'
        } $runnerConfig $run $repositoryRoot $tempRoot
        Assert-Hdo ($agentResult.status -eq 'succeeded') 'generic command runner accepts prompt on stdin and returns structured output'
        Assert-Hdo ($agentResult.output.schemaVersion -eq 1) 'generic command runner output is schema validated'

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
