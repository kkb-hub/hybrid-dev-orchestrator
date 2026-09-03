[CmdletBinding()]
param(
    [switch]$Run,
    [string]$Model = 'qwen3.8:27b-q4_K_M'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

if (-not $Run) {
    Write-Host 'SKIP: real Ollama smoke is opt-in. Run: pwsh -NoProfile -File tests/test-ollama-smoke.ps1 -Run'
    exit 0
}

foreach ($commandName in @('git', 'codex', 'ollama')) {
    if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        throw "Required command was not found: $commandName"
    }
}

$versionText = (& ollama --version 2>&1 | Out-String).Trim()
$versionMatch = [regex]::Match($versionText, '\d+\.\d+\.\d+')
if ($LASTEXITCODE -ne 0 -or -not $versionMatch.Success) {
    throw "Unable to determine the Ollama version: $versionText"
}
$ollamaVersion = [version]$versionMatch.Value
if ($ollamaVersion -lt [version]'0.33.2') {
    throw "Ollama 0.33.2 or later is required; found $ollamaVersion."
}

$modelList = (& ollama list 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "Ollama is unavailable: $modelList" }
if (@($modelList -split "`r?`n" | Where-Object { $_ -match "^$([regex]::Escape($Model))\s" }).Count -eq 0) {
    throw "The required Ollama model is not installed: $Model"
}

$modulePath = Join-Path $repositoryRoot 'src/HybridDevOrchestrator/HybridDevOrchestrator.psd1'
Import-Module $modulePath -Force
$module = Get-Module HybridDevOrchestrator
$smokeBase = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'test-results'))
$smokeRoot = Join-Path $smokeBase "ollama-smoke-$([guid]::NewGuid().ToString('N'))"
$smokeRepository = Join-Path $smokeRoot 'repository'
$artifactDirectory = Join-Path $smokeRoot 'artifacts'

try {
    New-Item -ItemType Directory -Path $smokeRepository, $artifactDirectory -Force | Out-Null
    & git -C $smokeRepository init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Failed to initialize the isolated smoke repository.' }

    $config = Get-HdoConfig -RepositoryPath $smokeRepository `
        -ConfigPath (Join-Path $repositoryRoot 'config/examples/ollama-hybrid.json') `
        -IgnoreRepositoryConfig
    $plan = Get-HdoExecutionPlan $config
    if ($plan.steps.plan.provider -ne 'cloud' -or $plan.steps.review.provider -ne 'cloud') {
        throw 'The smoke profile changed the parent planning or review provider from cloud.'
    }
    if ($plan.steps.implement.provider -ne 'ollama' -or $plan.steps.fix.provider -ne 'ollama') {
        throw 'The smoke profile did not route implementation and fix to Ollama.'
    }
    if ($plan.steps.implement.model -ne $Model) {
        throw "The smoke profile selected '$($plan.steps.implement.model)' instead of '$Model'."
    }

    $lastMessagePath = Join-Path $artifactDirectory 'last-message.txt'
    $stdoutPath = Join-Path $artifactDirectory 'stdout.jsonl'
    $stderrPath = Join-Path $artifactDirectory 'stderr.log'
    $arguments = @(
        'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--json', '--color', 'never',
        '--sandbox', 'workspace-write', '--cd', $smokeRepository,
        '--oss', '--local-provider', 'ollama', '--model', $Model,
        '--output-last-message', $lastMessagePath,
        'Do not modify files or run tools. Reply with exactly: HDO_OLLAMA_SMOKE_OK'
    )
    $environment = & $module { Get-HdoSafeEnvironment }
    $result = & $module {
        param($Arguments, $WorkingDirectory, $Environment, $StdoutPath, $StderrPath)
        Invoke-HdoProcess -Command 'codex' -Arguments $Arguments -WorkingDirectory $WorkingDirectory `
            -TimeoutSeconds 600 -Environment $Environment -StandardOutputPath $StdoutPath `
            -StandardErrorPath $StderrPath -MaximumOutputBytes 33554432
    } $arguments $smokeRepository $environment $stdoutPath $stderrPath

    if ($result.exitCode -ne 0) {
        throw "Codex/Ollama smoke failed with exit code $($result.exitCode): $($result.stderr.Trim())"
    }
    if (-not (Test-Path -LiteralPath $lastMessagePath -PathType Leaf)) {
        throw 'Codex/Ollama smoke did not produce a final message.'
    }
    $lastMessage = (Get-Content -LiteralPath $lastMessagePath -Raw).Trim()
    if ($lastMessage -ne 'HDO_OLLAMA_SMOKE_OK') {
        throw "Unexpected Codex/Ollama smoke response: $lastMessage"
    }
    $status = @(& git -C $smokeRepository status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) {
        throw "The local smoke modified its isolated repository: $($status -join ', ')"
    }

    $runningModels = (& ollama ps 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $runningModels -notmatch "(?m)^$([regex]::Escape($Model))\s") {
        throw "The request completed but Ollama did not report the selected model as loaded: $runningModels"
    }

    Write-Host "PASS: parent plan/review stayed cloud; implement/fix used Ollama model $Model and returned HDO_OLLAMA_SMOKE_OK."
}
finally {
    $resolvedSmokeRoot = [IO.Path]::GetFullPath($smokeRoot)
    if (-not $resolvedSmokeRoot.StartsWith($smokeBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a smoke directory outside '$smokeBase': $resolvedSmokeRoot"
    }
    if (Test-Path -LiteralPath $resolvedSmokeRoot) {
        Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
    }
}
