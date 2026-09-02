[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$passes = 0
$failures = [Collections.Generic.List[string]]::new()

function Assert-Plugin {
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

$codexManifestPath = Join-Path $repositoryRoot '.codex-plugin/plugin.json'
$claudeManifestPath = Join-Path $repositoryRoot '.claude-plugin/plugin.json'
$marketplacePath = Join-Path $repositoryRoot '.claude-plugin/marketplace.json'
$codexManifest = Get-Content -LiteralPath $codexManifestPath -Raw | ConvertFrom-Json -AsHashtable -Depth 50
$claudeManifest = Get-Content -LiteralPath $claudeManifestPath -Raw | ConvertFrom-Json -AsHashtable -Depth 50
$marketplace = Get-Content -LiteralPath $marketplacePath -Raw | ConvertFrom-Json -AsHashtable -Depth 50

Assert-Plugin ($codexManifest.name -eq 'hdo') 'Codex manifest keeps the published hdo plugin name'
Assert-Plugin ($codexManifest.version -eq $claudeManifest.version) 'Claude and Codex manifests publish the same version'
Assert-Plugin ($codexManifest.skills -eq './skills/') 'Codex manifest exposes the packaged skills directory'
Assert-Plugin ($codexManifest.interface.displayName -eq 'Hybrid Dev Orchestrator') 'Codex manifest provides a user-facing display name'
Assert-Plugin (@($codexManifest.interface.defaultPrompt).Count -ge 1) 'Codex manifest provides at least one starter prompt'
Assert-Plugin ($marketplace.plugins.Count -eq 1 -and $marketplace.plugins[0].name -eq 'hdo' -and $marketplace.plugins[0].source -eq './') 'Existing marketplace still resolves hdo from the repository root'

$expectedSkills = [ordered]@{
    'hdo-doctor' = 'doctor'
    'hdo-config' = 'config'
    'hdo-issues' = 'issues'
    'hdo-inspect' = 'inspect'
    'hdo-run' = 'run'
    'hdo-status' = 'status'
    'hdo-cleanup' = 'cleanup'
    'hdo-labels' = 'labels'
}
$skillRoot = Join-Path $repositoryRoot 'skills'
$actualSkillNames = @(Get-ChildItem -LiteralPath $skillRoot -Directory | Select-Object -ExpandProperty Name | Sort-Object)
$expectedSkillNames = @($expectedSkills.Keys | Sort-Object)
Assert-Plugin (($actualSkillNames -join ',') -eq ($expectedSkillNames -join ',')) 'Codex package contains exactly one skill for each Claude command'

foreach ($entry in $expectedSkills.GetEnumerator()) {
    $skillName = [string]$entry.Key
    $commandName = [string]$entry.Value
    $skillPath = Join-Path $skillRoot "$skillName/SKILL.md"
    $commandPath = Join-Path $repositoryRoot "commands/$commandName.md"
    $content = Get-Content -LiteralPath $skillPath -Raw
    Assert-Plugin (Test-Path -LiteralPath $commandPath -PathType Leaf) "Claude command remains available: $commandName"
    Assert-Plugin ($content -match "(?m)^name:\s*$([regex]::Escape($skillName))\s*$") "skill frontmatter name matches its directory: $skillName"
    Assert-Plugin ($content -match '(?m)^description:\s*\S') "skill has a discoverable description: $skillName"
    Assert-Plugin ($content -match [regex]::Escape('../../hdo.ps1')) "skill resolves hdo.ps1 relative to its package: $skillName"
    Assert-Plugin ($content -notmatch 'CLAUDE_PLUGIN_ROOT|allowed-tools|\$ARGUMENTS') "skill excludes Claude-only command metadata: $skillName"
}

Write-Host "`n$passes assertion(s) passed; $($failures.Count) failed."
if ($failures.Count -gt 0) {
    foreach ($failure in $failures) { Write-Host " - $failure" -ForegroundColor Red }
    exit 1
}
exit 0
