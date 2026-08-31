[CmdletBinding()]
param(
    [ValidateSet('stdout', 'stderr')]
    [string]$Stream = 'stdout',
    [ValidateRange(1, 1048576)]
    [int]$ChunkBytes = 4096
)

$chunk = 'x' * $ChunkBytes
$writer = if ($Stream -eq 'stderr') { [Console]::Error } else { [Console]::Out }
while ($true) {
    $writer.Write($chunk)
    $writer.Flush()
}
