function Invoke-HdoGh {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [int]$TimeoutSeconds = 120,
        [switch]$ThrowOnError
    )

    return Invoke-HdoProcess -Command 'gh' -Arguments $Arguments -WorkingDirectory $WorkingDirectory `
        -TimeoutSeconds $TimeoutSeconds -ThrowOnError:$ThrowOnError
}

function Invoke-HdoGhJson {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [int]$TimeoutSeconds = 120
    )

    $result = Invoke-HdoGh $Arguments $WorkingDirectory $TimeoutSeconds
    if ($result.exitCode -ne 0) {
        throw "GitHub CLI failed: $($result.stderr.Trim())"
    }
    try {
        # -NoEnumerate keeps a JSON top-level array an array through ConvertFrom-Json even
        # when it has 0 or 1 elements. Without it, an empty array round-trips as $null, and
        # the common call-site pattern `@(Invoke-HdoGhJson ...)` then produces a 1-element
        # array holding that $null instead of an empty array (issue #50).
        #
        # The result is captured into a local variable before being returned rather than
        # returned inline (`return ConvertTo-HdoHashtable (...)`). PowerShell's array
        # subexpression operator collects a *pipeline*'s output items, so
        # `@(Invoke-HdoGhJson ...)` at the call site would otherwise re-wrap the single
        # -NoEnumerate array object emitted across the inline call chain into a 1-element
        # array holding that array, reintroducing the same crash one level down. A plain
        # variable assignment does not have that pipeline-collection behavior, so storing
        # the converted value here first and returning the variable keeps it a bare array
        # all the way through an outer `@(...)` wrap.
        $converted = ConvertTo-HdoHashtable (ConvertFrom-HdoJson -Json $result.stdout -Depth 100 -NoEnumerate)
        return $converted
    }
    catch {
        throw "GitHub CLI returned invalid JSON: $($_.Exception.Message)"
    }
}

function Invoke-HdoGhPagedJson {
    param(
        [Parameter(Mandatory)][string]$Endpoint,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [int]$TimeoutSeconds = 120
    )

    $result = Invoke-HdoGh @('api', '--paginate', '--slurp', '-X', 'GET', $Endpoint, '-f', 'per_page=100') $WorkingDirectory $TimeoutSeconds
    if ($result.exitCode -ne 0) { throw "GitHub CLI failed: $($result.stderr.Trim())" }
    try {
        $pages = ConvertFrom-HdoJson -Json $result.stdout -Depth 100 -AsHashtable
    }
    catch {
        throw "GitHub CLI returned invalid paginated JSON: $($_.Exception.Message)"
    }
    foreach ($page in @($pages)) {
        foreach ($item in @($page)) { Write-Output $item }
    }
}

function Resolve-HdoRepositorySlug {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Config)

    $configured = [string](Get-HdoValue $Config 'github.repository' '')
    if ($configured) { return $configured }
    $remote = Invoke-HdoGit @('config', '--get', 'remote.origin.url') ([string]$Config.repositoryPath) -ThrowOnError
    $url = $remote.stdout.Trim()
    if ($url -match '(?i)github\.com[/:](?<slug>[^/\s]+/[^/\s]+?)(?:\.git)?$') {
        return $Matches.slug
    }
    throw 'Unable to resolve GitHub owner/repository. Set github.repository in configuration.'
}

function Get-HdoLabelNames {
    param([AllowNull()]$Labels)

    $names = @()
    foreach ($label in @($Labels)) {
        if ($label -is [string]) { $names += $label }
        elseif ($label -is [System.Collections.IDictionary] -and $label.Contains('name')) { $names += [string]$label.name }
    }
    # `return @($names)` would re-enumerate a 0-element array through the function's
    # own output stream and collapse it to $null one level up (issue #50/#61 item 4).
    # An Issue filtered on hdo:ready always carries at least one label in practice, so
    # this never fires from real `gh` output, but a caller with no labels at all must
    # still get back a genuine empty array rather than $null.
    $result = [object[]]@($names)
    Write-Output -NoEnumerate $result
}

function Get-HdoIssue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$Number,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [string]$Repository
    )

    if (-not $Repository) { $Repository = Resolve-HdoRepositorySlug $Config }
    $fields = 'number,title,body,state,labels,assignees,milestone,author,createdAt,updatedAt,url,comments'
    $issue = Invoke-HdoGhJson @('issue', 'view', [string]$Number, '--repo', $Repository, '--json', $fields) ([string]$Config.repositoryPath)
    $issue['repository'] = $Repository
    $issue['labels'] = Get-HdoLabelNames $issue.labels
    return $issue
}

function Get-HdoIssueLastEditedAt {
    param(
        [Parameter(Mandatory)][string]$Repository,
        [Parameter(Mandatory)][int]$IssueNumber,
        [Parameter(Mandatory)][string]$WorkingDirectory
    )

    if ($Repository -notmatch '^(?<owner>[^/]+)/(?<name>[^/]+)$') {
        throw "Invalid GitHub repository slug '$Repository'."
    }
    $owner = $Matches.owner
    $name = $Matches.name
    $query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){lastEditedAt}}}'
    $response = Invoke-HdoGhJson @(
        'api', 'graphql',
        '-f', "query=$query",
        '-F', "owner=$owner",
        '-F', "name=$name",
        '-F', "number=$IssueNumber"
    ) $WorkingDirectory
    $issue = Get-HdoValue $response 'data.repository.issue' $null
    if ($null -eq $issue) { throw "GitHub Issue $Repository#$IssueNumber was not found while checking ready authorization." }
    return [string](Get-HdoValue $issue 'lastEditedAt' '')
}

function Test-HdoReadyContentFreshness {
    param(
        [Parameter(Mandatory)][string]$ReadyAt,
        [AllowEmptyString()][string]$LastEditedAt
    )

    $readyTimestamp = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($ReadyAt, [ref]$readyTimestamp)) {
        return [ordered]@{ fresh = $false; reason = 'Ready timestamp could not be parsed.' }
    }
    if (-not $LastEditedAt) {
        return [ordered]@{ fresh = $true; reason = 'Issue content has not been edited since creation.' }
    }
    $editedTimestamp = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($LastEditedAt, [ref]$editedTimestamp)) {
        return [ordered]@{ fresh = $false; reason = 'Issue content edit timestamp could not be parsed.' }
    }
    if ($editedTimestamp -gt $readyTimestamp) {
        return [ordered]@{ fresh = $false; reason = "Issue content changed after the ready label was applied; re-review it and re-apply the ready label." }
    }
    return [ordered]@{ fresh = $true; reason = 'Ready label covers the latest Issue content edit.' }
}

function Test-HdoReadyLabelAuthorization {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [Parameter(Mandatory)][string]$Repository,
        [Parameter(Mandatory)][int]$IssueNumber
    )

    $trustedActors = @(Get-HdoValue $Config 'github.trustedActors' @())
    $readyLabel = [string](Get-HdoValue $Config 'github.labels.ready' 'hdo:ready')
    $events = @(Invoke-HdoGhPagedJson "repos/$Repository/issues/$IssueNumber/events" ([string]$Config.repositoryPath))
    $labelEvents = @($events | Where-Object {
        [string]$_.event -eq 'labeled' -and [string](Get-HdoValue $_ 'label.name' '') -eq $readyLabel
    } | Sort-Object created_at -Descending)
    if ($labelEvents.Count -eq 0) {
        return [ordered]@{ authorized = $false; enforced = $true; actor = $null; readyAt = $null; reason = "No label event was found for '$readyLabel'." }
    }
    $actor = [string](Get-HdoValue $labelEvents[0] 'actor.login' '')
    $readyAtText = [string](Get-HdoValue $labelEvents[0] 'created_at' '')
    # Issue.updatedAt also advances when the ready label itself changes. GitHub can expose
    # that timestamp one second after the corresponding label event, so comparing those
    # two fields rejects a freshly approved Issue. GraphQL lastEditedAt is limited to Issue
    # content edits and preserves the intended boundary: title/body edits after ready fail.
    $lastEditedAt = Get-HdoIssueLastEditedAt $Repository $IssueNumber ([string]$Config.repositoryPath)
    $freshness = Test-HdoReadyContentFreshness $readyAtText $lastEditedAt
    if (-not $freshness.fresh) {
        return [ordered]@{ authorized = $false; enforced = $true; actor = $actor; readyAt = $readyAtText; lastEditedAt = $lastEditedAt; reason = $freshness.reason }
    }
    if ($trustedActors.Count -eq 0) {
        return [ordered]@{ authorized = $true; enforced = $false; actor = $actor; readyAt = $readyAtText; lastEditedAt = $lastEditedAt; reason = 'Ready event covers the latest content edit; repository label permissions are the actor trust boundary.' }
    }
    return [ordered]@{
        authorized = $actor -in $trustedActors
        enforced = $true
        actor = $actor
        readyAt = $readyAtText
        lastEditedAt = $lastEditedAt
        reason = if ($actor -in $trustedActors) { "Ready label was applied by trusted actor '$actor'." } else { "Ready label actor '$actor' is not trusted." }
    }
}

function Get-HdoMarkdownSections {
    param([AllowNull()][string]$Body)

    $sections = [ordered]@{}
    if (-not $Body) { return $sections }
    # PowerShell variable names are case-insensitive. Do not call this `$matches`:
    # regex operators and switch -Regex update the automatic `$Matches` variable.
    $headingMatches = [regex]::Matches($Body, '(?m)^#{2,4}[ \t]+(?<title>.+?)[ \t]*$')
    for ($index = 0; $index -lt $headingMatches.Count; $index++) {
        $title = $headingMatches[$index].Groups['title'].Value.Trim()
        $start = $headingMatches[$index].Index + $headingMatches[$index].Length
        $end = if ($index + 1 -lt $headingMatches.Count) { $headingMatches[$index + 1].Index } else { $Body.Length }
        $content = $Body.Substring($start, $end - $start).Trim()
        $normalized = ($title.ToLowerInvariant() -replace '[`*_:\-–—/\\()（）]', ' ' -replace '\s+', ' ').Trim()
        $key = switch -Regex ($normalized) {
            '^(goal|目的|ゴール)$' { 'goal'; break }
            '^(problem|context|problem context|背景|課題|背景 課題)$' { 'context'; break }
            '^(out of scope|non goals?|対象外|非対象)$' { 'outOfScope'; break }
            '^(in scope|scope|対象範囲|スコープ)$' { 'scope'; break }
            '^(acceptance criteria|完了条件|受入条件|受け入れ条件)$' { 'acceptanceCriteria'; break }
            '^(in scope|対象範囲|対象)$' { 'scope'; break }
            '^(validation gate ids?|validation gates?|validation|検証ゲート|検証)$' { 'validationGates'; break }
            '^(constraints?(?: and security(?: considerations?)?| security considerations?)?|security considerations?|制約|制約 セキュリティ|セキュリティ)$' { 'constraints'; break }
            '^(dependencies|dependency|依存関係|依存)$' { 'dependencies'; break }
            '^(risk|リスク)$' { 'risk'; break }
            '^(priority|優先度)$' { 'priority'; break }
            '^(route hint|preferred execution|execution|実行方式|実行プロファイル)$' { 'preferredExecution'; break }
            '^(affected areas|影響範囲)$' { 'affectedAreas'; break }
            '^(additional context|追加情報)$' { 'additionalContext'; break }
            default { $null }
        }
        if ($key) { $sections[$key] = $content }
    }
    return $sections
}

