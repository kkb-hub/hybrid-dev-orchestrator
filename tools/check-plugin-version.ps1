<#
.SYNOPSIS
    Claude / Codex plugin manifest の version が、配布面の変更に追随しているかを検査する。

.DESCRIPTION
    HDO の client repository は plugin manifest の version でのみ更新を検知する。
    そのため配布される file（hdo.ps1 / src / commands / skills / config / schemas と
    manifest 自体）が変わったのに version が据え置かれると、client 側は更新を取得できない。
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
# フェーズ7 cut-over 後は plugin の runtime が node になり、依存（ajv / ajv-formats /
# koffi）が package.json / package-lock.json で固定される。これらは配布面の一部
# （`npm ci` で client にも展開される）なので、依存変更も version bump 対象にする。
$watchedPaths = @(
    'hdo.ps1',
    'src/',
    'commands/',
    'skills/',
    'config/',
    'schemas/',
    'workers/',
    'package.json',
    'package-lock.json',
    $claudeManifestPath,
    $codexManifestPath
)

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
$watchedChanges = @(
    $changedFiles | Where-Object {
        $file = $_
        @($watchedPaths | Where-Object {
                # ディレクトリ entry（trailing '/'）は配下すべてに一致させ、
                # ファイル entry は完全一致のみに限定する（例: hdo.ps1.bak を誤検知しない）。
                if ($_.EndsWith('/')) { $file.StartsWith($_, [StringComparison]::Ordinal) }
                else { $file -eq $_ }
            }).Count -gt 0
    }
)

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
