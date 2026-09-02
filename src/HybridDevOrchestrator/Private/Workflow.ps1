function Add-HdoPreflightCheck {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][Collections.Generic.List[object]]$Checks,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('pass', 'fail', 'warning', 'skipped')][string]$Status,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Message,
        [bool]$Required = $true
    )

    $Checks.Add([ordered]@{ name = $Name; status = $Status; required = $Required; message = Protect-HdoText $Message })
}

function Test-HdoEnvironment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [switch]$ReadOnly
    )

    $checks = [Collections.Generic.List[object]]::new()
    foreach ($commandName in @('git', 'gh')) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        Add-HdoPreflightCheck $checks "command:$commandName" $(if ($command) { 'pass' } else { 'fail' }) $(if ($command) { $command.Source } else { "$commandName was not found." })
    }
    if (Get-Command git -ErrorAction SilentlyContinue) {
        try {
            $root = Get-HdoRepositoryRoot ([string]$Config.repositoryPath)
            Add-HdoPreflightCheck $checks 'git:repository' 'pass' $root
        }
        catch { Add-HdoPreflightCheck $checks 'git:repository' 'fail' $_.Exception.Message }
    }
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        $auth = Invoke-HdoGh @('auth', 'status') ([string]$Config.repositoryPath) 60
        Add-HdoPreflightCheck $checks 'github:authentication' $(if ($auth.exitCode -eq 0) { 'pass' } else { 'fail' }) $(if ($auth.exitCode -eq 0) { 'GitHub CLI authentication is valid.' } else { $auth.stderr.Trim() })
    }

    try {
        $projectContract = Get-HdoProjectContract $Config
        Add-HdoPreflightCheck $checks 'project-contract' 'pass' "$(@($projectContract.validationGates).Count) validation gate(s) defined."
    }
    catch { Add-HdoPreflightCheck $checks 'project-contract' 'fail' $_.Exception.Message }

    $plan = Get-HdoExecutionPlan $Config
    $hasOllama = $false
    foreach ($runnerName in $plan.runners.Keys) {
        $runner = $plan.runners[$runnerName]
        $commandName = [string]$runner.command
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        Add-HdoPreflightCheck $checks "runner:$runnerName" $(if ($command) { 'pass' } else { 'fail' }) $(if ($command) { "$($runner.type) command '$commandName' is available." } else { "Runner command '$commandName' was not found." })
        # The Claude adapter passes the normalized JSON schema inline via --json-schema
        # (the CLI accepts no file path there). cmd.exe batch shims re-parse arguments and
        # cap the command line at 8191 characters, so an npm .cmd shim can corrupt or
        # truncate that argument even though a native install works.
        if ([string]$runner.type -eq 'claude' -and $command -and [IO.Path]::GetExtension([string]$command.Source) -in @('.cmd', '.bat')) {
            Add-HdoPreflightCheck $checks "runner:${runnerName}:shim" 'warning' "Claude command '$commandName' resolves to the batch shim '$($command.Source)'. cmd.exe argument re-parsing can corrupt the inline --json-schema argument; prefer a native claude install." $false
        }
        if ([string](Get-HdoValue $runner 'provider' 'cloud') -eq 'ollama') { $hasOllama = $true }
    }

    if ($hasOllama) {
        $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
        if (-not $ollamaCommand) {
            Add-HdoPreflightCheck $checks 'provider:ollama' 'fail' 'Ollama is selected by the active profile but the ollama command was not found.'
        }
        else {
            $list = Invoke-HdoProcess -Command 'ollama' -Arguments @('list') -WorkingDirectory ([string]$Config.repositoryPath) -TimeoutSeconds 60
            if ($list.exitCode -ne 0) {
                Add-HdoPreflightCheck $checks 'provider:ollama' 'fail' "Ollama is selected but unavailable: $($list.stderr.Trim())"
            }
            else {
                Add-HdoPreflightCheck $checks 'provider:ollama' 'pass' 'Ollama is available.'
                foreach ($runnerName in $plan.runners.Keys) {
                    $runner = $plan.runners[$runnerName]
                    if ([string](Get-HdoValue $runner 'provider' 'cloud') -ne 'ollama') { continue }
                    $model = [string]$runner.model
                    $found = @($list.stdout -split "`r?`n" | Where-Object { $_ -match "^$([regex]::Escape($model))\s" }).Count -gt 0
                    Add-HdoPreflightCheck $checks "ollama-model:$model" $(if ($found) { 'pass' } else { 'fail' }) $(if ($found) { "Model '$model' is installed." } else { "Model '$model' is not installed. HDO will not pull it automatically." })
                }
            }
        }
    }
    else {
        Add-HdoPreflightCheck $checks 'provider:ollama' 'skipped' 'No active step references Ollama; no Ollama probe was performed.' $false
    }

    if ($ReadOnly) {
        Add-HdoPreflightCheck $checks 'paths:writable' 'skipped' 'Read-only preflight does not create probe files.' $false
    }
    else {
        foreach ($entry in @(
            [ordered]@{ name = 'worktreeRoot'; path = [string]$Config.paths.worktreeRoot },
            [ordered]@{ name = 'artifactRoot'; path = [string]$Config.paths.artifactRoot }
        )) {
            try {
                New-Item -ItemType Directory -Path $entry.path -Force | Out-Null
                $probe = Join-Path $entry.path ".hdo-write-probe-$([guid]::NewGuid().ToString('N'))"
                [IO.File]::WriteAllText($probe, 'probe')
                Remove-Item -LiteralPath $probe -Force
                Add-HdoPreflightCheck $checks "paths:$($entry.name)" 'pass' $entry.path
            }
            catch { Add-HdoPreflightCheck $checks "paths:$($entry.name)" 'fail' $_.Exception.Message }
        }
    }

    $requiredFailures = @($checks | Where-Object { $_.required -and $_.status -eq 'fail' })
    return [ordered]@{
        schemaVersion = 1
        ok = $requiredFailures.Count -eq 0
        readOnly = [bool]$ReadOnly
        profile = $Config.resolvedProfile
        checkedAt = Get-HdoUtcTimestamp
        checks = @($checks)
    }
}

