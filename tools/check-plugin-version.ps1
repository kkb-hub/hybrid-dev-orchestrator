<#
.SYNOPSIS
    Claude / Codex plugin manifest の version が、配布面の変更に追随しているかを検査する。

.DESCRIPTION
    HDO の client repository は plugin manifest の version でのみ更新を検知する。
    そのため配布される file（hdo.ps1 / src / commands / skills / config / schemas /
    workers と manifest 自体、および package.json / package-lock.json の runtime 依存）
    が変わったのに version が据え置かれると、client 側は更新を取得できない。
    devDependencies だけの変更は client の動作を変えないため bump を要求しない。
    本 script は base ref と head ref を比較し、次を検査する。

      1. Claude manifest と Codex manifest の version が一致すること
      2. 配布面が変更されている場合、version が base より増加していること

.EXAMPLE
    pwsh -NoProfile -File tools/check-plugin-version.ps1 -BaseRef origin/main
#>
[CmdletBinding()]
param(
    [string]$BaseRef = 'origin/main',
    [string]$HeadRef = 'HEAD'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$claudeManifestPath = '.claude-plugin/plugin.json'
$codexManifestPath = '.codex-plugin/plugin.json'

# client に配布され動作を変えうる path。ここが変わったら version bump を要求する。
$watchedPaths = @(
    'hdo.ps1',
    'src/',
    'commands/',
    'skills/',
    'config/',
    'schemas/',
    'workers/',
    $claudeManifestPath,
    $codexManifestPath
)

# フェーズ7 cut-over 後は plugin の runtime が node になり、依存（ajv / ajv-formats /
# koffi）が package.json / package-lock.json で固定される。これらは配布面の一部
# （`npm ci` で client にも展開される）なので、依存変更も version bump 対象にする。
# ただし devDependencies（@types/node / typescript）は `node src/cli/main.ts` の実行時
# には使われず client の動作を変えないため、devDependencies だけが変わった場合
# （Dependabot の dev-dependencies group など）は bump を要求しない。
# 判定は path ではなく内容で行う: 両 file について runtime に関係する部分だけを
# 取り出して base / head を比較する。
$dependencyManifestPath = 'package.json'
$dependencyLockPath = 'package-lock.json'

$problems = [Collections.Generic.List[string]]::new()

function Add-Problem {
    param([Parameter(Mandatory)][string]$Message)
    $problems.Add($Message)
    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Host "::error::$Message"
    }
    else {
        Write-Host "ERROR: $Message" -ForegroundColor Red
    }
}

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & git -C $repositoryRoot @Arguments 2>&1
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output   = @($output | ForEach-Object { [string]$_ })
    }
}

function ConvertTo-SemVer {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $match = [regex]::Match($Value.Trim(), '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<pre>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$')
    if (-not $match.Success) { return $null }
    return [pscustomobject]@{
        Raw        = $Value.Trim()
        Major      = [int]$match.Groups['major'].Value
        Minor      = [int]$match.Groups['minor'].Value
        Patch      = [int]$match.Groups['patch'].Value
        PreRelease = $(if ($match.Groups['pre'].Success) { $match.Groups['pre'].Value } else { $null })
    }
}

function Compare-SemVer {
    param(
        [Parameter(Mandatory)]$Left,
        [Parameter(Mandatory)]$Right
    )
    foreach ($part in @('Major', 'Minor', 'Patch')) {
        if ($Left.$part -ne $Right.$part) {
            return [Math]::Sign($Left.$part - $Right.$part)
        }
    }
    if ($null -eq $Left.PreRelease -and $null -eq $Right.PreRelease) { return 0 }
    if ($null -eq $Left.PreRelease) { return 1 }
    if ($null -eq $Right.PreRelease) { return -1 }

    $leftParts = @($Left.PreRelease.Split('.'))
    $rightParts = @($Right.PreRelease.Split('.'))
    for ($i = 0; $i -lt [Math]::Max($leftParts.Count, $rightParts.Count); $i++) {
        if ($i -ge $leftParts.Count) { return -1 }
        if ($i -ge $rightParts.Count) { return 1 }
        $leftPart = $leftParts[$i]
        $rightPart = $rightParts[$i]
        $leftNumeric = $leftPart -match '^\d+$'
        $rightNumeric = $rightPart -match '^\d+$'
        if ($leftNumeric -and $rightNumeric) {
            $diff = [int]$leftPart - [int]$rightPart
            if ($diff -ne 0) { return [Math]::Sign($diff) }
            continue
        }
        if ($leftNumeric -ne $rightNumeric) { return $(if ($leftNumeric) { -1 } else { 1 }) }
        $diff = [string]::CompareOrdinal($leftPart, $rightPart)
        if ($diff -ne 0) { return [Math]::Sign($diff) }
    }
    return 0
}

