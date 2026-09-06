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

    2 つ目の scenario は context compaction（issue #47）を実 model で踏ませる。停止
    条件が model の振る舞いに依存するため、agent step ではなく worker を直接起動し、
    圧縮が必ず起きる狭い window を渡す。

.EXAMPLE
    pwsh -NoProfile -File tests/test-lean-worker-smoke.ps1 -Run
#>
[CmdletBinding()]
param(
    [switch]$Run,
    [string]$Model = 'qwen3.8:27b-q4_K_M',
    [int]$ContextTokens = 32768,
    # Deliberately far below anything an operator would configure. The point is to reach the
    # compaction threshold with a task small enough to stay a smoke test: at a realistic
    # window the same task finishes in four turns without ever compacting.
    [int]$CompactionContextTokens = 4096,
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

    # --- context compaction against the real model -------------------------------------
    # Three files rather than one, so the tool loop cannot finish inside a single exchange,
    # and a window small enough that the threshold is crossed while the work is unfinished.
    # The worker is started directly here: the agent step takes its window from the profile,
    # and the whole point of this scenario is a window no profile would ever declare.
    $compactionWorkspace = Join-Path $smokeRoot 'compaction'
    New-Item -ItemType Directory -Path $compactionWorkspace -Force | Out-Null
    foreach ($module in 'a', 'b', 'c') {
        $upper = $module.ToUpper()
        $lines = [Collections.Generic.List[string]]::new()
        $lines.Add("# Module $upper - numeric helpers for the reporting pipeline.")
        $lines.Add('')
        # Padding, so reading a whole file costs real context and the model is pushed toward
        # the narrow reads the system prompt asks for.
        1..25 | ForEach-Object { $lines.Add("function Get-${upper}Constant${_} { return $($_ * 7) }") }
        $lines.Add('')
        $lines.Add("function Get-${upper}Total {")
        $lines.Add('    param([int[]]$Values)')
        $lines.Add('    $total = 0')
        $lines.Add('    for ($i = 0; $i -lt $Values.Count - 1; $i++) { $total += $Values[$i] }')
        $lines.Add('    return $total')
        $lines.Add('}')
        $lines.Add('')
        1..25 | ForEach-Object { $lines.Add("function Get-${upper}Label${_} { return '$module-label-$_' }") }
        Set-Content -LiteralPath (Join-Path $compactionWorkspace "module-$module.ps1") -Value $lines -Encoding utf8NoBOM
    }

    $compactionPrompt = Join-Path $smokeRoot 'compaction-prompt.md'
    $compactionOutput = Join-Path $smokeRoot 'compaction-result.json'
    Set-Content -LiteralPath $compactionPrompt -Encoding utf8NoBOM -Value @'
Three files in this workspace each define a Get-*Total function whose for-loop bound is
off by one: it uses "$i -lt $Values.Count - 1", so the last element is never added.

Fix all three files: module-a.ps1, module-b.ps1, module-c.ps1. In each one, change the
loop bound to "$i -lt $Values.Count". Change nothing else.
'@

    $compactionStdout = & pwsh -NoProfile -File (Join-Path $repositoryRoot 'workers/hdo-ollama-worker.ps1') `
        -PromptFile $compactionPrompt -OutputFile $compactionOutput `
        -SchemaFile (Join-Path $repositoryRoot 'schemas/worker-result.schema.json') `
        -WorkingDirectory $compactionWorkspace -Model $Model `
        -ContextTokens $CompactionContextTokens -CompactAtPercent 35 -KeepRecentMessages 4 `
        -MaxTurns 20 2>&1 | Out-String
    $compactionExitCode = $LASTEXITCODE
    Write-Host $compactionStdout

    $thresholdMatch = [regex]::Match($compactionStdout, 'compaction: turn=(\d+) reason=threshold prompt_tokens_before~\d+ prompt_tokens_after~\d+ messages=\d+->\d+')
    $finalMatch = [regex]::Match($compactionStdout, 'final: .*turns=(\d+) .*compactions=(\d+)')

    Assert-Smoke ($compactionExitCode -eq 0) 'the worker completes a multi-file task inside a window too small to hold its history'
    Assert-Smoke ($thresholdMatch.Success) 'the reported prompt token count triggers a compaction, with the turn and both token counts in the diagnostic'
    Assert-Smoke ($finalMatch.Success -and $thresholdMatch.Success -and [int]$finalMatch.Groups[1].Value -gt [int]$thresholdMatch.Groups[1].Value) 'the tool loop keeps making progress after its history was rewritten'
    Assert-Smoke ($finalMatch.Success -and [int]$finalMatch.Groups[2].Value -ge 1) 'the final line reports how many compactions the run needed'

    $stillBroken = @(Select-String -Path (Join-Path $compactionWorkspace 'module-*.ps1') -Pattern '\$Values\.Count - 1')
    Assert-Smoke ($stillBroken.Count -eq 0) 'every file is fixed even though the history was compacted mid-task'
    $compactionResult = Get-Content -LiteralPath $compactionOutput -Raw | ConvertFrom-Json
    Assert-Smoke ([int]$compactionResult.schemaVersion -eq 1) 'the final report is still schema-shaped after the history was reduced'
    Assert-Smoke ([string]$compactionResult.summary -ne '') 'the final report carries a summary written from the compacted state'
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
