param([string]$Address, [int]$HttpsPort = 8443, [int]$SetupPort = 8444, [switch]$Build, [switch]$RenewCertificate)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$tool = Join-Path $PSScriptRoot 'tools\phone_test.py'
if (!(Test-Path $python)) { throw 'Create .venv and install backend/requirements.txt and tools/phone-requirements.txt first.' }
if (!$Address) {
  $physical = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty InterfaceIndex)
  $candidates = @(Get-NetIPConfiguration | Where-Object { $_.InterfaceIndex -in $physical -and $_.IPv4DefaultGateway } | ForEach-Object { $_.IPv4Address.IPAddress })
  if ($candidates.Count -ne 1) { throw 'Specify -Address with the IPv4 address of your Wi-Fi/Ethernet adapter.' }
  $Address = $candidates[0]
}
if (!(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $Address -ErrorAction SilentlyContinue)) { throw 'The specified IP is not assigned to this PC.' }
if (Get-NetTCPConnection -LocalPort $HttpsPort,$SetupPort -State Listen -ErrorAction SilentlyContinue) { throw 'A phone-test port is already in use. Stop the previous phone test first.' }
if ($Build -or !(Test-Path 'frontend/dist/phone-check.html')) {
  Push-Location frontend
  try { npm.cmd run build; if ($LASTEXITCODE) { throw 'Frontend build failed.' } } finally { Pop-Location }
}
$prepareArgs = @($tool, 'prepare', '--ip', $Address, '--https-port', "$HttpsPort", '--setup-port', "$SetupPort")
if ($RenewCertificate) { $prepareArgs += '--renew' }
& $python @prepareArgs
if ($LASTEXITCODE) { throw 'Certificate preparation failed. See the error above.' }
# Only this Windows user and SYSTEM may read the local server key.
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe (Join-Path $PSScriptRoot '.phone-test') /inheritance:r /grant:r "${account}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) { throw 'Could not protect the certificate directory.' }
New-Item -ItemType Directory -Force logs | Out-Null
$server = Start-Process -FilePath $python -ArgumentList @('"'+$tool+'"','serve','--ip',$Address,'--https-port',"$HttpsPort",'--setup-port',"$SetupPort") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'logs/phone-server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'logs/phone-server-error.log') -PassThru
$server.Id | Set-Content logs/phone-server.pid
$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  & $python $tool check --ip $Address --https-port $HttpsPort 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Milliseconds 300
}
if (!$ready) {
  # Windows venv launchers may spawn a child Python process. Only stop processes
  # positively identified as this helper, including either listener owner.
  $listenerIds = @(Get-NetTCPConnection -LocalPort $HttpsPort,$SetupPort -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
  foreach ($processId in (@($server.Id) + $listenerIds | Select-Object -Unique)) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if ($candidate.CommandLine -and $candidate.CommandLine.Contains($tool) -and $candidate.CommandLine -match '\bserve\b') { Stop-Process -Id $processId -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath (Join-Path $PSScriptRoot 'logs/phone-server.pid') -ErrorAction SilentlyContinue
  throw 'Phone server did not start; its processes were stopped. Check logs/phone-server-error.log.'
}
Write-Host "Phone setup: http://${Address}:$SetupPort"
Write-Host "Application: https://${Address}:$HttpsPort"
Write-Host 'A trusted CA certificate on the phone and a scoped Windows firewall rule are required. See docs/PHONE-TEST.md.'