function Get-HdoMarkdownList {
    param([AllowNull()][string]$Text)

    if (-not $Text -or $Text -match '^\s*(?:_?No response_?|なし|N/A)\s*$') { return @() }
    $items = @()
    foreach ($line in $Text -split "`r?`n") {
        if ($line -match '^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(?<value>.+?)\s*$') {
            $items += $Matches.value.Trim()
        }
    }
    if ($items.Count -eq 0 -and $Text.Trim()) {
        $items = @($Text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^_?No response_?$' })
    }
    return @($items)
}

function Get-HdoMarkdownScalar {
    param([AllowNull()][string]$Text)

    if (-not $Text) { return '' }
    $value = $Text.Trim()
    if ($value -match '^(?:_?No response_?|なし|N/?A)$') { return '' }
    return $value
}

function Get-HdoDependencyReferences {
    param(
        [AllowNull()][string]$Text,
        [Parameter(Mandatory)][string]$DefaultRepository
    )

    $references = @()
    if (-not $Text) { return @() }
    $pattern = '(?<![A-Za-z0-9_.-])(?:(?<repo>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+))?#(?<number>[1-9][0-9]*)'
    foreach ($match in [regex]::Matches($Text, $pattern)) {
        $repo = if ($match.Groups['repo'].Success) { $match.Groups['repo'].Value } else { $DefaultRepository }
        $references += [ordered]@{ repository = $repo; number = [int]$match.Groups['number'].Value }
    }
    return @($references | Sort-Object repository, number -Unique)
}

function ConvertTo-HdoIssueContract {
    [CmdletBinding()]
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Issue)

    $sections = Get-HdoMarkdownSections ([string](Get-HdoValue $Issue 'body' ''))
    $acceptanceCriteria = @()
    $criterionIndex = 0
    foreach ($item in @(Get-HdoMarkdownList (Get-HdoValue $sections 'acceptanceCriteria' ''))) {
        $criterionIndex++
        if ($item -match '^(?<id>AC[-_ ]?[A-Za-z0-9][A-Za-z0-9._-]*)\s*[:：]\s*(?<text>.*)$') {
            $id = ($Matches.id -replace '[_ ]', '-').ToUpperInvariant()
            $text = $Matches.text.Trim()
        }
        else {
            $id = "AC-$criterionIndex"
            $text = $item
        }
        $acceptanceCriteria += [ordered]@{ id = $id; text = $text }
    }
    $labels = Get-HdoLabelNames (Get-HdoValue $Issue 'labels' @())
    $routeLabel = @($labels | Where-Object { $_ -like 'hdo:route/*' } | Select-Object -First 1)
    $priorityLabel = @($labels | Where-Object { $_ -like 'hdo:priority/*' } | Select-Object -First 1)
    $riskLabel = @($labels | Where-Object { $_ -like 'hdo:risk/*' } | Select-Object -First 1)
    $preferredExecution = Get-HdoMarkdownScalar ([string](Get-HdoValue $sections 'preferredExecution' ''))
    if (-not $preferredExecution -and $routeLabel.Count -gt 0) { $preferredExecution = $routeLabel[0].Substring('hdo:route/'.Length) }
    elseif ($routeLabel.Count -gt 0) { $preferredExecution = $routeLabel[0].Substring('hdo:route/'.Length) }
    $priority = Get-HdoMarkdownScalar ([string](Get-HdoValue $sections 'priority' ''))
    if ($priorityLabel.Count -gt 0) { $priority = $priorityLabel[0].Substring('hdo:priority/'.Length) }
    $risk = Get-HdoMarkdownScalar ([string](Get-HdoValue $sections 'risk' ''))
    if ($riskLabel.Count -gt 0) { $risk = $riskLabel[0].Substring('hdo:risk/'.Length) }

    $dependencyText = [string](Get-HdoValue $sections 'dependencies' '')
    return [ordered]@{
        schemaVersion = 1
        issue = [ordered]@{
            repository = [string]$Issue.repository
            number = [int]$Issue.number
            url = [string]$Issue.url
            updatedAt = [string]$Issue.updatedAt
            title = [string]$Issue.title
            state = [string]$Issue.state
            labels = @($labels)
            bodyHash = Get-HdoSha256 ([string](Get-HdoValue $Issue 'body' ''))
        }
        goal = Get-HdoMarkdownScalar ([string](Get-HdoValue $sections 'goal' ''))
        context = Get-HdoMarkdownScalar ([string](Get-HdoValue $sections 'context' ''))
        scope = [ordered]@{
            include = @(Get-HdoMarkdownList (Get-HdoValue $sections 'scope' ''))
            exclude = @(Get-HdoMarkdownList (Get-HdoValue $sections 'outOfScope' ''))
        }
        acceptanceCriteria = @($acceptanceCriteria)
        validationGates = @(Get-HdoMarkdownList (Get-HdoValue $sections 'validationGates' '') | ForEach-Object { ($_ -replace '^`|`$', '').Trim() })
        constraints = @(Get-HdoMarkdownList (Get-HdoValue $sections 'constraints' ''))
        dependencies = @(Get-HdoDependencyReferences $dependencyText ([string]$Issue.repository))
        affectedAreas = @(Get-HdoMarkdownList (Get-HdoValue $sections 'affectedAreas' ''))
        additionalContext = Get-HdoMarkdownScalar ([string](Get-HdoValue $sections 'additionalContext' ''))
        priority = $priority
        risk = $risk
        preferredExecution = $preferredExecution
        capturedAt = Get-HdoUtcTimestamp
    }
}

