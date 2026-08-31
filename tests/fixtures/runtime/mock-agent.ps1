param(
    [Parameter(Mandatory)][string]$SchemaFile,
    [Parameter(Mandatory)][string]$OutputFile,
    [switch]$InvalidOutput
)

$null = [Console]::In.ReadToEnd()
if ($InvalidOutput) {
    '{}' | Set-Content -LiteralPath $OutputFile -Encoding utf8NoBOM
    '{}'
    exit 0
}

$schemaName = [IO.Path]::GetFileName($SchemaFile)
$result = switch ($schemaName) {
    'task-contract.schema.json' {
        [ordered]@{
            schemaVersion = 1
            objective = 'Exercise the command runner.'
            approach = @('Return deterministic structured output.')
            acceptanceCriteria = @('AC-1: output is valid')
            expectedFiles = @()
            risks = @()
            assumptions = @()
        }
    }
    'worker-result.schema.json' {
        [ordered]@{
            schemaVersion = 1
            summary = 'Mock implementation completed.'
            changedFiles = @('mock.txt')
            tests = @('mock')
            notes = @()
            blockers = @()
        }
    }
    'review-result.schema.json' {
        [ordered]@{
            schemaVersion = 1
            reviewRound = 1
            decision = 'approve'
            summary = 'Mock review approved.'
            missingViewpoints = @()
            findings = @()
        }
    }
    default { throw "Unsupported schema: $schemaName" }
}

$result | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $OutputFile -Encoding utf8NoBOM
$result | ConvertTo-Json -Compress -Depth 30