function Get-ManifestVersion {
    param(
        [Parameter(Mandatory)][string]$Revision,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    $result = Invoke-Git -Arguments @('show', "${Revision}:${Path}")
    if ($result.ExitCode -ne 0) {
        # base 側に manifest が無い（新規追加）場合は version 未設定として扱う。
        return $null
    }
    $raw = $result.Output -join "`n"
    try {
        $manifest = $raw | ConvertFrom-Json -AsHashtable -Depth 50
    }
    catch {
        Add-Problem "$Label ($Revision) の JSON を解析できません: $($_.Exception.Message)"
        return $null
    }
    if (-not $manifest.ContainsKey('version')) {
        Add-Problem "$Label ($Revision) に version field がありません。"
        return $null
    }
    $version = ConvertTo-SemVer ([string]$manifest['version'])
    if ($null -eq $version) {
        Add-Problem "$Label ($Revision) の version '$($manifest['version'])' が semver (major.minor.patch) ではありません。"
    }
    return $version
}

function Get-JsonAtRevision {
    param(
        [Parameter(Mandatory)][string]$Revision,
        [Parameter(Mandatory)][string]$Path
    )
    $result = Invoke-Git -Arguments @('show', "${Revision}:${Path}")
    if ($result.ExitCode -ne 0) { return $null }
    try {
        return ($result.Output -join "`n") | ConvertFrom-Json -AsHashtable -Depth 100
    }
    catch {
        Add-Problem "$Path ($Revision) の JSON を解析できません: $($_.Exception.Message)"
        return $null
    }
}

function Get-RuntimeDependencyView {
    <#
    .SYNOPSIS
        package.json / package-lock.json から devDependencies に由来する部分を除いた
        「client の実行時に効く内容」を、比較用の正規化文字列として返す。
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [AllowNull()]$Json
    )
    if ($null -eq $Json) { return $null }

    if ($Path -eq $dependencyManifestPath) {
        $view = [ordered]@{}
        foreach ($key in $Json.Keys) {
            if ($key -eq 'devDependencies') { continue }
            $view[$key] = $Json[$key]
        }
        return ($view | ConvertTo-Json -Depth 100 -Compress)
    }

    if ($Path -eq $dependencyLockPath) {
        # lockfileVersion 2/3: `packages` の各 entry は `dev: true` で devDependencies
        # 由来（transitive を含む）と判別できる。root entry ("") は devDependencies
        # の宣言そのものを含むので、そこだけ落として残りを比較する。
        # top-level と root entry の name / version / license は package.json の写しで
        # あり（npm が lockfile を再生成した際に追随するだけ）、install 内容を変えない
        # ので比較から外す。package.json 側の同じ field は manifest の比較で見ている。
        # 想定外の形式（`packages` が無い lockfileVersion 1 など）は判別できないので、
        # file 全体を比較対象にして保守的に扱う。
        $mirroredMetadataKeys = @('name', 'version', 'license')
        if (-not $Json.ContainsKey('packages') -or $Json['packages'] -isnot [Collections.IDictionary]) {
            return ($Json | ConvertTo-Json -Depth 100 -Compress)
        }
        $view = [ordered]@{}
        foreach ($key in $Json.Keys) {
            if ($key -eq 'packages' -or $key -in $mirroredMetadataKeys) { continue }
            $view[$key] = $Json[$key]
        }
        $packages = [ordered]@{}
        foreach ($entryPath in $Json['packages'].Keys) {
            $entry = $Json['packages'][$entryPath]
            if ($entryPath -eq '') {
                $root = [ordered]@{}
                foreach ($key in $entry.Keys) {
                    if ($key -eq 'devDependencies' -or $key -in $mirroredMetadataKeys) { continue }
                    $root[$key] = $entry[$key]
                }
                $packages[$entryPath] = $root
                continue
            }
            if ($entry -is [Collections.IDictionary] -and $entry.ContainsKey('dev') -and $entry['dev'] -eq $true) { continue }
            $packages[$entryPath] = $entry
        }
        $view['packages'] = $packages
        return ($view | ConvertTo-Json -Depth 100 -Compress)
    }

    throw "Get-RuntimeDependencyView: 未対応の path '$Path'"
}

