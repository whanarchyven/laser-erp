param(
  [string]$Ip,
  [int]$Prefix = 24
)

$ErrorActionPreference = "Stop"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  $forward = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"")
  if ($Ip) { $forward += @("-Ip", $Ip) }
  Start-Process powershell -Verb RunAs -ArgumentList $forward -Wait
  exit
}

Write-Host ""
Write-Host "Адрес для прямого кабеля" -ForegroundColor Cyan
Write-Host "Подключите кабель к обоим компьютерам до запуска."
Write-Host ""

$adapters = @(Get-NetAdapter -Physical | Where-Object { $_.MediaType -eq "802.3" -or $_.PhysicalMediaType -match "802.3" } | Sort-Object Status, Name)
if ($adapters.Count -eq 0) { throw "Не найден проводной сетевой адаптер" }
for ($i = 0; $i -lt $adapters.Count; $i++) {
  $a = $adapters[$i]
  $current = (Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object IPAddress) -join ", "
  $gateway = (Get-NetIPConfiguration -InterfaceIndex $a.ifIndex).IPv4DefaultGateway.NextHop
  Write-Host ("[{0}] {1} ({2}) состояние={3} адрес={4}{5}" -f ($i + 1), $a.Name, $a.InterfaceDescription, $a.Status, $current, $(if ($gateway) { " шлюз=$gateway" } else { "" }))
}
$defaultChoice = 1 + [Array]::IndexOf($adapters, ($adapters | Where-Object Status -eq "Up" | Select-Object -First 1))
if ($defaultChoice -lt 1) { $defaultChoice = 1 }
$answer = Read-Host "Номер адаптера, куда воткнут кабель [$defaultChoice]"
$choice = if ($answer) { [int]$answer } else { $defaultChoice }
$adapter = $adapters[$choice - 1]

$gateway = (Get-NetIPConfiguration -InterfaceIndex $adapter.ifIndex).IPv4DefaultGateway.NextHop
if ($gateway) {
  Write-Host "Внимание: этот адаптер сейчас подключён к сети со шлюзом $gateway (цех/интернет)." -ForegroundColor Yellow
  Write-Host "Если сменить ему адрес, эта связь пропадёт до возврата настроек." -ForegroundColor Yellow
  if ((Read-Host "Продолжить? (да/нет)") -notmatch "^(д|y)") { exit }
}

if (-not $Ip) { $Ip = Read-Host "Адрес этого компьютера (ноутбук 192.168.50.1, станки 192.168.50.2, .3 ...)" }
if (-not $Ip) { throw "Адрес не задан" }

Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -Dhcp Disabled
Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
Get-NetRoute -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false
New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $Ip -PrefixLength $Prefix | Out-Null
Start-Sleep -Seconds 3
Get-NetConnectionProfile -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Готово: адаптер «$($adapter.Name)» = $Ip/$Prefix" -ForegroundColor Green
Write-Host "Вернуть автоматический адрес: Set-NetIPInterface -InterfaceAlias '$($adapter.Name)' -Dhcp Enabled"
