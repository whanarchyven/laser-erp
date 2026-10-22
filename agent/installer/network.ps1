# Shared network helpers for install.ps1 and set-ip.ps1.

function Test-Ipv4([string]$text) {
  $parsed = $null
  return [Net.IPAddress]::TryParse($text, [ref]$parsed) -and $parsed.AddressFamily -eq "InterNetwork" -and $text.Split(".").Count -eq 4
}

function ConvertTo-UInt32([string]$ip) {
  $bytes = [Net.IPAddress]::Parse($ip).GetAddressBytes()
  [Array]::Reverse($bytes)
  return [BitConverter]::ToUInt32($bytes, 0)
}

function Test-SameSubnet([string]$a, [string]$b, [int]$prefix) {
  if ($prefix -le 0) { return $false }
  $mask = [uint32]([math]::Pow(2, 32) - [math]::Pow(2, 32 - $prefix))
  return ((ConvertTo-UInt32 $a) -band $mask) -eq ((ConvertTo-UInt32 $b) -band $mask)
}

function Get-WiredAdapters {
  return @(Get-NetAdapter -Physical | Where-Object { $_.MediaType -eq "802.3" -or $_.PhysicalMediaType -match "802.3" } | Sort-Object Status, Name)
}

# Address of this computer in the server's subnet, if Windows already has one (DHCP or static).
function Find-AddressNear([string]$serverIp) {
  foreach ($address in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
    if ($address.IPAddress -like "169.254.*" -or $address.IPAddress -eq "127.0.0.1") { continue }
    if (Test-SameSubnet $address.IPAddress $serverIp $address.PrefixLength) { return $address }
  }
  return $null
}

function Select-WiredAdapter {
  $adapters = Get-WiredAdapters
  if ($adapters.Count -eq 0) { throw "Не найден проводной сетевой адаптер" }
  for ($i = 0; $i -lt $adapters.Count; $i++) {
    $a = $adapters[$i]
    $current = (Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object IPAddress) -join ", "
    $gateway = (Get-NetIPConfiguration -InterfaceIndex $a.ifIndex).IPv4DefaultGateway.NextHop
    Write-Host ("[{0}] {1} ({2}) состояние={3} адрес={4}{5}" -f ($i + 1), $a.Name, $a.InterfaceDescription, $a.Status, $current, $(if ($gateway) { " шлюз=$gateway" } else { "" }))
  }
  $defaultChoice = 1 + [Array]::IndexOf($adapters, ($adapters | Where-Object Status -eq "Up" | Select-Object -First 1))
  if ($defaultChoice -lt 1) { $defaultChoice = 1 }
  $answer = Read-Host "Номер адаптера, куда воткнут кабель к серверу [$defaultChoice]"
  $choice = if ($answer) { [int]$answer } else { $defaultChoice }
  $adapter = $adapters[$choice - 1]
  $gateway = (Get-NetIPConfiguration -InterfaceIndex $adapter.ifIndex).IPv4DefaultGateway.NextHop
  if ($gateway) {
    Write-Host "Внимание: этот адаптер сейчас подключён к сети со шлюзом $gateway (цех/интернет)." -ForegroundColor Yellow
    Write-Host "Если сменить ему адрес, эта связь пропадёт до возврата настроек." -ForegroundColor Yellow
    if ((Read-Host "Продолжить? (да/нет)") -notmatch "^(д|y)") { throw "Отменено: адаптер не изменён" }
  }
  return $adapter
}

# First address in the server's /24 nobody answers on, starting from .2 (the server is usually .1).
function Find-FreeAddress([string]$serverIp) {
  $base = ($serverIp.Split(".")[0..2]) -join "."
  foreach ($last in 2..60) {
    $candidate = "$base.$last"
    if ($candidate -eq $serverIp) { continue }
    if (-not (Test-Connection -ComputerName $candidate -Count 1 -Quiet -ErrorAction SilentlyContinue)) { return $candidate }
  }
  return "$base.2"
}

function Set-StaticAddress($adapter, [string]$ip, [int]$prefix) {
  Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -Dhcp Disabled
  Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
  Get-NetRoute -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false
  New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $ip -PrefixLength $prefix | Out-Null
  Start-Sleep -Seconds 3
  Get-NetConnectionProfile -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue
  Write-Host ("Адаптер {0} = {1}/{2}" -f $adapter.Name, $ip, $prefix) -ForegroundColor Green
  Write-Host ("Вернуть автоматический адрес: Set-NetIPInterface -InterfaceAlias '{0}' -Dhcp Enabled" -f $adapter.Name)
}