function Test-RuntimeDependencyChange {
    <#
    .SYNOPSIS
        package.json / package-lock.json の変更が runtime 依存（devDependencies 以外）
        に影響するかを返す。base か head に file が無い場合は変更ありとして扱う。
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$BaseRevision,
        [Parameter(Mandatory)][string]$HeadRevision
    )
    $baseJson = Get-JsonAtRevision -Revision $BaseRevision -Path $Path
    $headJson = Get-JsonAtRevision -Revision $HeadRevision -Path $Path
    if ($null -eq $baseJson -or $null -eq $headJson) { return $true }
    $baseView = Get-RuntimeDependencyView -Path $Path -Json $baseJson
    $headView = Get-RuntimeDependencyView -Path $Path -Json $headJson
    return $baseView -ne $headView
}

$baseResolve = Invoke-Git -Arguments @('rev-parse', '--verify', "$BaseRef^{commit}")
if ($baseResolve.ExitCode -ne 0) {
    Write-Host "ERROR: base ref '$BaseRef' を解決できません。fetch 済みか確認してください。" -ForegroundColor Red
    exit 2
}
$headResolve = Invoke-Git -Arguments @('rev-parse', '--verify', "$HeadRef^{commit}")
if ($headResolve.ExitCode -ne 0) {
    Write-Host "ERROR: head ref '$HeadRef' を解決できません。" -ForegroundColor Red
    exit 2
}
$baseCommit = $baseResolve.Output[0]
$headCommit = $headResolve.Output[0]

$mergeBase = Invoke-Git -Arguments @('merge-base', $baseCommit, $headCommit)
$baseRevision = $(if ($mergeBase.ExitCode -eq 0) { $mergeBase.Output[0] } else { $baseCommit })

Write-Host "base : $BaseRef ($baseRevision)"
Write-Host "head : $HeadRef ($headCommit)"

# NOTE: base が head の祖先より進んでいる（例: main を古い commit へ force push で
# 巻き戻した）場合、merge-base は headCommit と一致しうる。その場合でも Claude/Codex
# の version 一致 checkは skip せず必ず実行する（下記は diff 計算のみを早期終了させる）。
$hasDiff = $baseRevision -ne $headCommit

