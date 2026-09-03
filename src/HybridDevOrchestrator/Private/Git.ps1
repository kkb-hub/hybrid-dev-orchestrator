function Invoke-HdoGit {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [int]$TimeoutSeconds = 120,
        [switch]$ThrowOnError
    )

    return Invoke-HdoProcess -Command 'git' -Arguments $Arguments -WorkingDirectory $WorkingDirectory `
        -TimeoutSeconds $TimeoutSeconds -ThrowOnError:$ThrowOnError
}

function Get-HdoRepositoryRoot {
    param([Parameter(Mandatory)][string]$Path)

    $result = Invoke-HdoGit @('rev-parse', '--show-toplevel') $Path -ThrowOnError
    return [System.IO.Path]::GetFullPath($result.stdout.Trim())
}

function Get-HdoNormalizedFullPath {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fileSystemRoot = [System.IO.Path]::GetPathRoot($fullPath)
    while ($fullPath.Length -gt $fileSystemRoot.Length -and
        ($fullPath.EndsWith([string][System.IO.Path]::DirectorySeparatorChar) -or
         $fullPath.EndsWith([string][System.IO.Path]::AltDirectorySeparatorChar))) {
        $fullPath = $fullPath.Substring(0, $fullPath.Length - 1)
    }
    return $fullPath
}

function Get-HdoComparableFullPath {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = Get-HdoNormalizedFullPath $Path
    if (-not $IsWindows) { return $fullPath }

    # Packaged Windows apps can transparently redirect LocalAppData into the package's
    # LocalCache. Resolve the nearest existing ancestor by file handle so the configured
    # alias and Git's physical --show-toplevel path compare as the same location. Missing
    # descendants are appended without creating anything during configuration checks.
    $existingPath = $fullPath
    $missingSegments = [Collections.Generic.List[string]]::new()
    while (-not (Test-Path -LiteralPath $existingPath)) {
        $leaf = [IO.Path]::GetFileName($existingPath)
        $parent = [IO.Path]::GetDirectoryName($existingPath)
        if (-not $leaf -or -not $parent -or $parent -eq $existingPath) { break }
        $missingSegments.Insert(0, $leaf)
        $existingPath = $parent
    }
    if (-not (Test-Path -LiteralPath $existingPath)) { return $fullPath }
    try { $resolvedPath = [HybridDevOrchestrator.Internal.FinalPathResolver]::Resolve($existingPath) }
    catch { return $fullPath }
    foreach ($segment in $missingSegments) { $resolvedPath = Join-Path $resolvedPath $segment }
    return Get-HdoNormalizedFullPath $resolvedPath
}

function Get-HdoBaseCommit {
    param(
        [Parameter(Mandatory)][string]$RepositoryPath,
        [string]$BaseRef = 'HEAD'
    )

    $result = Invoke-HdoGit @('rev-parse', '--verify', "$BaseRef^{commit}") $RepositoryPath -ThrowOnError
    return $result.stdout.Trim()
}

function Assert-HdoWorktreeIntegrity {
    param(
        [Parameter(Mandatory)][string]$WorktreePath,
        [Parameter(Mandatory)][string]$BaseCommit
    )

    $actualRoot = Get-HdoRepositoryRoot $WorktreePath
    $expectedRoot = Get-HdoComparableFullPath $WorktreePath
    if ((Get-HdoComparableFullPath $actualRoot) -ne $expectedRoot) {
        throw "Agent working directory no longer resolves to the expected worktree: $actualRoot"
    }
    $head = Get-HdoBaseCommit $WorktreePath 'HEAD'
    if ($head -ne $BaseCommit) {
        throw "Worktree HEAD changed from fixed base '$BaseCommit' to '$head'. Agents must leave changes uncommitted."
    }
    return $true
}

function New-HdoWorktree {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][int]$IssueNumber
    )

    $repositoryPath = [string]$Config.repositoryPath
    $baseRef = [string](Get-HdoValue $Config 'git.baseRef' 'HEAD')
    $baseCommit = Get-HdoBaseCommit $repositoryPath $baseRef
    $worktreeRoot = [string]$Config.paths.worktreeRoot
    New-Item -ItemType Directory -Path $worktreeRoot -Force | Out-Null
    $worktreePath = Join-Path $worktreeRoot $RunId
    if (Test-Path -LiteralPath $worktreePath) { throw "Worktree path already exists: $worktreePath" }

    $branchSuffix = ($RunId -replace '[^A-Za-z0-9._-]', '-').ToLowerInvariant()
    $branch = "hdo/issue-$IssueNumber-$branchSuffix"
    $result = Invoke-HdoGit @('worktree', 'add', '-b', $branch, $worktreePath, $baseCommit) $repositoryPath -TimeoutSeconds 300
    if ($result.exitCode -ne 0) {
        throw "Failed to create worktree '$worktreePath': $($result.stderr.Trim())"
    }

    return [ordered]@{
        path = [System.IO.Path]::GetFullPath($worktreePath)
        branch = $branch
        baseRef = $baseRef
        baseCommit = $baseCommit
        createdAt = Get-HdoUtcTimestamp
    }
}

function Get-HdoDiff {
    param(
        [Parameter(Mandatory)][string]$WorktreePath,
        [Parameter(Mandatory)][string]$BaseCommit,
        [ValidateRange(1024, 1073741824)][long]$MaximumPatchBytes = 33554432
    )

    $patchResult = Invoke-HdoGit @('diff', '--binary', '--no-ext-diff', $BaseCommit, '--') $WorktreePath -TimeoutSeconds 300 -ThrowOnError
    $statResult = Invoke-HdoGit @('diff', '--numstat', $BaseCommit, '--') $WorktreePath -TimeoutSeconds 300 -ThrowOnError
    $encoding = [Text.UTF8Encoding]::new($false)
    $patchBuilder = [Text.StringBuilder]::new()
    $patchBytes = [long]$encoding.GetByteCount([string]$patchResult.stdout)
    if ($patchBytes -gt $MaximumPatchBytes) {
        throw "Aggregate Git diff exceeds the HDO patch limit of $MaximumPatchBytes bytes."
    }
    [void]$patchBuilder.Append([string]$patchResult.stdout)
    $numstat = @($statResult.stdout -split "`r?`n" | Where-Object { $_ })
    $untrackedResult = Invoke-HdoGit @('ls-files', '--others', '--exclude-standard', '-z') $WorktreePath -ThrowOnError
    foreach ($relativePath in @($untrackedResult.stdout -split "`0" | Where-Object { $_ })) {
        $untrackedPatch = Invoke-HdoGit @('diff', '--no-index', '--binary', '--', '/dev/null', $relativePath) $WorktreePath -TimeoutSeconds 300
        if ($untrackedPatch.exitCode -notin @(0, 1)) {
            throw "Failed to capture untracked file '$relativePath': $($untrackedPatch.stderr.Trim())"
        }
        if ($untrackedPatch.stdout) {
            $addition = "`n" + [string]$untrackedPatch.stdout
            $additionBytes = [long]$encoding.GetByteCount($addition)
            if ($patchBytes + $additionBytes -gt $MaximumPatchBytes) {
                throw "Aggregate Git diff exceeds the HDO patch limit of $MaximumPatchBytes bytes while adding untracked file '$relativePath'."
            }
            [void]$patchBuilder.Append($addition)
            $patchBytes += $additionBytes
        }
        $untrackedStat = Invoke-HdoGit @('diff', '--no-index', '--numstat', '--', '/dev/null', $relativePath) $WorktreePath -TimeoutSeconds 300
        if ($untrackedStat.exitCode -in @(0, 1) -and $untrackedStat.stdout.Trim()) {
            $numstat += @($untrackedStat.stdout -split "`r?`n" | Where-Object { $_ })
        }
    }
    $statusResult = Invoke-HdoGit @('status', '--porcelain=v1', '--untracked-files=all') $WorktreePath -ThrowOnError
    $patch = $patchBuilder.ToString()
    return [ordered]@{
        patch = $patch
        hash = Get-HdoSha256 $patch
        numstat = @($numstat)
        status = @($statusResult.stdout -split "`r?`n" | Where-Object { $_ })
        hasChanges = [bool]$statusResult.stdout.Trim()
        capturedAt = Get-HdoUtcTimestamp
    }
}

