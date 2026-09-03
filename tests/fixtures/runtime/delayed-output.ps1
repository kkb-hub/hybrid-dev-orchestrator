[CmdletBinding()]
param(
    [ValidateRange(1, 10000)][int]$DelayMilliseconds = 1500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Start-Sleep -Milliseconds $DelayMilliseconds
[Console]::Out.Write('{"status":"ok"}')