function Test-HdoWriteBackEnabled {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [switch]$NoWriteBack
    )

    if ($NoWriteBack) { return $false }
    $setting = Get-HdoValue $Config 'github.writeBack' 'status'
    if ($setting -is [bool]) { return $setting }
    return [string]$setting -notin @('', 'none', 'false', 'off')
}

function Set-HdoIssuePhaseBestEffort {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Run,
        [Parameter(Mandatory)][string]$LabelKey,
        [Parameter(Mandatory)][string]$Fallback,
        [Parameter(Mandatory)][string]$ArtifactPath
    )

    try {
        $label = [string](Get-HdoValue $Config $LabelKey $Fallback)
        Set-HdoManagedStatusLabel $Config ([string]$Run.issue.repository) ([int]$Run.issue.number) $label
        Add-HdoRunEvent $ArtifactPath ([ordered]@{ type = 'github.status.updated'; label = $label; issue = $Run.issue.number })
    }
    catch {
        $Run.warnings += "GitHub status update failed: $($_.Exception.Message)"
        Add-HdoRunEvent $ArtifactPath ([ordered]@{ type = 'github.status.failed'; labelKey = $LabelKey; message = Protect-HdoText $_.Exception.Message })
        Save-HdoRun $Run $ArtifactPath
    }
}

function Get-HdoWorktreeProjectContract {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [Parameter(Mandatory)][string]$WorktreePath
    )

    $relative = [System.IO.Path]::GetRelativePath([string]$Config.repositoryPath, [string]$Config.projectContractPath)
    if ($relative.StartsWith('..')) { throw 'projectContractPath must be inside the target repository.' }
    $worktreeConfig = ConvertTo-HdoHashtable $Config
    $worktreeConfig.projectContractPath = [System.IO.Path]::GetFullPath((Join-Path $WorktreePath $relative))
    return Get-HdoProjectContract $worktreeConfig
}