function Test-HdoPathWithinRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Root
    )

    $fullPath = Get-HdoComparableFullPath $Path
    $fullRoot = Get-HdoComparableFullPath $Root
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    return $fullPath.StartsWith($fullRoot + [System.IO.Path]::DirectorySeparatorChar, $comparison)
}

function Remove-HdoRunWorktree {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory)][string]$RunId,
        [string]$RepositoryPath = (Get-Location).Path,
        [string[]]$ConfigPath,
        [string]$Profile,
        [switch]$IgnoreRepositoryConfig,
        [switch]$Force
    )

    $config = Get-HdoConfig -RepositoryPath $RepositoryPath -ConfigPath $ConfigPath -Profile $Profile -IgnoreRepositoryConfig:$IgnoreRepositoryConfig
    $artifactPath = Join-Path ([string]$config.paths.artifactRoot) $RunId
    $run = Read-HdoJsonFile (Join-Path $artifactPath 'run.json')
    $worktreePath = [string](Get-HdoValue $run 'worktree.path' '')
    if (-not $worktreePath) { throw "Run '$RunId' has no worktree path." }
    if (-not (Test-HdoPathWithinRoot $worktreePath ([string]$config.paths.worktreeRoot))) {
        throw "Refusing cleanup because worktree is outside configured root: $worktreePath"
    }
    if (-not (Test-Path -LiteralPath $worktreePath -PathType Container)) {
        return [ordered]@{ runId = $RunId; removed = $false; reason = 'already-missing'; path = $worktreePath }
    }

    $listed = Invoke-HdoGit @('worktree', 'list', '--porcelain') ([string]$config.repositoryPath) -ThrowOnError
    $listedWorktreePath = @($listed.stdout -split "`r?`n" | Where-Object { $_ -like 'worktree *' } |
        ForEach-Object { $_.Substring('worktree '.Length) } |
        Where-Object { (Get-HdoComparableFullPath $_) -eq (Get-HdoComparableFullPath $worktreePath) } |
        Select-Object -First 1)
    if ($listedWorktreePath.Count -eq 0) {
        throw "Refusing cleanup because Git does not list the target as a worktree: $worktreePath"
    }
    $dirty = Invoke-HdoGit @('status', '--porcelain=v1', '--untracked-files=all') $worktreePath -ThrowOnError
    if ($dirty.stdout.Trim() -and -not $Force) {
        throw "Worktree has uncommitted changes. Re-run with -Force only after preserving the diff: $worktreePath"
    }

    if ($PSCmdlet.ShouldProcess($worktreePath, 'Remove HDO Git worktree')) {
        $arguments = @('worktree', 'remove')
        if ($Force) { $arguments += '--force' }
        $arguments += $listedWorktreePath[0]
        Invoke-HdoGit $arguments ([string]$config.repositoryPath) -TimeoutSeconds 300 -ThrowOnError | Out-Null
        $run['cleanup'] = [ordered]@{ worktreeRemoved = $true; removedAt = Get-HdoUtcTimestamp; forced = [bool]$Force }
        Save-HdoRun $run $artifactPath
        return [ordered]@{ runId = $RunId; removed = $true; path = $worktreePath; branchPreserved = $run.worktree.branch }
    }
}