function Test-HdoIssueContract {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Contract,
        [System.Collections.IDictionary]$Config,
        [System.Collections.IDictionary]$ProjectContract,
        [switch]$RequireReady
    )

    $errors = [Collections.Generic.List[string]]::new()
    $warnings = [Collections.Generic.List[string]]::new()
    $schemaValidation = Test-HdoObjectSchema $Contract 'issue-contract'
    if (-not $schemaValidation.valid) { $errors.Add("Issue contract schema validation failed: $($schemaValidation.error)") }
    if ([int](Get-HdoValue $Contract 'schemaVersion' 0) -ne 1) { $errors.Add('Issue contract schemaVersion must be 1.') }
    if (-not (Get-HdoValue $Contract 'issue.title' '')) { $errors.Add('Issue title is required.') }
    if (-not (Get-HdoValue $Contract 'context' '')) { $errors.Add("Issue section 'Problem / Context' is required.") }
    if (-not (Get-HdoValue $Contract 'goal' '')) { $errors.Add("Issue section 'Goal' is required.") }
    if (@(Get-HdoValue $Contract 'scope.include' @()).Count -eq 0) { $errors.Add("Issue section 'In scope' must contain at least one item.") }
    if (@(Get-HdoValue $Contract 'acceptanceCriteria' @()).Count -eq 0) { $errors.Add("Issue section 'Acceptance criteria' must contain at least one item.") }
    $acceptanceIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($criterion in @(Get-HdoValue $Contract 'acceptanceCriteria' @())) {
        $criterionId = [string](Get-HdoValue $criterion 'id' '')
        if ($criterionId -and -not $acceptanceIds.Add($criterionId)) { $errors.Add("Duplicate acceptance criterion id '$criterionId'.") }
    }
    if (@(Get-HdoValue $Contract 'validationGates' @()).Count -eq 0) { $errors.Add("Issue section 'Validation gate IDs' must contain at least one gate id.") }
    foreach ($gateId in @(Get-HdoValue $Contract 'validationGates' @())) {
        if ([string]$gateId -notmatch '^[a-z0-9][a-z0-9._-]{0,62}$') { $errors.Add("Invalid validation gate id '$gateId'.") }
    }
    if ([string](Get-HdoValue $Contract 'priority' '') -notin @('p0', 'p1', 'p2', 'p3')) { $errors.Add('Issue priority must be p0, p1, p2, or p3.') }
    if ([string](Get-HdoValue $Contract 'risk' '') -notin @('low', 'medium', 'high', 'critical')) { $errors.Add('Issue risk must be low, medium, high, or critical.') }
    $routeHint = [string](Get-HdoValue $Contract 'preferredExecution' '')
    if ($routeHint -and $routeHint -notmatch '^[a-z0-9][a-z0-9._-]{0,62}$') { $errors.Add("Invalid route hint '$routeHint'.") }
    if ($routeHint -and $Config -and -not $Config.profiles.Contains($routeHint)) { $errors.Add("Route hint '$routeHint' does not name a configured profile.") }

    $labels = @(Get-HdoValue $Contract 'issue.labels' @())
    if ($RequireReady -and $Config) {
        $readyLabel = [string](Get-HdoValue $Config 'github.labels.ready' 'hdo:ready')
        if ($labels -notcontains $readyLabel) { $errors.Add("Issue must have ready label '$readyLabel'.") }
        $skipLabel = [string](Get-HdoValue $Config 'github.labels.skip' 'hdo:skip')
        if ($labels -contains $skipLabel) { $errors.Add("Issue has exclusion label '$skipLabel'.") }
        $statusPrefix = [string](Get-HdoValue $Config 'github.labels.statusPrefix' 'hdo:status/')
        if ($labels -contains $readyLabel -and @($labels | Where-Object { $_.StartsWith($statusPrefix, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
            $errors.Add("Ready label '$readyLabel' cannot coexist with an HDO status label.")
        }
    }
    foreach ($axis in @('hdo:status/', 'hdo:priority/', 'hdo:risk/', 'hdo:route/')) {
        $matches = @($labels | Where-Object { $_.StartsWith($axis, [StringComparison]::OrdinalIgnoreCase) })
        if ($matches.Count -gt 1) { $errors.Add("Issue has multiple labels on exclusive axis '$axis': $($matches -join ', ')") }
    }
    if ($Config) {
        $allowedStatic = @(
            (Get-HdoValue $Config 'github.labels.ready' 'hdo:ready'),
            (Get-HdoValue $Config 'github.labels.skip' 'hdo:skip')
        ) + @((Get-HdoValue $Config 'github.labels').Values) + @(Get-HdoValue $Config 'github.priorityOrder' @()) + @(
            'hdo:risk/low', 'hdo:risk/medium', 'hdo:risk/high', 'hdo:risk/critical'
        )
        foreach ($label in @($labels | Where-Object { $_ -like 'hdo:*' })) {
            if ($label -notin $allowedStatic -and $label -notlike 'hdo:route/*') {
                $errors.Add("Unknown reserved HDO label '$label'.")
            }
        }
    }

    if ($ProjectContract) {
        $knownGates = @{}
        foreach ($gate in @(Get-HdoValue $ProjectContract 'validationGates' @())) { $knownGates[[string]$gate.id] = $true }
        foreach ($gateId in @(Get-HdoValue $Contract 'validationGates' @())) {
            if (-not $knownGates.ContainsKey([string]$gateId)) {
                $errors.Add("Issue references unknown validation gate '$gateId'.")
            }
        }
    }
    if (@(Get-HdoValue $Contract 'scope.exclude' @()).Count -eq 0) { $warnings.Add("Issue section 'Out of scope' is empty.") }

    return [ordered]@{ valid = $errors.Count -eq 0; errors = @($errors); warnings = @($warnings) }
}

function Get-HdoIssueCandidate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [string]$Repository,
        [int]$Limit
    )

    if (-not $Repository) { $Repository = Resolve-HdoRepositorySlug $Config }
    if ($Limit -le 0) { $Limit = [int](Get-HdoValue $Config 'github.candidateLimit' 50) }
    $readyLabel = [string](Get-HdoValue $Config 'github.labels.ready' 'hdo:ready')
    $fields = 'number,title,body,state,labels,assignees,author,createdAt,updatedAt,url'
    $issues = @(Invoke-HdoGhJson @('issue', 'list', '--repo', $Repository, '--state', 'open', '--label', $readyLabel, '--limit', '1000', '--json', $fields) ([string]$Config.repositoryPath))
    $statusPrefix = [string](Get-HdoValue $Config 'github.labels.statusPrefix' 'hdo:status/')
    $skipLabel = [string](Get-HdoValue $Config 'github.labels.skip' 'hdo:skip')
    $priorityOrder = @(Get-HdoValue $Config 'github.priorityOrder' @('hdo:priority/p0', 'hdo:priority/p1', 'hdo:priority/p2', 'hdo:priority/p3'))
    $projectContract = Get-HdoProjectContract $Config
    $candidates = @()
    foreach ($issue in $issues) {
        $issue['repository'] = $Repository
        $issue.labels = Get-HdoLabelNames $issue.labels
        if ($issue.labels -contains $skipLabel) { continue }
        if (@($issue.labels | Where-Object { $_.StartsWith($statusPrefix, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { continue }
        $contract = ConvertTo-HdoIssueContract $issue
        $contractValidation = Test-HdoIssueContract -Contract $contract -Config $Config -ProjectContract $projectContract -RequireReady
        if (-not $contractValidation.valid) { continue }
        $readyAuthorization = Test-HdoReadyLabelAuthorization $Config $Repository ([int]$issue.number)
        if (-not $readyAuthorization.authorized) { continue }
        $dependencyValidation = Test-HdoIssueDependencies $Config $contract
        if (-not $dependencyValidation.resolved) { continue }
        $activeClaims = @(Get-HdoClaimComments $Config $Repository ([int]$issue.number) | Where-Object status -eq 'active')
        if ($activeClaims.Count -gt 0) { continue }
        $priorityRank = $priorityOrder.Count
        for ($index = 0; $index -lt $priorityOrder.Count; $index++) {
            if ($issue.labels -contains $priorityOrder[$index]) { $priorityRank = $index; break }
        }
        $issue['priorityRank'] = $priorityRank
        $candidates += $issue
    }
    return @($candidates | Sort-Object @{ Expression = 'priorityRank'; Ascending = $true }, @{ Expression = 'createdAt'; Ascending = $true }, @{ Expression = 'number'; Ascending = $true } | Select-Object -First $Limit)
}

function Test-HdoIssueDependencies {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Contract
    )

    $checks = @()
    foreach ($dependency in @(Get-HdoValue $Contract 'dependencies' @())) {
        $repository = [string]$dependency.repository
        $number = [int]$dependency.number
        try {
            $result = Invoke-HdoGhJson @('issue', 'view', [string]$number, '--repo', $repository, '--json', 'state,url') ([string]$Config.repositoryPath)
            $state = [string]$result.state
            $checks += [ordered]@{ repository = $repository; number = $number; state = $state; resolved = $state -eq 'CLOSED'; error = $null }
        }
        catch {
            $checks += [ordered]@{ repository = $repository; number = $number; state = 'UNKNOWN'; resolved = $false; error = Protect-HdoText $_.Exception.Message }
        }
    }
    $unresolved = @($checks | Where-Object { -not $_.resolved })
    return [ordered]@{ resolved = $unresolved.Count -eq 0; checks = $checks; unresolved = $unresolved }
}

function Get-HdoClaimComments {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [Parameter(Mandatory)][string]$Repository,
        [Parameter(Mandatory)][int]$IssueNumber
    )

    $comments = @(Invoke-HdoGhPagedJson "repos/$Repository/issues/$IssueNumber/comments" ([string]$Config.repositoryPath))
    $trustedActors = @(Get-HdoValue $Config 'github.trustedActors' @())
    $claims = @()
    foreach ($comment in $comments) {
        if ([string]$comment.body -notmatch '<!--\s*hdo:claim:v1\s+(?<marker>\{.*?\})\s*-->') { continue }
        try { $marker = ConvertTo-HdoHashtable (ConvertFrom-HdoJson -Json $Matches.marker -Depth 20) } catch { continue }
        $author = [string](Get-HdoValue $comment 'user.login' '')
        $association = [string](Get-HdoValue $comment 'author_association' '')
        $trustedAuthor = if ($trustedActors.Count -gt 0) {
            $author -in $trustedActors
        }
        else {
            $association -in @('OWNER', 'MEMBER', 'COLLABORATOR')
        }
        if (-not $trustedAuthor -or [string]$marker.claimedBy -ne $author) { continue }
        if ([int](Get-HdoValue $marker 'version' 0) -ne 1 -or [string]$marker.kind -ne 'claim') { continue }
        if ([string](Get-HdoValue $marker 'issueKey' '') -ne "$Repository#$IssueNumber") { continue }
        if ([string](Get-HdoValue $marker 'runId' '') -notmatch '^issue-[0-9]+-[A-Za-z0-9._:-]+$') { continue }
        if ([string](Get-HdoValue $marker 'state' '') -notin @('active', 'released')) { continue }
        $claimedAt = [DateTimeOffset]::MinValue
        $leaseExpiresAt = [DateTimeOffset]::MinValue
        if (-not [DateTimeOffset]::TryParse([string](Get-HdoValue $marker 'claimedAt' ''), [ref]$claimedAt)) { continue }
        if (-not [DateTimeOffset]::TryParse([string](Get-HdoValue $marker 'leaseExpiresAt' ''), [ref]$leaseExpiresAt)) { continue }
        if ($leaseExpiresAt -le $claimedAt) { continue }
        $claims += [ordered]@{
            runId = [string]$marker.runId
            status = [string]$marker.state
            id = [long]$comment.id
            createdAt = [string]$comment.created_at
            author = $author
            marker = $marker
            body = [string]$comment.body
        }
    }
    return @($claims)
}

function Set-HdoManagedStatusLabel {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [Parameter(Mandatory)][string]$Repository,
        [Parameter(Mandatory)][int]$IssueNumber,
        [Parameter(Mandatory)][string]$TargetLabel
    )

    $issue = Get-HdoIssue $IssueNumber $Config $Repository
    $prefix = [string](Get-HdoValue $Config 'github.labels.statusPrefix' 'hdo:status/')
    $ready = [string](Get-HdoValue $Config 'github.labels.ready' 'hdo:ready')
    $arguments = @('issue', 'edit', [string]$IssueNumber, '--repo', $Repository)
    foreach ($label in @($issue.labels | Where-Object { $_ -eq $ready -or $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })) {
        if ($label -ne $TargetLabel) { $arguments += @('--remove-label', $label) }
    }
    if ($issue.labels -notcontains $TargetLabel) { $arguments += @('--add-label', $TargetLabel) }
    if ($arguments.Count -eq 5) { return }
    Invoke-HdoGh $arguments ([string]$Config.repositoryPath) -ThrowOnError | Out-Null
}

function Claim-HdoIssue {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Issue,
        [Parameter(Mandatory)][string]$RunId
    )

    $repository = [string]$Issue.repository
    $number = [int]$Issue.number
    $currentIssue = Get-HdoIssue $number $Config $repository
    $expectedBodyHash = Get-HdoSha256 ([string](Get-HdoValue $Issue 'body' ''))
    $currentBodyHash = Get-HdoSha256 ([string](Get-HdoValue $currentIssue 'body' ''))
    if ([string]$currentIssue.updatedAt -ne [string]$Issue.updatedAt -or $currentBodyHash -ne $expectedBodyHash) {
        throw "Issue #$number changed after contract validation; re-run HDO against a fresh snapshot."
    }
    $active = @(Get-HdoClaimComments $Config $repository $number | Where-Object { $_.status -eq 'active' })
    if ($active.Count -gt 0) { throw "Issue #$number already has an active HDO run: $($active.runId -join ', ')" }

    $loginResult = Invoke-HdoGh @('api', 'user', '--jq', '.login') ([string]$Config.repositoryPath) 60 -ThrowOnError
    $login = $loginResult.stdout.Trim()
    $trustedActors = @(Get-HdoValue $Config 'github.trustedActors' @())
    if ($trustedActors.Count -gt 0 -and $login -notin $trustedActors) {
        throw "Authenticated GitHub actor '$login' is not listed in github.trustedActors."
    }
    $claimedAt = [DateTimeOffset]::UtcNow
    $marker = [ordered]@{
        version = 1
        kind = 'claim'
        runId = $RunId
        issueKey = "$repository#$number"
        claimedBy = $login
        claimedAt = $claimedAt.ToString('o')
        leaseExpiresAt = $claimedAt.AddHours([double](Get-HdoValue $Config 'github.claimLeaseHours' 24)).ToString('o')
        state = 'active'
    }
    $markerJson = $marker | ConvertTo-Json -Compress -Depth 10
    $body = "<!-- hdo:claim:v1 $markerJson -->`nHDO run ``$RunId`` が issue を claim しました。"
    $comment = Invoke-HdoGhJson @('api', '-X', 'POST', "repos/$repository/issues/$number/comments", '-f', "body=$body") ([string]$Config.repositoryPath)
    $claims = @(Get-HdoClaimComments $Config $repository $number | Where-Object { $_.status -eq 'active' } | Sort-Object id)
    $winner = $claims | Select-Object -First 1
    if (-not $winner -or $winner.runId -ne $RunId) {
        $marker.state = 'released'
        $releasedJson = $marker | ConvertTo-Json -Compress -Depth 10
        $abortedBody = "<!-- hdo:claim:v1 $releasedJson -->`n別の run が先に claim したため停止しました。"
        Invoke-HdoGhJson @('api', '-X', 'PATCH', "repos/$repository/issues/comments/$($comment.id)", '-f', "body=$abortedBody") ([string]$Config.repositoryPath) | Out-Null
        throw "Issue #$number claim conflict. Winning run: $($winner.runId)"
    }

    $claimedLabel = [string](Get-HdoValue $Config 'github.labels.claimed' 'hdo:status/claimed')
    try {
        Set-HdoManagedStatusLabel $Config $repository $number $claimedLabel
    }
    catch {
        $marker.state = 'released'
        $releasedJson = $marker | ConvertTo-Json -Compress -Depth 10
        $failureBody = "<!-- hdo:claim:v1 $releasedJson -->`nClaim 後の status 更新に失敗したため run を開始しませんでした。"
        try {
            Invoke-HdoGhJson @('api', '-X', 'PATCH', "repos/$repository/issues/comments/$($comment.id)", '-f', "body=$failureBody") ([string]$Config.repositoryPath) | Out-Null
        }
        catch { }
        throw
    }
    $warning = $null
    if ([bool](Get-HdoValue $Config 'github.assignOnClaim' $true)) {
        try {
            Invoke-HdoGh @('issue', 'edit', [string]$number, '--repo', $repository, '--add-assignee', '@me') ([string]$Config.repositoryPath) -ThrowOnError | Out-Null
        }
        catch { $warning = "Issue assignment failed after a successful claim: $(Protect-HdoText $_.Exception.Message)" }
    }
    return [ordered]@{ commentId = [long]$comment.id; marker = $marker; claimedAt = $marker.claimedAt; warning = $warning }
}