function New-HdoSyntheticTaskContract {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$IssueContract)

    return [ordered]@{
        schemaVersion = 1
        objective = $IssueContract.goal
        approach = @('Implement the normalized GitHub Issue contract directly.')
        acceptanceCriteria = @($IssueContract.acceptanceCriteria | ForEach-Object { "$($_.id): $($_.text)" })
        expectedFiles = @()
        risks = @()
        assumptions = @()
    }
}

function Invoke-HdoRun {
    [CmdletBinding()]
    param(
        [int]$IssueNumber,
        [switch]$Pick,
        [string]$RepositoryPath = (Get-Location).Path,
        [string]$Repository,
        [string[]]$ConfigPath,
        [string]$Profile,
        [System.Collections.IDictionary]$StepOverrides = @{},
        [switch]$IgnoreRepositoryConfig,
        [switch]$DryRun,
        [switch]$NoWriteBack
    )

    $repositoryRoot = Get-HdoRepositoryRoot $RepositoryPath
    $config = Get-HdoConfig -RepositoryPath $repositoryRoot -ConfigPath $ConfigPath -Profile $Profile -StepOverrides $StepOverrides -IgnoreRepositoryConfig:$IgnoreRepositoryConfig
    if (-not $Repository) { $Repository = Resolve-HdoRepositorySlug $config }
    if ($IssueNumber -le 0) {
        if (-not $Pick) { throw 'Specify -IssueNumber or -Pick.' }
        $candidates = @(Get-HdoIssueCandidate -Config $config -Repository $Repository)
        if ($candidates.Count -eq 0) { throw "No eligible HDO Issue was found in $Repository." }
        $IssueNumber = [int]$candidates[0].number
    }

    $issue = Get-HdoIssue -Number $IssueNumber -Config $config -Repository $Repository
    if ([string]$issue.state -ne 'OPEN') { throw "Issue #$IssueNumber is not open." }
    $issueContract = ConvertTo-HdoIssueContract $issue
    if (-not $Profile -and [string]$issueContract.preferredExecution -and [string]$issueContract.preferredExecution -ne [string]$config.resolvedProfile) {
        $config = Get-HdoConfig -RepositoryPath $repositoryRoot -ConfigPath $ConfigPath -Profile ([string]$issueContract.preferredExecution) -StepOverrides $StepOverrides -IgnoreRepositoryConfig:$IgnoreRepositoryConfig
    }
    $projectContract = Get-HdoProjectContract $config
    $projectContractHash = Get-HdoSha256 ($projectContract | ConvertTo-Json -Depth 100 -Compress)
    $contractValidation = Test-HdoIssueContract -Contract $issueContract -Config $config -ProjectContract $projectContract -RequireReady
    if (-not $contractValidation.valid) {
        throw "Issue #$IssueNumber does not satisfy the HDO contract:`n - $($contractValidation.errors -join "`n - ")"
    }
    $readyAuthorization = Test-HdoReadyLabelAuthorization $config $Repository $IssueNumber ([string]$issue.updatedAt)
    if (-not $readyAuthorization.authorized) { throw "Issue #$IssueNumber ready authorization failed: $($readyAuthorization.reason)" }
    $dependencyValidation = Test-HdoIssueDependencies $config $issueContract
    if (-not $dependencyValidation.resolved) {
        $blockedDependencies = @($dependencyValidation.unresolved | ForEach-Object { "$($_.repository)#$($_.number) [$($_.state)]" })
        throw "Issue #$IssueNumber has unresolved or unverifiable dependencies: $($blockedDependencies -join ', ')"
    }
    $activeClaims = @(Get-HdoClaimComments $config $Repository $IssueNumber | Where-Object { $_.status -eq 'active' })
    if ($activeClaims.Count -gt 0) {
        throw "Issue #$IssueNumber already has an active HDO run: $($activeClaims.runId -join ', ')"
    }
    $executionPlan = Get-HdoExecutionPlan $config
    if ($DryRun) {
        $preflight = Test-HdoEnvironment -Config $config -ReadOnly
        return [ordered]@{
            kind = 'execution-plan'
            dryRun = $true
            issue = $issueContract
            contractValidation = $contractValidation
            readyAuthorization = $readyAuthorization
            dependencyValidation = $dependencyValidation
            execution = $executionPlan
            preflight = $preflight
            mutations = @()
        }
    }

    $runId = New-HdoRunId $IssueNumber
    $artifactPath = Join-Path ([string]$config.paths.artifactRoot) $runId
    New-Item -ItemType Directory -Path $artifactPath -Force | Out-Null
    $writeBack = Test-HdoWriteBackEnabled $config -NoWriteBack:$NoWriteBack
    $run = [ordered]@{
        schemaVersion = 1
        id = $runId
        state = 'CREATED'
        createdAt = Get-HdoUtcTimestamp
        updatedAt = Get-HdoUtcTimestamp
        repositoryPath = $repositoryRoot
        artifactPath = $artifactPath
        profile = $config.resolvedProfile
        iteration = 0
        fixAttempts = 0
        maxFixAttempts = [int]$config.workflow.maxFixAttempts
        issue = $issueContract.issue
        execution = $executionPlan
        worktree = $null
        github = [ordered]@{ writeBack = $writeBack; readyAuthorization = $readyAuthorization; dependencyValidation = $dependencyValidation; claim = $null }
        result = $null
        error = $null
        warnings = @($contractValidation.warnings) + @($config.configurationWarnings)
    }
    Save-HdoRun $run $artifactPath
    Add-HdoRunEvent $artifactPath ([ordered]@{ type = 'run.created'; runId = $runId })
    Write-HdoJsonFile (Join-Path $artifactPath 'issue.raw.json') $issue
    Write-HdoJsonFile (Join-Path $artifactPath 'issue.contract.json') $issueContract
    Write-HdoJsonFile (Join-Path $artifactPath 'execution-plan.json') $executionPlan
    Write-HdoJsonFile (Join-Path $artifactPath 'effective-config.redacted.json') (Protect-HdoObject $config)

    try {
        Set-HdoRunState $run 'ISSUE_SELECTED' $artifactPath 'GitHub Issue resolved and contract validated.'
        Set-HdoRunState $run 'PREFLIGHT' $artifactPath 'Checking selected adapters and local environment.'
        $preflight = Test-HdoEnvironment -Config $config
        Write-HdoJsonFile (Join-Path $artifactPath 'environment.json') $preflight
        if (-not $preflight.ok) {
            $messages = @($preflight.checks | Where-Object { $_.required -and $_.status -eq 'fail' } | ForEach-Object { "$($_.name): $($_.message)" })
            throw "Preflight failed: $($messages -join '; ')"
        }

        if ($writeBack) {
            $run.github.claim = Claim-HdoIssue $config $issue $runId
            if ($run.github.claim.warning) { $run.warnings += $run.github.claim.warning }
            Save-HdoRun $run $artifactPath
            Set-HdoRunState $run 'ISSUE_CLAIMED' $artifactPath 'GitHub claim marker won the best-effort lock.'
        }

        $worktree = New-HdoWorktree $config $runId $IssueNumber
        $run.worktree = $worktree
        Write-HdoJsonFile (Join-Path $artifactPath 'worktree.json') $worktree
        Save-HdoRun $run $artifactPath
        Set-HdoRunState $run 'WORKTREE_READY' $artifactPath 'Isolated Git worktree created.'
        Assert-HdoRepositoryConfigSnapshot $config ([string]$worktree.path) | Out-Null
        $projectContract = Get-HdoWorktreeProjectContract $config ([string]$worktree.path)
        $worktreeProjectContractHash = Get-HdoSha256 ($projectContract | ConvertTo-Json -Depth 100 -Compress)
        if ($worktreeProjectContractHash -ne $projectContractHash) {
            throw 'The project contract in the fixed base commit differs from the contract validated before worktree creation. Commit or revert the contract change and retry.'
        }
        Write-HdoJsonFile (Join-Path $artifactPath 'project-contract.json') $projectContract

        $planBinding = Get-HdoStepBinding $config 'plan'
        if ($planBinding.enabled) {
            Set-HdoRunState $run 'PLANNING' $artifactPath 'Read-only planning step started.'
            $planStep = Invoke-HdoAgentStep $config $run 'plan' 0 ([string]$worktree.path) `
                (New-HdoPlanPrompt $issueContract $projectContract) (Join-Path $artifactPath 'plan') 'task-contract'
            $taskContract = $planStep.output
            Assert-HdoWorktreeIntegrity ([string]$worktree.path) ([string]$worktree.baseCommit) | Out-Null
            $planningDiff = Get-HdoDiff ([string]$worktree.path) ([string]$worktree.baseCommit)
            if ($planningDiff.hasChanges) { throw 'Read-only planning step modified the worktree.' }
            Write-HdoJsonFile (Join-Path $artifactPath 'task-contract.json') $taskContract
        }
        else {
            $taskContract = New-HdoSyntheticTaskContract $issueContract
            Write-HdoJsonFile (Join-Path $artifactPath 'task-contract.json') $taskContract
        }

        $previousReview = $null
        $previousValidation = $null
        $finalDiff = $null
        $terminalState = $null
        $terminalReason = $null
        while ($true) {
            $run.iteration = [int]$run.iteration + 1
            $iterationName = '{0:D3}' -f $run.iteration
            $iterationPath = Join-Path $artifactPath "iterations/$iterationName"
            New-Item -ItemType Directory -Path $iterationPath -Force | Out-Null
            Save-HdoRun $run $artifactPath
            Set-HdoRunState $run 'IMPLEMENTING' $artifactPath $(if ($run.iteration -eq 1) { 'Initial implementation started.' } else { 'Fix iteration started.' })
            if ($writeBack) { Set-HdoIssuePhaseBestEffort $config $run 'github.labels.implementing' 'hdo:status/implementing' $artifactPath }

            if ($run.iteration -eq 1) {
                $workerStep = Invoke-HdoAgentStep $config $run 'implement' $run.iteration ([string]$worktree.path) `
                    (New-HdoImplementationPrompt $issueContract $taskContract $projectContract $run.iteration) (Join-Path $iterationPath 'implement') 'worker-result'
            }
            else {
                $workerStep = Invoke-HdoAgentStep $config $run 'fix' $run.iteration ([string]$worktree.path) `
                    (New-HdoFixPrompt $issueContract $taskContract $projectContract $previousReview $previousValidation $run.iteration) (Join-Path $iterationPath 'fix') 'worker-result'
            }

            Assert-HdoWorktreeIntegrity ([string]$worktree.path) ([string]$worktree.baseCommit) | Out-Null
            $preValidationDiff = Get-HdoDiff ([string]$worktree.path) ([string]$worktree.baseCommit)

            Set-HdoRunState $run 'VALIDATING' $artifactPath 'Trusted project validation gates started.'
            $validation = Invoke-HdoValidation $issueContract $projectContract ([string]$worktree.path) (Join-Path $iterationPath 'validation')
            Assert-HdoWorktreeIntegrity ([string]$worktree.path) ([string]$worktree.baseCommit) | Out-Null
            $diff = Get-HdoDiff ([string]$worktree.path) ([string]$worktree.baseCommit)
            if ($diff.hash -ne $preValidationDiff.hash -or (($diff.status | ConvertTo-Json -Compress) -ne ($preValidationDiff.status | ConvertTo-Json -Compress))) {
                throw 'A validation gate modified the worktree; validation gates must be observational.'
            }
            $diff['baseCommit'] = $worktree.baseCommit
            Set-Content -LiteralPath (Join-Path $iterationPath 'diff.patch') -Value $diff.patch -Encoding utf8NoBOM
            $diffMetadata = ConvertTo-HdoHashtable $diff
            $diffMetadata.Remove('patch')
            Write-HdoJsonFile (Join-Path $iterationPath 'diff.json') $diffMetadata
            if (-not $diff.hasChanges) {
                if ([string](Get-HdoValue $config 'workflow.onNoDiff' 'fail') -eq 'escalate') {
                    Set-HdoRunState $run 'CHANGES_REQUESTED' $artifactPath 'Implementation produced no diff.'
                    $run.result = [ordered]@{ decision = 'escalate'; summary = 'Implementation produced no diff.'; diffHash = $diff.hash; completedAt = Get-HdoUtcTimestamp }
                    $finalDiff = $diff
                    $terminalState = 'ESCALATED'
                    $terminalReason = 'No diff requires Human attention.'
                    break
                }
                throw 'Implementation step completed without any worktree changes.'
            }

            if (-not $validation.allRequiredPassed) {
                $validationPolicy = [string](Get-HdoValue $config 'workflow.onValidationFailure' 'request-changes')
                if ($validationPolicy -eq 'fail') { throw 'One or more required validation gates did not pass.' }
                if ($validationPolicy -eq 'escalate') {
                    Set-HdoRunState $run 'CHANGES_REQUESTED' $artifactPath 'Required validation did not pass.'
                    $run.result = [ordered]@{ decision = 'escalate'; summary = 'Required validation did not pass.'; diffHash = $diff.hash; validation = $validation; completedAt = Get-HdoUtcTimestamp }
                    $finalDiff = $diff
                    $terminalState = 'ESCALATED'
                    $terminalReason = 'Validation policy requires Human attention.'
                    break
                }
            }

            Set-HdoRunState $run 'REVIEWING' $artifactPath 'Read-only structured review started.'
            if ($writeBack) { Set-HdoIssuePhaseBestEffort $config $run 'github.labels.review' 'hdo:status/review' $artifactPath }
            $reviewStep = Invoke-HdoAgentStep $config $run 'review' $run.iteration ([string]$worktree.path) `
                (New-HdoReviewPrompt $issueContract $taskContract $projectContract $validation $diff $previousReview $run.iteration ([string]$run.id)) (Join-Path $iterationPath 'review') 'review-result'
            $review = $reviewStep.output
            Assert-HdoWorktreeIntegrity ([string]$worktree.path) ([string]$worktree.baseCommit) | Out-Null
            $postReviewDiff = Get-HdoDiff ([string]$worktree.path) ([string]$worktree.baseCommit)
            if ($postReviewDiff.hash -ne $diff.hash -or (($postReviewDiff.status | ConvertTo-Json -Compress) -ne ($diff.status | ConvertTo-Json -Compress))) {
                throw 'Read-only review step modified the reviewed worktree; its decision is stale and was rejected.'
            }
            $reviewValidation = Test-HdoReviewResult $review $previousReview $run.iteration ([string]$run.id) ([string]$worktree.baseCommit) ([string]$diff.hash)
            if (-not $reviewValidation.valid) { throw "Review result is invalid: $($reviewValidation.errors -join '; ')" }

            if ($review.decision -eq 'approve' -and -not $validation.allRequiredPassed) {
                $review.decision = 'request_changes'
                $review.summary = "HDO rejected approval because required validation did not pass. $($review.summary)"
                $syntheticFindingId = "HDO-VALIDATION-R$($run.iteration)"
                $existingFindingIds = @($review.findings | ForEach-Object { [string]$_.id })
                $findingSuffix = 1
                while ($existingFindingIds -contains $syntheticFindingId) {
                    $syntheticFindingId = "HDO-VALIDATION-R$($run.iteration)-$findingSuffix"
                    $findingSuffix++
                }
                $review.findings = @($review.findings) + [ordered]@{
                    id = $syntheticFindingId
                    severity = 'blocker'
                    category = 'test_detection'
                    evidence = 'measured'
                    evidenceDetail = ($validation | ConvertTo-Json -Compress -Depth 20)
                    status = 'open'
                    actionable = $true
                    path = '.hdo/project.json'
                    line = $null
                    message = 'One or more required validation gates did not pass.'
                    requiredAction = 'Fix the failures or make the validation result conclusive, then re-run all required gates.'
                }
                $transformedSchemaValidation = Test-HdoObjectSchema $review 'review-result'
                if (-not $transformedSchemaValidation.valid) { throw "HDO produced an invalid validation blocker review: $($transformedSchemaValidation.error)" }
                $transformedReviewValidation = Test-HdoReviewResult $review $previousReview $run.iteration ([string]$run.id) ([string]$worktree.baseCommit) ([string]$diff.hash)
                if (-not $transformedReviewValidation.valid) { throw "HDO produced an invalid validation blocker review: $($transformedReviewValidation.errors -join '; ')" }
            }
            Write-HdoJsonFile (Join-Path $iterationPath 'review/result.json') $review
            $previousReview = $review
            $previousValidation = $validation
            $finalDiff = $diff

            if ($review.decision -eq 'approve') {
                $run.result = [ordered]@{ decision = 'approve'; summary = $review.summary; diffHash = $diff.hash; validation = $validation; completedAt = Get-HdoUtcTimestamp }
                $terminalState = 'APPROVED'
                $terminalReason = 'Reviewer approved a diff with all required validation gates passing.'
                break
            }
            if ($review.decision -eq 'escalate') {
                $run.result = [ordered]@{ decision = 'escalate'; summary = $review.summary; reason = $review.escalationReason; diffHash = $diff.hash; completedAt = Get-HdoUtcTimestamp }
                $terminalState = 'ESCALATED'
                $terminalReason = [string]$review.escalationReason
                break
            }

            if ([int]$run.fixAttempts -ge [int]$run.maxFixAttempts) {
                if ([string](Get-HdoValue $config 'workflow.onMaxFixAttempts' 'escalate') -eq 'fail') {
                    throw 'Maximum fix attempts reached with open findings.'
                }
                Set-HdoRunState $run 'CHANGES_REQUESTED' $artifactPath 'Reviewer requested changes at the fix limit.'
                $run.result = [ordered]@{ decision = 'escalate'; summary = 'Maximum fix attempts reached with open findings.'; findings = $review.findings; diffHash = $diff.hash; completedAt = Get-HdoUtcTimestamp }
                $terminalState = 'ESCALATED'
                $terminalReason = 'Maximum fix attempts reached.'
                break
            }
            $run.fixAttempts = [int]$run.fixAttempts + 1
            Set-HdoRunState $run 'CHANGES_REQUESTED' $artifactPath 'Reviewer returned actionable findings.'
            if ($writeBack) { Set-HdoIssuePhaseBestEffort $config $run 'github.labels.changesRequested' 'hdo:status/changes-requested' $artifactPath }
        }

        if (-not $terminalState) { throw 'Workflow ended without a terminal decision.' }
        $finalPath = Join-Path $artifactPath 'final'
        New-Item -ItemType Directory -Path $finalPath -Force | Out-Null
        if ($finalDiff) { Set-Content -LiteralPath (Join-Path $finalPath 'diff.patch') -Value $finalDiff.patch -Encoding utf8NoBOM }
        Write-HdoJsonFile (Join-Path $finalPath 'summary.json') $run.result
        Set-HdoRunState $run $terminalState $artifactPath $terminalReason
        if ($writeBack) {
            try { Complete-HdoClaim $config $run $run.state ([string]$run.result.summary) }
            catch {
                $run.warnings += "Final GitHub writeback failed: $($_.Exception.Message)"
                Add-HdoRunEvent $artifactPath ([ordered]@{ type = 'github.finalize.failed'; message = Protect-HdoText $_.Exception.Message })
                Save-HdoRun $run $artifactPath
            }
        }
        return $run
    }
    catch {
        $failureMessage = Protect-HdoText $_.Exception.Message
        $failureCategory = if ($run.state -eq 'PREFLIGHT') { 'PREFLIGHT_FAILED' } else { 'RUN_FAILED' }
        $run.error = [ordered]@{ category = $failureCategory; message = $failureMessage; at = Get-HdoUtcTimestamp }
        if ($run.state -notin $script:HdoTerminalStates) {
            try { Set-HdoRunState $run 'FAILED' $artifactPath $failureMessage }
            catch { $run.state = 'FAILED'; Save-HdoRun $run $artifactPath }
        }
        else { Save-HdoRun $run $artifactPath }
        if ($writeBack -and (Get-HdoValue $run 'github.claim.commentId')) {
            try { Complete-HdoClaim $config $run 'FAILED' $failureMessage } catch {
                $run.warnings += "Failure writeback also failed: $($_.Exception.Message)"
                Save-HdoRun $run $artifactPath
            }
        }
        return $run
    }
}
