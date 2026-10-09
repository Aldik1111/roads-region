# Run elevated only for the add/remove operation. Does not change network profiles.
param([string]$Address, [int]$HttpsPort = 8443, [int]$SetupPort = 8444, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'RoadsRegionPhoneTest'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from PowerShell as Administrator to change the Windows firewall rule.' }
$existing = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
if ($existing -and $existing.Group -ne 'Roads Region phone test') { throw 'A firewall rule with this name belongs to another configuration.' }
if ($Remove) {
  if ($existing) { $existing | Remove-NetFirewallRule }
  Write-Host 'Phone-test firewall rule removed.'
  exit 0
}
if ($HttpsPort -eq $SetupPort -or $HttpsPort -lt 1024 -or $SetupPort -lt 1024 -or $HttpsPort -gt 65535 -or $SetupPort -gt 65535) { throw 'Specify two distinct ports in 1024..65535.' }
$ip = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $Address -ErrorAction Stop | Select-Object -First 1
$physical = Get-NetAdapter -Physical | Where-Object { $_.InterfaceIndex -eq $ip.InterfaceIndex -and $_.Status -eq 'Up' }
if (!$physical) { throw 'Use the active physical Wi-Fi/Ethernet address, not a VPN/virtual adapter.' }
if ($existing) { $existing | Remove-NetFirewallRule }
New-NetFirewallRule -Name $name -DisplayName 'Roads Region - local phone test' -Group 'Roads Region phone test' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $Address -LocalPort $HttpsPort,$SetupPort -RemoteAddress LocalSubnet -InterfaceAlias $ip.InterfaceAlias -Profile Any | Out-Null
Write-Host "Allowed local-subnet connections to ${Address}:$HttpsPort and $SetupPort on $($ip.InterfaceAlias)."
