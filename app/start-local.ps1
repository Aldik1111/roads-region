param([int]$Port = 8000, [switch]$Build)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (!(Test-Path $python)) { throw 'Сначала создайте .venv и установите backend/requirements.txt (см. README.md).' }
if ($Build -or !(Test-Path 'frontend/dist/index.html')) {
  Push-Location frontend
  try { npm.cmd run build; if ($LASTEXITCODE) { throw 'Ошибка сборки интерфейса' } } finally { Pop-Location }
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
  if ($health.ok -and $health.demo) { Write-Host "Приложение уже работает: http://localhost:$Port"; exit 0 }
  throw "Порт $Port занят другим приложением."
}
New-Item -ItemType Directory -Force logs | Out-Null
$appDir = '"' + (Join-Path $PSScriptRoot 'backend') + '"'
$server = Start-Process -FilePath $python -ArgumentList @('-m','uvicorn','app.main:app','--app-dir',$appDir,'--host','127.0.0.1','--port',"$Port") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'logs/server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'logs/server-error.log') -PassThru
$server.Id | Set-Content logs/server.pid
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try { $status = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 1; if ($status.ok) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 200 }
}
if (!$ready) { throw 'Сервер не запустился. Подробности: logs/server-error.log' }
Write-Host "Дороги области: http://localhost:$Port (PID $($server.Id)). Логи: logs/."
