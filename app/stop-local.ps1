param([int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$connection) { Write-Host 'Приложение уже остановлено.'; exit 0 }
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
if (!$serverProcess.CommandLine.Contains((Join-Path $PSScriptRoot 'backend')) -or $serverProcess.CommandLine -notmatch 'uvicorn app.main:app') { throw 'Процесс на этом порту не принадлежит данному проекту. Остановка отменена.' }
Stop-Process -Id $serverProcess.ProcessId
Write-Host 'Дороги области остановлены. Данные сохранены.'
