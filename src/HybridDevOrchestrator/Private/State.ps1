$script:HdoTerminalStates = @('APPROVED', 'ESCALATED', 'FAILED', 'CANCELLED')
$script:HdoTransitions = [ordered]@{
    CREATED = @('ISSUE_SELECTED')
    ISSUE_SELECTED = @('PREFLIGHT')
    PREFLIGHT = @('ISSUE_CLAIMED', 'WORKTREE_READY')
    ISSUE_CLAIMED = @('WORKTREE_READY')
    WORKTREE_READY = @('PLANNING', 'IMPLEMENTING')
    PLANNING = @('IMPLEMENTING')
    IMPLEMENTING = @('VALIDATING')
    VALIDATING = @('REVIEWING', 'CHANGES_REQUESTED')
    REVIEWING = @('APPROVED', 'CHANGES_REQUESTED', 'ESCALATED')
    CHANGES_REQUESTED = @('IMPLEMENTING', 'ESCALATED')
    APPROVED = @()
    ESCALATED = @()
    FAILED = @()
    CANCELLED = @()
}

function Test-HdoStateTransition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$From,
        [Parameter(Mandatory)][string]$To
    )

    $fromState = $From.ToUpperInvariant()
    $toState = $To.ToUpperInvariant()
    if (-not $script:HdoTransitions.Contains($fromState)) { return $false }
    if ($toState -in @('FAILED', 'CANCELLED') -and $fromState -notin $script:HdoTerminalStates) { return $true }
    return $script:HdoTransitions[$fromState] -contains $toState
}

function Save-HdoRun {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Run,
        [Parameter(Mandatory)][string]$ArtifactPath
    )

    $Run.updatedAt = Get-HdoUtcTimestamp
    Write-HdoJsonFile (Join-Path $ArtifactPath 'run.json') $Run
}

function Add-HdoRunEvent {
    param(
        [Parameter(Mandatory)][string]$ArtifactPath,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Event
    )

    $Event['at'] = Get-HdoUtcTimestamp
    $line = Protect-HdoText ($Event | ConvertTo-Json -Compress -Depth 50)
    Add-Content -LiteralPath (Join-Path $ArtifactPath 'events.jsonl') -Value $line -Encoding utf8NoBOM
}

function Set-HdoRunState {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Run,
        [Parameter(Mandatory)][string]$State,
        [Parameter(Mandatory)][string]$ArtifactPath,
        [string]$Reason
    )

    $from = [string]$Run.state
    $to = $State.ToUpperInvariant()
    if (-not (Test-HdoStateTransition $from $to)) {
        throw "Invalid HDO state transition: $from -> $to"
    }
    $Run.state = $to
    Add-HdoRunEvent $ArtifactPath ([ordered]@{
        type = 'state.transition'
        from = $from
        to = $to
        reason = $Reason
        iteration = $Run.iteration
    })
    Save-HdoRun $Run $ArtifactPath
}

function Get-HdoRun {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RunId,
        [string]$ArtifactRoot,
        [string]$RepositoryPath = (Get-Location).Path,
        [string[]]$ConfigPath,
        [string]$Profile,
        [switch]$IgnoreRepositoryConfig
    )

    if (-not $ArtifactRoot) {
        $config = Get-HdoConfig -RepositoryPath $RepositoryPath -ConfigPath $ConfigPath -Profile $Profile -IgnoreRepositoryConfig:$IgnoreRepositoryConfig
        $ArtifactRoot = [string]$config.paths.artifactRoot
    }
    $runPath = Join-Path ([System.IO.Path]::GetFullPath($ArtifactRoot)) $RunId
    return Read-HdoJsonFile (Join-Path $runPath 'run.json')
}