function Protect-HdoGitHubText {
    param([AllowNull()][string]$Text, [int]$MaximumLength = 1000)

    $safe = Protect-HdoText $Text
    if (-not $safe) { return '' }
    $safe = $safe.Replace('<!--', '&lt;!--').Replace('-->', '--&gt;').Replace('@', "@`u{200B}")
    if ($safe.Length -gt $MaximumLength) { $safe = $safe.Substring(0, $MaximumLength) + '…' }
    return $safe
}

function Complete-HdoClaim {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Run,
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)][string]$Summary
    )

    if (-not (Get-HdoValue $Run 'github.claim.commentId')) { return }
    $repository = [string]$Run.issue.repository
    $number = [int]$Run.issue.number
    $runId = [string]$Run.id
    $safeSummary = Protect-HdoGitHubText $Summary
    $marker = ConvertTo-HdoHashtable $Run.github.claim.marker
    $marker.state = 'released'
    $markerJson = $marker | ConvertTo-Json -Compress -Depth 10
    $body = "<!-- hdo:claim:v1 $markerJson -->`nHDO run ``$runId``: **$Status**`n`n$safeSummary"
    Invoke-HdoGhJson @('api', '-X', 'PATCH', "repos/$repository/issues/comments/$($Run.github.claim.commentId)", '-f', "body=$body") ([string]$Config.repositoryPath) | Out-Null
    $labelKey = switch ($Status.ToUpperInvariant()) {
        'APPROVED' { 'github.labels.approved' }
        'ESCALATED' { 'github.labels.escalated' }
        'FAILED' { 'github.labels.failed' }
        default { 'github.labels.failed' }
    }
    $fallback = switch ($Status.ToUpperInvariant()) {
        'APPROVED' { 'hdo:status/approved' }
        'ESCALATED' { 'hdo:status/blocked' }
        default { 'hdo:status/failed' }
    }
    Set-HdoManagedStatusLabel $Config $repository $number ([string](Get-HdoValue $Config $labelKey $fallback))
}

