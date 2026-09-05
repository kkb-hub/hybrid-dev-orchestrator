function Invoke-HdoGit {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [int]$TimeoutSeconds = 120,
        [switch]$ThrowOnError
    )

    # Windows worktrees can exceed MAX_PATH once dependency installers (e.g. pnpm's flat
    # .pnpm store) create deeply nested paths. This per-invocation setting (never persisted
    # to the user's repository config) lets git create and delete such paths when no config
    # file sets core.longpaths at all. Git resolves core.longpaths while it is still reading
    # its global/system config files, so a global- or system-level core.longpaths=false wins
    # over this -c (a repository-local value does not); that is why Remove-HdoRunWorktree
    # also carries a filesystem fallback (issue #25).
    $effectiveArguments = if ($IsWindows) { @('-c', 'core.longpaths=true') + $Arguments } else { $Arguments }
    return Invoke-HdoProcess -Command 'git' -Arguments $effectiveArguments -WorkingDirectory $WorkingDirectory `
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

function Test-HdoOrphanedWorktree {
    param(
        [Parameter(Mandatory)][string]$WorktreePath,
        [Parameter(Mandatory)][string]$RepositoryPath,
        [Parameter(Mandatory)][string]$WorktreeRoot,
        [Parameter(Mandatory)][string]$RunId,
        [AllowEmptyString()][string]$Branch
    )

    # A worktree whose `git worktree remove` died on "Filename too long" (issue #25) has
    # already lost its admin entry, its gitfile and its tracked files: git no longer lists
    # it and only the undeletable subtree (typically node_modules) is left. Recognise that
    # shape strictly so cleanup only ever finishes HDO's own worktree slot for this run:
    # the directory is exactly <worktreeRoot>/<runId> (how New-HdoWorktree names it), the
    # run's branch still exists in this repository, and nothing inside claims to be a Git
    # checkout of its own.
    $expectedPath = Get-HdoComparableFullPath (Join-Path $WorktreeRoot $RunId)
    if ((Get-HdoComparableFullPath $WorktreePath) -ne $expectedPath) { return $false }
    if (Test-Path -LiteralPath (Join-Path $WorktreePath '.git')) { return $false }
    if (-not $Branch) { return $false }
    $branchResult = Invoke-HdoGit @('show-ref', '--verify', '--quiet', "refs/heads/$Branch") $RepositoryPath
    return $branchResult.exitCode -eq 0
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

    $repositoryPath = [string]$config.repositoryPath
    $listed = Invoke-HdoGit @('worktree', 'list', '--porcelain') $repositoryPath -ThrowOnError
    $listedWorktreePath = @($listed.stdout -split "`r?`n" | Where-Object { $_ -like 'worktree *' } |
        ForEach-Object { $_.Substring('worktree '.Length) } |
        Where-Object { (Get-HdoComparableFullPath $_) -eq (Get-HdoComparableFullPath $worktreePath) } |
        Select-Object -First 1)
    $orphaned = $false
    if ($listedWorktreePath.Count -eq 0) {
        if (-not (Test-HdoOrphanedWorktree $worktreePath $repositoryPath ([string]$config.paths.worktreeRoot) $RunId ([string](Get-HdoValue $run 'worktree.branch' '')))) {
            throw "Refusing cleanup because Git does not list the target as a worktree: $worktreePath"
        }
        if (-not $Force) {
            throw "Refusing cleanup because Git does not list the target as a worktree: $worktreePath. The directory is an orphaned worktree of this repository whose Git admin entry is already gone (issue #25); re-run with -Force to delete it."
        }
        $orphaned = $true
    }
    if (-not $orphaned) {
        $dirty = Invoke-HdoGit @('status', '--porcelain=v1', '--untracked-files=all') $worktreePath -ThrowOnError
        if ($dirty.stdout.Trim() -and -not $Force) {
            throw "Worktree has uncommitted changes. Re-run with -Force only after preserving the diff: $worktreePath"
        }
    }

    if ($PSCmdlet.ShouldProcess($worktreePath, 'Remove HDO Git worktree')) {
        $removeResult = $null
        if (-not $orphaned) {
            $arguments = @('worktree', 'remove')
            if ($Force) { $arguments += '--force' }
            $arguments += $listedWorktreePath[0]
            $removeResult = Invoke-HdoGit $arguments $repositoryPath -TimeoutSeconds 300
        }
        if ($orphaned -or $removeResult.exitCode -ne 0) {
            # Git deletes its worktree admin entry (and tracked files) before a
            # "Filename too long" failure on Windows, leaving the directory behind while
            # `git worktree list` no longer shows it. Only that shape - the target is no
            # longer listed - is finished here with a filesystem delete plus
            # `git worktree prune`; any other refusal (locked worktree, submodules, ...)
            # is surfaced unchanged so this never deletes what git declined to remove.
            $gitFailure = ''
            if ($removeResult) {
                $detail = if ($removeResult.stderr) { $removeResult.stderr.Trim() } else { $removeResult.stdout.Trim() }
                $gitFailure = "Command 'git' failed with exit code $($removeResult.exitCode). $detail"
                $stillListed = @((Invoke-HdoGit @('worktree', 'list', '--porcelain') $repositoryPath -ThrowOnError).stdout -split "`r?`n" |
                    Where-Object { $_ -like 'worktree *' } |
                    ForEach-Object { $_.Substring('worktree '.Length) } |
                    Where-Object { (Get-HdoComparableFullPath $_) -eq (Get-HdoComparableFullPath $worktreePath) })
                if ($stillListed.Count -gt 0) { throw $gitFailure }
                Write-Verbose "git worktree remove failed for '$worktreePath' after unregistering it ($detail); finishing the removal on the filesystem."
            }
            $removalError = ''
            if (Test-Path -LiteralPath $worktreePath -PathType Container) {
                # .NET on PowerShell 7 handles paths beyond MAX_PATH itself (it adds the
                # \\?\ prefix internally), so the literal path is passed as-is.
                try { Remove-Item -LiteralPath $worktreePath -Recurse -Force -ErrorAction Stop }
                catch { $removalError = $_.Exception.Message }
            }
            Invoke-HdoGit @('worktree', 'prune') $repositoryPath -TimeoutSeconds 300 | Out-Null
            if (Test-Path -LiteralPath $worktreePath -PathType Container) {
                $suffix = if ($removalError) { " Fallback removal of '$worktreePath' failed: $removalError" } else { " Fallback removal left '$worktreePath' in place." }
                if ($gitFailure) { throw ($gitFailure + $suffix) }
                throw "Failed to remove orphaned worktree directory.$suffix"
            }
        }
        $run['cleanup'] = [ordered]@{ worktreeRemoved = $true; removedAt = Get-HdoUtcTimestamp; forced = [bool]$Force }
        Save-HdoRun $run $artifactPath
        return [ordered]@{ runId = $RunId; removed = $true; path = $worktreePath; branchPreserved = $run.worktree.branch }
    }
}
