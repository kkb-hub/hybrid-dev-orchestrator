[CmdletBinding()]
param(
    [switch]$Run,
    [string]$Model = 'qwen3.8:27b-q4_K_M',
    [string]$ResultPath,
    [switch]$KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

if (-not $Run) {
    Write-Host 'SKIP: real Ollama smoke is opt-in. Run: pwsh -NoProfile -File tests/test-ollama-smoke.ps1 -Run'
    exit 0
}

$modulePath = Join-Path $repositoryRoot 'src/HybridDevOrchestrator/HybridDevOrchestrator.psd1'
Import-Module $modulePath -Force
$module = Get-Module HybridDevOrchestrator
$smokeBase = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'test-results'))
$smokeRoot = Join-Path $smokeBase "ollama-smoke-$([guid]::NewGuid().ToString('N'))"
$smokeRepository = Join-Path $smokeRoot 'repository'
$artifactDirectory = Join-Path $smokeRoot 'artifacts'
$startedAt = [DateTimeOffset]::UtcNow
if (-not $ResultPath) { $ResultPath = Join-Path $smokeBase 'ollama-smoke-last-result.json' }
$ResultPath = [IO.Path]::GetFullPath($ResultPath)
$receipt = [ordered]@{
    schemaVersion = 1
    status = 'running'
    model = $Model
    startedAt = $startedAt.ToString('o')
    endedAt = $null
    durationMs = $null
    lastHeartbeatAt = $startedAt.ToString('o')
    elapsedSeconds = 0
    resultPath = $ResultPath
    artifactsRetained = [bool]$KeepArtifacts
    artifactPath = $(if ($KeepArtifacts) { $smokeRoot } else { $null })
    process = $null
    checks = [ordered]@{
        route = $false
        exactBytes = $false
        schema = $false
        modelLoaded = $false
        fileSha256 = $null
    }
    error = $null
}

function Write-OllamaSmokeReceipt {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Value)

    $parent = Split-Path -Parent $ResultPath
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $temporaryPath = "$ResultPath.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temporaryPath -Encoding utf8NoBOM
        Move-Item -LiteralPath $temporaryPath -Destination $ResultPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    }
}

Write-OllamaSmokeReceipt $receipt
[Console]::Error.WriteLine("HDO_SMOKE_RECEIPT $ResultPath")

