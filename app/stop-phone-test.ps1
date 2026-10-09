param([int]$HttpsPort = 8443)
$ErrorActionPreference = 'Stop'
$connection = Get-NetTCPConnection -LocalPort $HttpsPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$connection) { Write-Host 'Phone test is already stopped.'; exit 0 }
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
$tool = Join-Path $PSScriptRoot 'tools\phone_test.py'
if (!$process.CommandLine -or !$process.CommandLine.Contains($tool) -or $process.CommandLine -notmatch '\bserve\b') { throw 'The process does not belong to this phone test; refusing to stop it.' }
Stop-Process -Id $process.ProcessId
Write-Host 'Phone HTTPS and setup server stopped. Local application data is preserved.'
