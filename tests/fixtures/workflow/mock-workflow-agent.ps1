param(
    [Parameter(Mandatory)][string]$SchemaFile,
    [Parameter(Mandatory)][string]$OutputFile,
    [Parameter(Mandatory)][string]$Scenario
)

# Deterministic plan/implement/fix/review runner for the ADR-0001 phase-6 workflow
# parity harness. Driven entirely by a scenario JSON file (§3.3 of the phase-6 plan)
# so the same script produces byte-identical artifacts regardless of which
# implementation (PowerShell or TypeScript) launched it as the `command` runner.

$prompt = [Console]::In.ReadToEnd()
$scenarioData = Get-Content -LiteralPath $Scenario -Raw | ConvertFrom-Json -AsHashtable -Depth 30

$schemaName = [IO.Path]::GetFileName($SchemaFile)
$result = switch ($schemaName) {
    'task-contract.schema.json' {
        # Never touches the worktree; the planning step is read-only in both
        # implementations, so this must not write any file besides -OutputFile.
        [ordered]@{
            schemaVersion = 1
            objective = 'Exercise the command runner.'
            approach = @('Return deterministic structured output.')
            acceptanceCriteria = @('AC-1: output is valid')
            expectedFiles = @()
            risks = @()
            assumptions = @()
        }
    }
    'worker-result.schema.json' {
        $firstLine = @($prompt -split "`r?`n")[0]
        if ($firstLine -notmatch '^You are the (implementation|fix) step of Hybrid Dev Orchestrator, iteration (?<n>\d+)\.') {
            throw "mock-workflow-agent.ps1: could not parse iteration from prompt first line: $firstLine"
        }
        $iteration = [int]$Matches.n
        $implement = if ($scenarioData.Contains('implement')) { $scenarioData.implement } else { [ordered]@{ mode = 'write' } }
        $mode = if ($implement.Contains('mode')) { [string]$implement.mode } else { 'write' }
        if ($mode -eq 'exit') {
            $exitCode = if ($implement.Contains('exitCode')) { [int]$implement.exitCode } else { 1 }
            [Console]::Error.WriteLine('mock implement failure')
            exit $exitCode
        }
        elseif ($mode -eq 'write') {
            Add-Content -LiteralPath (Join-Path (Get-Location).Path 'hdo-mock-change.txt') -Value "iteration $iteration" -Encoding utf8NoBOM
        }
        # mode 'none': writes nothing, so the run has no diff (scenario e/e2).
        [ordered]@{
            schemaVersion = 1
            summary = "Mock implementation iteration $iteration."
            changedFiles = @('hdo-mock-change.txt')
            tests = @('mock')
            notes = @()
            blockers = @()
        }
    }
    'review-result.schema.json' {
        if ($prompt -notmatch "Set runId to '(?<runId>[^']+)', baseCommit to '(?<base>[0-9a-f]{40})', diffHash to '(?<hash>[0-9a-f]{64})', and reviewRound to (?<round>\d+) in the result\.") {
            throw 'mock-workflow-agent.ps1: could not parse the binding-values line from the review prompt.'
        }
        $runId = $Matches.runId
        $baseCommit = $Matches.base
        $diffHash = $Matches.hash
        $round = [int]$Matches.round

        $previousFindings = @()
        if ($prompt -match "(?s)PREVIOUS REVIEW \(may be null\)\r?\n(?<prev>.*?)\r?\n\r?\nDIFF HASH:") {
            $previousReviewText = $Matches.prev.Trim()
            if ($previousReviewText -and $previousReviewText -ne 'null') {
                $previousReview = $previousReviewText | ConvertFrom-Json -AsHashtable -Depth 50
                $previousFindings = @($previousReview.findings)
            }
        }

        # Every previous finding (including HDO's own synthetic HDO-VALIDATION-R<n>
        # blocker) must be carried forward as resolved so Test-HdoReviewResult's
        # disappearance rule never rejects the mock's own output.
        $carriedFindings = @($previousFindings | ForEach-Object {
            [ordered]@{
                id = [string]$_.id
                severity = [string]$_.severity
                category = [string]$_.category
                evidence = [string]$_.evidence
                evidenceDetail = [string]$_.evidenceDetail
                status = 'resolved'
                actionable = $false
                path = $_.path
                line = $_.line
                message = [string]$_.message
                requiredAction = $null
            }
        })

        $reviews = @(if ($scenarioData.Contains('reviews')) { @($scenarioData.reviews) } else { @('approve') })
        $decisionIndex = [Math]::Min($round - 1, $reviews.Count - 1)
        $decision = [string]$reviews[$decisionIndex]

        $findings = @($carriedFindings)
        $escalationReason = $null
        if ($decision -eq 'request_changes') {
            $findings += [ordered]@{
                id = "MOCK-R$round-F1"
                severity = 'should'
                category = 'product_bug'
                evidence = 'read'
                evidenceDetail = 'Deterministic mock finding.'
                status = 'open'
                actionable = $true
                path = 'hdo-mock-change.txt'
                line = 1
                message = 'Mock reviewer requests a change.'
                requiredAction = 'Append another iteration line.'
            }
        }
        elseif ($decision -eq 'escalate') {
            $escalationReason = 'Mock reviewer escalated.'
        }

        [ordered]@{
            schemaVersion = 1
            runId = $runId
            baseCommit = $baseCommit
            diffHash = $diffHash
            reviewRound = $round
            decision = $decision
            summary = "Mock review round $round`: $decision."
            missingViewpoints = @()
            findings = @($findings)
            escalationReason = $escalationReason
        }
    }
    default { throw "Unsupported schema: $schemaName" }
}

$result | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $OutputFile -Encoding utf8NoBOM
$result | ConvertTo-Json -Compress -Depth 30