function Sync-HdoLabels {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [string]$Repository,
        [switch]$Apply
    )

    $configurationValidation = Test-HdoConfiguration $Config
    if (-not $configurationValidation.valid) {
        throw "Cannot synchronize labels with invalid configuration: $($configurationValidation.errors -join '; ')"
    }
    if (-not $Repository) { $Repository = Resolve-HdoRepositorySlug $Config }
    $catalogPath = Join-Path $script:HdoRepositoryRoot 'config/labels.json'
    $catalog = Read-HdoJsonFile $catalogPath
    $existing = @(Invoke-HdoGhJson @('label', 'list', '--repo', $Repository, '--limit', '1000', '--json', 'name,color,description') ([string]$Config.repositoryPath))
    $existingNames = @($existing | ForEach-Object { $_.name })
    $configuredNameByCatalogName = [ordered]@{
        'hdo:ready' = [string](Get-HdoValue $Config 'github.labels.ready' 'hdo:ready')
        'hdo:skip' = [string](Get-HdoValue $Config 'github.labels.skip' 'hdo:skip')
        'hdo:status/claimed' = [string](Get-HdoValue $Config 'github.labels.claimed' 'hdo:status/claimed')
        'hdo:status/implementing' = [string](Get-HdoValue $Config 'github.labels.implementing' 'hdo:status/implementing')
        'hdo:status/review' = [string](Get-HdoValue $Config 'github.labels.review' 'hdo:status/review')
        'hdo:status/changes-requested' = [string](Get-HdoValue $Config 'github.labels.changesRequested' 'hdo:status/changes-requested')
        'hdo:status/approved' = [string](Get-HdoValue $Config 'github.labels.approved' 'hdo:status/approved')
        'hdo:status/blocked' = [string](Get-HdoValue $Config 'github.labels.escalated' 'hdo:status/blocked')
        'hdo:status/failed' = [string](Get-HdoValue $Config 'github.labels.failed' 'hdo:status/failed')
        'hdo:status/cancelled' = [string](Get-HdoValue $Config 'github.labels.cancelled' 'hdo:status/cancelled')
    }
    $labelsToSync = @()
    foreach ($catalogLabel in @($catalog.staticLabels)) {
        $label = ConvertTo-HdoHashtable $catalogLabel
        if ($configuredNameByCatalogName.Contains([string]$label.name)) {
            $label.name = $configuredNameByCatalogName[[string]$label.name]
        }
        $labelsToSync += $label
    }
    $dynamicDefinition = @($catalog.dynamicLabels | Select-Object -First 1)
    if ($dynamicDefinition.Count -gt 0) {
        foreach ($profileName in $Config.profiles.Keys) {
            $labelsToSync += [ordered]@{
                name = "$($dynamicDefinition[0].prefix)$profileName"
                color = $dynamicDefinition[0].color
                description = ([string]$dynamicDefinition[0].descriptionTemplate).Replace('{value}', [string]$profileName)
            }
        }
    }
    $changes = @()
    foreach ($label in $labelsToSync) {
        $missing = $existingNames -notcontains $label.name
        $changes += [ordered]@{ name = $label.name; missing = $missing; applied = $false }
        if ($Apply -and $PSCmdlet.ShouldProcess("$Repository label '$($label.name)'", 'Create or update')) {
            Invoke-HdoGh @('label', 'create', $label.name, '--repo', $Repository, '--color', $label.color, '--description', $label.description, '--force') ([string]$Config.repositoryPath) -ThrowOnError | Out-Null
            $changes[-1].applied = $true
        }
    }
    return [ordered]@{ repository = $Repository; apply = [bool]$Apply; labels = $changes }
}
