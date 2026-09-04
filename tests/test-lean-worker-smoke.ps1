#Requires -Version 7.0
<#
.SYNOPSIS
    workers/hdo-ollama-worker.ps1 の opt-in real-provider smoke test。

.DESCRIPTION
    実 Ollama を呼ぶため通常の CI からは実行しない。隔離した一時 Git repository を
    作り、config/examples/ollama-lean-worker.json が implement/fix だけを local へ
    routing していることを検査してから、Invoke-HdoAgentStep をそのまま通す。

    test-ollama-smoke.ps1 が Invoke-HdoProcess を直接呼ぶのに対し、こちらは HDO の
    agent step 経路全体（command adapter、schema validation、credential redaction）
    を通すので、worker が本番と同じ契約で動くことまで検査できる。

.EXAMPLE
    pwsh -NoProfile -File tests/test-lean-worker-smoke.ps1 -Run
#>
[CmdletBinding()]
param(
    [switch]$Run,
    [string]$Model = 'qwen3.8:27b-q4_K_M',
    [int]$ContextTokens = 32768,
    [switch]$KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

if (-not $Run) {
    Write-Host 'SKIP: real Ollama smoke is opt-in. Run: pwsh -NoProfile -File tests/test-lean-worker-smoke.ps1 -Run'
    exit 0
}

Import-Module (Join-Path $repositoryRoot 'src/HybridDevOrchestrator/HybridDevOrchestrator.psd1') -Force
$module = Get-Module HybridDevOrchestrator

$smokeRoot = Join-Path ([IO.Path]::GetFullPath((Join-Path $repositoryRoot 'test-results'))) "lean-worker-smoke-$([guid]::NewGuid().ToString('N'))"
$smokeRepository = Join-Path $smokeRoot 'repository'
$artifactDirectory = Join-Path $smokeRoot 'artifacts'
$failures = 0

function Assert-Smoke {
    param([bool]$Condition, [string]$Message)
    if ($Condition) { Write-Host "PASS: $Message" }
    else { Write-Host "FAIL: $Message"; $script:failures++ }
}

try {
    New-Item -ItemType Directory -Path $smokeRepository -Force | Out-Null
    New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
    & git -C $smokeRepository init --quiet
    & git -C $smokeRepository config user.email 'hdo-tests@example.invalid'
    & git -C $smokeRepository config user.name 'HDO Tests'
    & git -C $smokeRepository config commit.gpgSign false

    # A real off-by-one so the worker has to read before it edits rather than being able
    # to produce a correct file from the prompt alone.
    Set-Content -LiteralPath (Join-Path $smokeRepository 'calc.ps1') -Encoding utf8NoBOM -Value @'
function Get-Sum {
    param([int[]]$Values)
    $total = 0
    for ($i = 0; $i -lt $Values.Count - 1; $i++) { $total += $Values[$i] }
    return $total
}
'@
    & git -C $smokeRepository add -- calc.ps1
    & git -C $smokeRepository commit --quiet -m baseline

    $config = Get-HdoConfig -RepositoryPath $smokeRepository `
        -ConfigPath (Join-Path $repositoryRoot 'config/examples/ollama-lean-worker.json') `
        -IgnoreRepositoryConfig
    $plan = Get-HdoExecutionPlan $config
    Assert-Smoke ($plan.steps.plan.provider -eq 'cloud' -and $plan.steps.review.provider -eq 'cloud') 'planning and review stay on the cloud provider'
    Assert-Smoke ($plan.steps.implement.provider -eq 'ollama' -and $plan.steps.implement.type -eq 'command') 'implementation is routed to the local command worker'
    Assert-Smoke ([int]$plan.steps.implement.contextTokens -eq $ContextTokens) "the profile requests the VRAM-friendly $ContextTokens-token window"

    # Not $run: PowerShell variable names are case-insensitive, so it would overwrite the
    # script's own [switch]$Run parameter.
    $runState = [ordered]@{
        schemaVersion = 1
        id = "lean-worker-smoke-$([guid]::NewGuid().ToString('N'))"
        state = 'IMPLEMENTING'
        iteration = 1
        createdAt = ([DateTimeOffset]::UtcNow.ToString('o'))
        updatedAt = ([DateTimeOffset]::UtcNow.ToString('o'))
        artifactPath = $artifactDirectory
    }
    $result = & $module {
        param($Config, $RunState, $WorkingDirectory, $Prompt, $ArtifactDirectory)
        Invoke-HdoAgentStep -Config $Config -Run $RunState -Step 'implement' -Iteration 1 `
            -WorkingDirectory $WorkingDirectory -Prompt $Prompt -ArtifactDirectory $ArtifactDirectory `
            -OutputSchema 'worker-result'
    } $config $runState $smokeRepository 'The function Get-Sum in calc.ps1 has an off-by-one bug: the loop stops one element early, so the last value is never added. Read the file, fix the loop bound, and save it.' $artifactDirectory

    Assert-Smoke ($result.status -eq 'succeeded') 'the agent step reports success'
    Assert-Smoke ($result.process.exitCode -eq 0) 'the worker process exits zero'

    $fixed = Get-Content -LiteralPath (Join-Path $smokeRepository 'calc.ps1') -Raw
    Assert-Smoke ($fixed -notmatch '\$Values\.Count - 1') 'the off-by-one loop bound is gone'
    Assert-Smoke ($fixed -match '\$i -lt \$Values\.Count') 'the loop bound now covers the final element'

    # Invoke-HdoAgentStep already schema-validates before returning, so reaching here with
    # a populated output means the structured contract held end to end.
    Assert-Smoke ([int]$result.output.schemaVersion -eq 1) 'the worker returns a schema-valid structured result'
    Assert-Smoke ([string]$result.output.summary -ne '') 'the structured result carries a summary'

    $diff = (& git -C $smokeRepository diff --name-only) -join ' '
    Assert-Smoke ($diff -match 'calc\.ps1') 'git sees exactly the expected file change'
    Assert-Smoke (@(& git -C $smokeRepository status --porcelain).Count -eq 1) 'the worker did not touch any other file'
}
finally {
    if ($KeepArtifacts) { Write-Host "artifacts retained at $smokeRoot" }
    else { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failures -gt 0) {
    Write-Host ''
    Write-Host "$failures lean worker smoke check(s) failed."
    exit 1
}
Write-Host ''
Write-Host 'Lean worker smoke passed.'
exit 0
