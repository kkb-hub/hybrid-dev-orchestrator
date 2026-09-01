[CmdletBinding()]
param(
    [switch]$Child,
    [string]$PidPath
)

$ErrorActionPreference = 'Stop'

if ($Child) {
    [Console]::Out.WriteLine('child-started')
    [Console]::Out.Flush()
    Start-Sleep -Seconds 30
    exit 0
}

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Get-Command pwsh -ErrorAction Stop).Source
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
[void]$startInfo.ArgumentList.Add('-NoProfile')
[void]$startInfo.ArgumentList.Add('-File')
[void]$startInfo.ArgumentList.Add($PSCommandPath)
[void]$startInfo.ArgumentList.Add('-Child')
$childProcess = [Diagnostics.Process]::Start($startInfo)
if ($PidPath) { [IO.File]::WriteAllText($PidPath, [string]$childProcess.Id) }
[Console]::Out.WriteLine('parent-exiting')
[Console]::Out.Flush()