$diff = $(if ($hasDiff) { Invoke-Git -Arguments @('diff', '--name-only', $baseRevision, $headCommit) } else { [pscustomobject]@{ ExitCode = 0; Output = @() } })
if ($diff.ExitCode -ne 0) {
    Write-Host "ERROR: 差分を取得できません: $($diff.Output -join "`n")" -ForegroundColor Red
    exit 2
}
$changedFiles = @($diff.Output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$watchedChanges = [Collections.Generic.List[string]]::new()
$devOnlyDependencyChanges = [Collections.Generic.List[string]]::new()
foreach ($file in $changedFiles) {
    if ($file -eq $dependencyManifestPath -or $file -eq $dependencyLockPath) {
        if (Test-RuntimeDependencyChange -Path $file -BaseRevision $baseRevision -HeadRevision $headCommit) {
            $watchedChanges.Add($file)
        }
        else {
            $devOnlyDependencyChanges.Add($file)
        }
        continue
    }
    $isWatched = @($watchedPaths | Where-Object {
            # ディレクトリ entry（trailing '/'）は配下すべてに一致させ、
            # ファイル entry は完全一致のみに限定する（例: hdo.ps1.bak を誤検知しない）。
            if ($_.EndsWith('/')) { $file.StartsWith($_, [StringComparison]::Ordinal) }
            else { $file -eq $_ }
        }).Count -gt 0
    if ($isWatched) { $watchedChanges.Add($file) }
}
$watchedChanges = @($watchedChanges)
$devOnlyDependencyChanges = @($devOnlyDependencyChanges)

if ($devOnlyDependencyChanges.Count -gt 0) {
    Write-Host ''
    Write-Host "devDependencies のみの変更（version bump 対象外） $($devOnlyDependencyChanges.Count) 件:"
    foreach ($file in $devOnlyDependencyChanges) { Write-Host "  - $file" }
}

$baseClaude = Get-ManifestVersion -Revision $baseRevision -Path $claudeManifestPath -Label 'Claude manifest'
$baseCodex = Get-ManifestVersion -Revision $baseRevision -Path $codexManifestPath -Label 'Codex manifest'
$headClaude = Get-ManifestVersion -Revision $headCommit -Path $claudeManifestPath -Label 'Claude manifest'
$headCodex = Get-ManifestVersion -Revision $headCommit -Path $codexManifestPath -Label 'Codex manifest'

if ($null -eq $headClaude) { Add-Problem "$claudeManifestPath の version を読み取れませんでした。" }
if ($null -eq $headCodex) { Add-Problem "$codexManifestPath の version を読み取れませんでした。" }

if ($null -ne $headClaude -and $null -ne $headCodex -and (Compare-SemVer $headClaude $headCodex) -ne 0) {
    Add-Problem "Claude ($($headClaude.Raw)) と Codex ($($headCodex.Raw)) の plugin version が一致していません。両 manifest を同じ version に揃えてください。"
}

if ($watchedChanges.Count -gt 0) {
    Write-Host ''
    Write-Host "version bump を要求する変更 $($watchedChanges.Count) 件:"
    foreach ($file in $watchedChanges) { Write-Host "  - $file" }
    Write-Host ''

    foreach ($manifest in @(
            @{ Label = 'Claude'; Path = $claudeManifestPath; Base = $baseClaude; Head = $headClaude },
            @{ Label = 'Codex'; Path = $codexManifestPath; Base = $baseCodex; Head = $headCodex }
        )) {
        if ($null -eq $manifest.Head) { continue }
        if ($null -eq $manifest.Base) {
            Write-Host "$($manifest.Label): base に manifest が無いため新規追加として扱います ($($manifest.Head.Raw))。"
            continue
        }
        $comparison = Compare-SemVer $manifest.Head $manifest.Base
        if ($comparison -gt 0) {
            Write-Host "$($manifest.Label): $($manifest.Base.Raw) -> $($manifest.Head.Raw) OK"
        }
        elseif ($comparison -eq 0) {
            Add-Problem "$($manifest.Label) plugin の version が $($manifest.Base.Raw) のままです。配布面を変更したので $($manifest.Path) の version を上げてください。"
        }
        else {
            Add-Problem "$($manifest.Label) plugin の version が $($manifest.Base.Raw) から $($manifest.Head.Raw) へ後退しています。"
        }
    }
}
else {
    Write-Host '配布面の変更がないため version bump は不要です。'
}

if ($env:GITHUB_STEP_SUMMARY) {
    $summary = [Collections.Generic.List[string]]::new()
    $summary.Add('## HDO plugin version guard')
    $summary.Add('')
    $summary.Add('| plugin | base | head |')
    $summary.Add('| --- | --- | --- |')
    $summary.Add("| Claude | $(if ($baseClaude) { $baseClaude.Raw } else { '-' }) | $(if ($headClaude) { $headClaude.Raw } else { '-' }) |")
    $summary.Add("| Codex | $(if ($baseCodex) { $baseCodex.Raw } else { '-' }) | $(if ($headCodex) { $headCodex.Raw } else { '-' }) |")
    $summary.Add('')
    $summary.Add("配布面の変更: $($watchedChanges.Count) 件")
    foreach ($file in $watchedChanges) { $summary.Add("- ``$file``") }
    if ($devOnlyDependencyChanges.Count -gt 0) {
        $summary.Add('')
        $summary.Add("devDependencies のみの変更（version bump 対象外）: $($devOnlyDependencyChanges.Count) 件")
        foreach ($file in $devOnlyDependencyChanges) { $summary.Add("- ``$file``") }
    }
    if ($problems.Count -gt 0) {
        $summary.Add('')
        $summary.Add('### 検出された問題')
        foreach ($problem in $problems) { $summary.Add("- $problem") }
    }
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value ($summary -join "`n") -Encoding utf8
}

if ($problems.Count -gt 0) {
    Write-Host ''
    Write-Host "$($problems.Count) 件の問題を検出しました。" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'plugin version guard: OK'
exit 0