try {
    foreach ($commandName in @('git', 'codex', 'claude', 'ollama')) {
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
    $receipt.checks.route = $true
    Write-OllamaSmokeReceipt $receipt

    $stdoutPath = Join-Path $artifactDirectory 'envelope.json'
    $stderrPath = Join-Path $artifactDirectory 'stderr.log'
    $runner = $config.runners[[string]$config.steps.implement]
    $schemaPath = Join-Path $repositoryRoot 'schemas/worker-result.schema.json'
    $schemaJson = & $module { param($Path) ConvertTo-HdoClaudeJsonSchema $Path } $schemaPath
    $arguments = & $module {
        param($Runner, $SchemaJson)
        Get-HdoClaudeArguments -Runner $Runner -SchemaJson $SchemaJson
    } $runner $schemaJson
    $environment = & $module { param($Runner) Get-HdoRunnerEnvironment -Runner $Runner } $runner
    $prompt = @'
Create exactly one file named hdo-ollama-smoke.txt containing exactly HDO_OLLAMA_SMOKE_OK followed by a single LF newline. Verify its exact bytes. Then return the required structured worker result with that file in changedFiles, the byte verification in tests, empty notes, and empty blockers.
'@
    $inputText = & $module {
        param($Runner, $Prompt, $SchemaJson)
        Get-HdoClaudeInputText -Runner $Runner -Prompt $Prompt -SchemaJson $SchemaJson
    } $runner $prompt $schemaJson
    $smokeProgressAction = {
        param($Progress)
        $receipt.lastHeartbeatAt = [string]$Progress.at
        $receipt.elapsedSeconds = [int]$Progress.elapsedSeconds
        Write-OllamaSmokeReceipt $receipt
        [Console]::Error.WriteLine("HDO_PROGRESS $([ordered]@{ type = 'ollama-smoke.progress'; phase = 'heartbeat'; at = $Progress.at; model = $Model; elapsedSeconds = $Progress.elapsedSeconds; resultPath = $ResultPath } | ConvertTo-Json -Compress -Depth 10)")
    }
    $result = & $module {
        param($Arguments, $WorkingDirectory, $Environment, $StdoutPath, $StderrPath, $Prompt, $ProgressAction)
        Invoke-HdoProcess -Command 'claude' -Arguments $Arguments -WorkingDirectory $WorkingDirectory `
            -InputText $Prompt -TimeoutSeconds 600 -Environment $Environment -StandardOutputPath $StdoutPath `
            -StandardErrorPath $StderrPath -MaximumOutputBytes 33554432 -ActivityCallback $ProgressAction
    } $arguments $smokeRepository $environment $stdoutPath $stderrPath $inputText $smokeProgressAction
    $receipt.status = 'process_completed'
    $receipt.process = [ordered]@{
        exitCode = $result.exitCode
        timedOut = $result.timedOut
        outputLimitExceeded = $result.outputLimitExceeded
        startedAt = $result.startedAt
        endedAt = $result.endedAt
        durationMs = $result.durationMs
        stdoutBytes = $result.stdoutBytes
        stderrBytes = $result.stderrBytes
    }
    Write-OllamaSmokeReceipt $receipt

    if ($result.exitCode -ne 0) {
        throw "Claude-harness/Ollama smoke failed with exit code $($result.exitCode): $($result.stderr.Trim())"
    }
    $smokeFile = Join-Path $smokeRepository 'hdo-ollama-smoke.txt'
    if (-not (Test-Path -LiteralPath $smokeFile -PathType Leaf)) {
        throw 'Claude-harness/Ollama smoke did not create the requested file.'
    }
    $actualBytes = [IO.File]::ReadAllBytes($smokeFile)
    $expectedBytes = [Text.Encoding]::ASCII.GetBytes("HDO_OLLAMA_SMOKE_OK`n")
    if (-not [Linq.Enumerable]::SequenceEqual[byte]($actualBytes, $expectedBytes)) {
        throw "Claude-harness/Ollama smoke created unexpected bytes: $([Convert]::ToHexString($actualBytes))"
    }
    $receipt.checks.exactBytes = $true
    $receipt.checks.fileSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($actualBytes)).ToLowerInvariant()
    $envelope = Get-Content -LiteralPath $stdoutPath -Raw
    $finalJson = & $module { param($Output) ConvertFrom-HdoClaudeOutput $Output } $envelope
    $schemaValidation = & $module { param($Json, $Schema) Test-HdoJsonSchema $Json $Schema } $finalJson $schemaPath
    if (-not $schemaValidation.valid) {
        throw "Claude-harness/Ollama smoke returned invalid structured output: $($schemaValidation.error)"
    }
    $workerResult = $finalJson | ConvertFrom-Json -AsHashtable -Depth 100
    if ($workerResult.changedFiles -notcontains 'hdo-ollama-smoke.txt' -or $workerResult.blockers.Count -ne 0) {
        throw "Claude-harness/Ollama smoke returned an unexpected worker result: $finalJson"
    }
    $receipt.checks.schema = $true

    $runningModels = (& ollama ps 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $runningModels -notmatch "(?m)^$([regex]::Escape($Model))\s") {
        throw "The request completed but Ollama did not report the selected model as loaded: $runningModels"
    }
    $receipt.checks.modelLoaded = $true
    $receipt.status = 'succeeded'
    Write-OllamaSmokeReceipt $receipt

    Write-Host "PASS: parent plan/review stayed on Codex cloud; Claude CLI used Ollama model $Model locally, edited a file, verified exact bytes, and returned a valid worker result."
}
catch {
    $receipt.status = 'failed'
    $receipt.error = & $module { param($Message) Protect-HdoText $Message } $_.Exception.Message
    throw
}
finally {
    $endedAt = [DateTimeOffset]::UtcNow
    $receipt.endedAt = $endedAt.ToString('o')
    $receipt.durationMs = [int]($endedAt - $startedAt).TotalMilliseconds
    Write-OllamaSmokeReceipt $receipt
    $resolvedSmokeRoot = [IO.Path]::GetFullPath($smokeRoot)
    if (-not $resolvedSmokeRoot.StartsWith($smokeBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a smoke directory outside '$smokeBase': $resolvedSmokeRoot"
    }
    if (-not $KeepArtifacts -and (Test-Path -LiteralPath $resolvedSmokeRoot)) {
        Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
    }
}
