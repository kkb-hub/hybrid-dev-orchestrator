[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cliPath = Join-Path $repositoryRoot 'hdo.ps1'
$temporaryRoot = Join-Path $repositoryRoot "test-results/cli-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null

function Invoke-HdoCliTest {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $null = & pwsh -NoProfile -File $cliPath @Arguments 2>&1
    return $LASTEXITCODE
}

try {
    $missingRunnerConfig = Join-Path $temporaryRoot 'missing-runner.json'
    [ordered]@{
        runners = [ordered]@{
            'claude-planner' = [ordered]@{ command = 'hdo-command-that-does-not-exist' }
        }
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $missingRunnerConfig -Encoding utf8NoBOM

    $firstConfig = Join-Path $temporaryRoot 'first.json'
    $secondConfig = Join-Path $temporaryRoot 'second.json'
    [ordered]@{ activeProfile = 'not-defined' } |
        ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $firstConfig -Encoding utf8NoBOM
    [ordered]@{ activeProfile = 'claude-only' } |
        ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $secondConfig -Encoding utf8NoBOM

    $cases = @(
        [ordered]@{ name = 'help'; arguments = @('help'); expected = 0 },
        [ordered]@{ name = 'config'; arguments = @('config', '-Json'); expected = 0 },
        [ordered]@{ name = 'config explicit ordered list'; arguments = @('config', '-Config', "$firstConfig,$secondConfig", '-Json'); expected = 0 },
        [ordered]@{ name = 'config ignore repository default'; arguments = @('config', '-IgnoreRepositoryConfig', '-Json'); expected = 0 },
        [ordered]@{ name = 'conflicting run selection'; arguments = @('run', '-Issue', '1', '-Pick'); expected = 2 },
        [ordered]@{ name = 'doctor preflight failure'; arguments = @('doctor', '-Config', $missingRunnerConfig, '-DryRun', '-Json'); expected = 3 }
    )
    foreach ($case in $cases) {
        $actual = Invoke-HdoCliTest @($case.arguments)
        if ($actual -ne $case.expected) { throw "CLI $($case.name) returned $actual; expected $($case.expected)." }
    }
    Write-Host "PASS: CLI success, argument-error, and preflight exit codes are stable ($($cases.Count) case(s))."
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
