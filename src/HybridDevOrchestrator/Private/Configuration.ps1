function Get-HdoConfig {
    [CmdletBinding()]
    param(
        [string]$RepositoryPath = (Get-Location).Path,
        [string]$ConfigPath,
        [string]$Profile,
        [System.Collections.IDictionary]$Overrides = @{},
        [System.Collections.IDictionary]$StepOverrides = @{}
    )

    $repositoryPath = [System.IO.Path]::GetFullPath($RepositoryPath)
    $defaultPath = Join-Path $script:HdoRepositoryRoot 'config/hdo.default.json'
    $config = Read-HdoJsonFile $defaultPath
    $sources = @($defaultPath)

    if ($env:APPDATA) {
        $userPath = Join-Path $env:APPDATA 'hdo/config.json'
        if (Test-Path -LiteralPath $userPath -PathType Leaf) {
            $config = Merge-HdoHashtable $config (Read-HdoJsonFile $userPath)
            $sources += $userPath
        }
    }

    if ($ConfigPath) {
        $explicitPath = [System.IO.Path]::GetFullPath($ConfigPath)
        $config = Merge-HdoHashtable $config (Read-HdoJsonFile $explicitPath)
        $sources += $explicitPath
    }
    if ($Overrides.Count -gt 0) { $config = Merge-HdoHashtable $config $Overrides }

    $schemaValidation = Test-HdoObjectSchema $config 'hdo-config'
    if (-not $schemaValidation.valid) {
        throw "Configuration schema validation failed: $($schemaValidation.error)"
    }

    $profileName = if ($Profile) { $Profile } else { [string](Get-HdoValue $config 'activeProfile' '') }
    if (-not $profileName) { throw 'activeProfile or -Profile must be specified.' }
    $profiles = Get-HdoValue $config 'profiles'
    if ($profiles -isnot [System.Collections.IDictionary] -or -not $profiles.Contains($profileName)) {
        throw "Profile '$profileName' is not defined."
    }
    $config = Merge-HdoHashtable $config $profiles[$profileName]

    if (-not $config.Contains('steps')) { $config['steps'] = [ordered]@{} }
    foreach ($stepName in $StepOverrides.Keys) {
        if ([string]$stepName -notin @('plan', 'implement', 'review', 'fix')) {
            throw "Unknown step override '$stepName'."
        }
        $config.steps[[string]$stepName] = [string]$StepOverrides[$stepName]
    }

    $config['resolvedProfile'] = $profileName
    $config['repositoryPath'] = $repositoryPath
    $config['configSources'] = @($sources)
    if ($config.Contains('paths')) {
        foreach ($pathKey in @('worktreeRoot', 'artifactRoot')) {
            if ($config.paths.Contains($pathKey) -and $config.paths[$pathKey]) {
                $config.paths[$pathKey] = Expand-HdoPath ([string]$config.paths[$pathKey]) $repositoryPath
            }
        }
    }
    if ($config.Contains('projectContractPath') -and $config.projectContractPath) {
        $config.projectContractPath = Expand-HdoPath ([string]$config.projectContractPath) $repositoryPath
    }

    $validation = Test-HdoConfiguration $config
    if (-not $validation.valid) {
        throw "Configuration is invalid:`n - $($validation.errors -join "`n - ")"
    }
    $config['configurationWarnings'] = @($validation.warnings)
    return $config
}

function Test-HdoConfiguration {
    [CmdletBinding()]
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Config)

    $errors = [Collections.Generic.List[string]]::new()
    $warnings = [Collections.Generic.List[string]]::new()
    if ([int](Get-HdoValue $Config 'schemaVersion' 0) -ne 1) {
        $errors.Add('schemaVersion must be 1.')
    }

    $maxFixAttempts = [int](Get-HdoValue $Config 'workflow.maxFixAttempts' -1)
    if ($maxFixAttempts -lt 0 -or $maxFixAttempts -gt 10) {
        $errors.Add('workflow.maxFixAttempts must be between 0 and 10.')
    }

    $githubLabels = Get-HdoValue $Config 'github.labels' ([ordered]@{})
    if ($githubLabels -is [System.Collections.IDictionary]) {
        $readyLabel = [string](Get-HdoValue $githubLabels 'ready' '')
        $skipLabel = [string](Get-HdoValue $githubLabels 'skip' '')
        $statusPrefix = [string](Get-HdoValue $githubLabels 'statusPrefix' '')
        if ($statusPrefix -ne 'hdo:status/') { $errors.Add("github.labels.statusPrefix must be 'hdo:status/'.") }
        if ($readyLabel -notlike 'hdo:*' -or $readyLabel.StartsWith($statusPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $errors.Add('github.labels.ready must be in the hdo: namespace and outside the status prefix.')
        }
        if ($skipLabel -notlike 'hdo:*' -or $skipLabel.StartsWith($statusPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $errors.Add('github.labels.skip must be in the hdo: namespace and outside the status prefix.')
        }
        foreach ($labelKey in @('ready', 'skip')) {
            $labelName = [string](Get-HdoValue $githubLabels $labelKey '')
            if ($labelName -match '^hdo:(?:priority|risk|route)/') {
                $errors.Add("github.labels.$labelKey cannot use a priority, risk, or route label namespace.")
            }
        }
        $managedLabelNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($labelKey in @('ready', 'skip')) {
            $labelName = [string](Get-HdoValue $githubLabels $labelKey '')
            if ($labelName -and -not $managedLabelNames.Add($labelName)) { $errors.Add("GitHub managed label '$labelName' is configured more than once.") }
        }
        foreach ($labelKey in @('claimed', 'implementing', 'review', 'changesRequested', 'approved', 'escalated', 'failed', 'cancelled')) {
            $labelName = [string](Get-HdoValue $githubLabels $labelKey '')
            if (-not $labelName.StartsWith($statusPrefix, [StringComparison]::OrdinalIgnoreCase) -or $labelName -eq $statusPrefix) {
                $errors.Add("github.labels.$labelKey must be a label below '$statusPrefix'.")
            }
            if ($labelName -and -not $managedLabelNames.Add($labelName)) { $errors.Add("GitHub managed label '$labelName' is configured more than once.") }
        }
        foreach ($catalogLabel in @(
            'hdo:priority/p0', 'hdo:priority/p1', 'hdo:priority/p2', 'hdo:priority/p3',
            'hdo:risk/low', 'hdo:risk/medium', 'hdo:risk/high', 'hdo:risk/critical'
        )) {
            if (-not $managedLabelNames.Add($catalogLabel)) { $errors.Add("GitHub managed label '$catalogLabel' collides with a fixed catalog label.") }
        }
        $profiles = Get-HdoValue $Config 'profiles' ([ordered]@{})
        if ($profiles -is [System.Collections.IDictionary]) {
            foreach ($profileName in $profiles.Keys) {
                $routeLabel = "hdo:route/$profileName"
                if (-not $managedLabelNames.Add($routeLabel)) { $errors.Add("GitHub managed label '$routeLabel' collides with a generated route label.") }
            }
        }
    }
    foreach ($priorityLabel in @(Get-HdoValue $Config 'github.priorityOrder' @())) {
        if ([string]$priorityLabel -notmatch '^hdo:priority/p[0-3]$') {
            $errors.Add("github.priorityOrder contains unsupported label '$priorityLabel'.")
        }
    }

    foreach ($pathName in @('paths.worktreeRoot', 'paths.artifactRoot')) {
        if (-not (Get-HdoValue $Config $pathName '')) { $errors.Add("$pathName is required.") }
    }
    $repositoryPath = [string](Get-HdoValue $Config 'repositoryPath' '')
    $projectContractPath = [string](Get-HdoValue $Config 'projectContractPath' '')
    if ($repositoryPath -and $projectContractPath -and -not (Test-HdoPathWithinRoot $projectContractPath $repositoryPath)) {
        $errors.Add('projectContractPath must resolve inside repositoryPath.')
    }
    if ($repositoryPath) {
        $worktreeRoot = [string](Get-HdoValue $Config 'paths.worktreeRoot' '')
        $artifactRoot = [string](Get-HdoValue $Config 'paths.artifactRoot' '')
        if ($worktreeRoot -and ($worktreeRoot -eq $repositoryPath -or (Test-HdoPathWithinRoot $worktreeRoot $repositoryPath))) {
            $errors.Add('paths.worktreeRoot must be outside repositoryPath.')
        }
        if ($artifactRoot -and ($artifactRoot -eq $repositoryPath -or (Test-HdoPathWithinRoot $artifactRoot $repositoryPath))) {
            $errors.Add('paths.artifactRoot must be outside repositoryPath.')
        }
        if ($worktreeRoot -and $artifactRoot -and (
            $worktreeRoot -eq $artifactRoot -or
            (Test-HdoPathWithinRoot $worktreeRoot $artifactRoot) -or
            (Test-HdoPathWithinRoot $artifactRoot $worktreeRoot)
        )) {
            $errors.Add('paths.worktreeRoot and paths.artifactRoot must not overlap.')
        }
    }

    $runners = Get-HdoValue $Config 'runners'
    if ($runners -isnot [System.Collections.IDictionary]) {
        $errors.Add('runners must be an object.')
        $runners = [ordered]@{}
    }
    $steps = Get-HdoValue $Config 'steps'
    if ($steps -isnot [System.Collections.IDictionary]) {
        $errors.Add('steps must be an object.')
        $steps = [ordered]@{}
    }

    foreach ($requiredStep in @('implement', 'review', 'fix')) {
        if (-not $steps.Contains($requiredStep)) { $errors.Add("steps.$requiredStep is required.") }
    }

    foreach ($stepName in @('plan', 'implement', 'review', 'fix')) {
        if (-not $steps.Contains($stepName)) { continue }
        $binding = $steps[$stepName]
        $enabled = $true
        $runnerName = $null
        if ($binding -is [string]) {
            $runnerName = $binding
        }
        elseif ($binding -is [System.Collections.IDictionary]) {
            $enabled = [bool](Get-HdoValue $binding 'enabled' $true)
            $runnerName = [string](Get-HdoValue $binding 'runner' '')
        }
        else {
            $errors.Add("steps.$stepName must be a runner name or an object.")
            continue
        }
        if (-not $enabled) {
            if ($stepName -ne 'plan') { $errors.Add("Only the plan step may be disabled; '$stepName' is required.") }
            continue
        }
        if (-not $runnerName -or -not $runners.Contains($runnerName)) {
            $errors.Add("steps.$stepName references undefined runner '$runnerName'.")
            continue
        }

        $runner = $runners[$runnerName]
        $type = [string](Get-HdoValue $runner 'type' '')
        if ($type -notin @('codex', 'claude', 'command')) {
            $errors.Add("Runner '$runnerName' has unsupported type '$type'.")
        }
        if (-not (Get-HdoValue $runner 'command' '')) {
            $errors.Add("Runner '$runnerName' must define command.")
        }
        $provider = [string](Get-HdoValue $runner 'provider' 'cloud')
        if ($provider -notin @('cloud', 'ollama', 'lmstudio', 'custom')) {
            $errors.Add("Runner '$runnerName' has unsupported provider '$provider'.")
        }
        if ($type -eq 'codex' -and $provider -notin @('cloud', 'ollama', 'lmstudio')) {
            $errors.Add("Codex runner '$runnerName' cannot use provider '$provider'.")
        }
        if ($type -eq 'claude' -and $provider -ne 'cloud') {
            $errors.Add("Claude runner '$runnerName' must use provider 'cloud'.")
        }
        if ($type -eq 'claude' -and (Get-HdoValue $runner 'contextTokens')) {
            $errors.Add("Claude runner '$runnerName' cannot set contextTokens because the Claude adapter does not expose a context-window argument.")
        }
        $reasoningEffort = [string](Get-HdoValue $runner 'reasoningEffort' '')
        if ($type -eq 'claude' -and $reasoningEffort -and $reasoningEffort -notin @('low', 'medium', 'high', 'xhigh', 'max')) {
            $errors.Add("Claude runner '$runnerName' reasoningEffort '$reasoningEffort' is not supported; the Claude CLI --effort accepts low, medium, high, xhigh, or max and silently ignores other values.")
        }
        if ($provider -in @('ollama', 'lmstudio') -and -not (Get-HdoValue $runner 'model' '')) {
            $errors.Add("Local runner '$runnerName' must define model.")
        }
        $sandbox = [string](Get-HdoValue $runner 'sandbox' '')
        if ($sandbox -notin @('read-only', 'workspace-write')) {
            $errors.Add("Runner '$runnerName' sandbox must be read-only or workspace-write.")
        }
        if ($stepName -in @('plan', 'review') -and $sandbox -ne 'read-only') {
            $errors.Add("The $stepName step must use a read-only runner; '$runnerName' uses '$sandbox'.")
        }
        if ($stepName -in @('implement', 'fix') -and $sandbox -ne 'workspace-write') {
            $errors.Add("The $stepName step must use a workspace-write runner; '$runnerName' uses '$sandbox'.")
        }
        $timeout = [int](Get-HdoValue $runner 'timeoutSeconds' 0)
        if ($timeout -lt 1 -or $timeout -gt 86400) {
            $errors.Add("Runner '$runnerName' timeoutSeconds must be between 1 and 86400.")
        }
        if (@(Get-HdoValue $runner 'fallback' @()).Count -gt 0) {
            $errors.Add("Runner '$runnerName' declares fallback. Implicit provider/model fallback is not supported.")
        }
        foreach ($extraArgument in @(Get-HdoValue $runner 'extraArgs' @())) {
            $argumentText = [string]$extraArgument
            if ($argumentText -match "[\u0000\r\n]") {
                $errors.Add("Runner '$runnerName' has an argument containing a line break or NUL.")
            }
            if ($argumentText -match '(?i)(danger-full-access|bypasspermissions|dangerously-(?:bypass|skip)|^--search(?:=|$))') {
                $errors.Add("Runner '$runnerName' uses forbidden argument '$extraArgument'.")
            }
            if ($type -in @('codex', 'claude') -and $argumentText -match '^(?:--sandbox|-s|--cd|-C|--permission-mode|--output-schema|--output-last-message|--json-schema|--output-format)(?:=|$)') {
                $errors.Add("Runner '$runnerName' may not override adapter-controlled argument '$extraArgument'.")
            }
            if ($argumentText -match '(?i)(?:ghp_|github_pat_|sk-ant-|sk-proj-|xox[baprs]-)[-A-Za-z0-9_]{12,}') {
                $errors.Add("Runner '$runnerName' extraArgs appears to contain a credential literal.")
            }
        }
        if ($type -ne 'command' -and (Get-HdoValue $runner 'promptTransport')) {
            $errors.Add("Runner '$runnerName' may use promptTransport only with type 'command'.")
        }
        if ($type -ne 'claude' -and @(Get-HdoValue $runner 'allowedTools' @()).Count -gt 0) {
            $errors.Add("Runner '$runnerName' may use allowedTools only with type 'claude'.")
        }
        foreach ($environmentName in @(Get-HdoValue $runner 'passEnvironment' @())) {
            if ($environmentName -match '(?i)GH_TOKEN|GITHUB_TOKEN') {
                $errors.Add("Runner '$runnerName' must not receive GitHub control-plane credentials.")
            }
            elseif ($environmentName -match '(?i)(TOKEN|SECRET|PASSWORD|API_KEY)$') {
                $warnings.Add("Runner '$runnerName' explicitly receives sensitive environment variable '$environmentName'.")
            }
        }
    }

    return [ordered]@{
        valid = $errors.Count -eq 0
        errors = @($errors)
        warnings = @($warnings)
    }
}

function Get-HdoExecutionPlan {
    [CmdletBinding()]
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Config)

    $resolvedSteps = [ordered]@{}
    $referencedRunners = [ordered]@{}
    foreach ($stepName in @('plan', 'implement', 'review', 'fix')) {
        if (-not $Config.steps.Contains($stepName)) { continue }
        $binding = $Config.steps[$stepName]
        $enabled = $true
        $runnerName = $null
        if ($binding -is [string]) { $runnerName = $binding }
        else {
            $enabled = [bool](Get-HdoValue $binding 'enabled' $true)
            $runnerName = [string](Get-HdoValue $binding 'runner' '')
        }
        if (-not $enabled) {
            $resolvedSteps[$stepName] = [ordered]@{ enabled = $false; runner = $null }
            continue
        }
        $runner = ConvertTo-HdoHashtable $Config.runners[$runnerName]
        $resolvedSteps[$stepName] = [ordered]@{
            enabled = $true
            runner = $runnerName
            type = $runner.type
            provider = [string](Get-HdoValue $runner 'provider' 'cloud')
            model = Get-HdoValue $runner 'model'
            reasoningEffort = Get-HdoValue $runner 'reasoningEffort'
            contextTokens = Get-HdoValue $runner 'contextTokens'
            sandbox = $runner.sandbox
            timeoutSeconds = $runner.timeoutSeconds
        }
        $referencedRunners[$runnerName] = $runner
    }

    return [ordered]@{
        schemaVersion = 1
        profile = $Config.resolvedProfile
        repositoryPath = $Config.repositoryPath
        generatedAt = Get-HdoUtcTimestamp
        implicitFallback = $false
        steps = $resolvedSteps
        runners = $referencedRunners
    }
}

function Get-HdoProjectContract {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Config)

    $path = [string]$Config.projectContractPath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Project contract was not found: $path"
    }
    $contract = Read-HdoJsonFile $path
    $schemaValidation = Test-HdoObjectSchema $contract 'project-contract'
    if (-not $schemaValidation.valid) {
        throw "Project contract schema validation failed for '$path': $($schemaValidation.error)"
    }
    if ([int](Get-HdoValue $contract 'schemaVersion' 0) -ne 1) {
        throw "Project contract schemaVersion must be 1: $path"
    }
    $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($gate in @(Get-HdoValue $contract 'validationGates' @())) {
        $id = [string](Get-HdoValue $gate 'id' '')
        if (-not $id) { throw "A validation gate in '$path' has no id." }
        if (-not $ids.Add($id)) { throw "Duplicate validation gate id '$id' in '$path'." }
        if (-not (Get-HdoValue $gate 'command' '')) { throw "Validation gate '$id' has no command." }
        $exitCodes = @(
            @(Get-HdoValue $gate 'exitCodes.passed' @()),
            @(Get-HdoValue $gate 'exitCodes.failed' @()),
            @(Get-HdoValue $gate 'exitCodes.indeterminate' @())
        )
        $seenExitCodes = [Collections.Generic.HashSet[int]]::new()
        foreach ($exitClass in $exitCodes) {
            foreach ($exitCode in @($exitClass)) {
                if (-not $seenExitCodes.Add([int]$exitCode)) {
                    throw "Validation gate '$id' has exit code '$exitCode' in more than one class."
                }
            }
        }
    }
    return $contract
}
