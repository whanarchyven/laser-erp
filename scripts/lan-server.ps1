$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not (Get-NetFirewallRule -DisplayName "Laser stand demo" -ErrorAction SilentlyContinue)) {
  Write-Host "Открываю порты 3210, 3211, 5173 в брандмауэре (нужны права администратора)..."
  Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
    "-NoProfile", "-Command",
    "New-NetFirewallRule -DisplayName 'Laser stand demo' -Direction Inbound -Protocol TCP -LocalPort 3210,3211,5173 -Action Allow -Profile Any | Out-Null"
  )
}

$busy = Get-NetTCPConnection -State Listen -LocalPort 3211 -ErrorAction SilentlyContinue
if ($busy) {
  Write-Host "Convex уже запущен (порт 3211 занят)."
} else {
  Start-Process powershell -WorkingDirectory $root -ArgumentList @(
    "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle = 'Convex'; `$env:CONVEX_AGENT_MODE = 'anonymous'; npx convex dev --tail-logs always"
  )
}
if (Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue) {
  Write-Host "Веб уже запущен (порт 5173 занят)."
} else {
  Start-Process powershell -WorkingDirectory $root -ArgumentList @(
    "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle = 'Web'; npm run dev"
  )
}

Write-Host "Жду запуска..."
for ($i = 0; $i -lt 60; $i++) {
  $ok = (Get-NetTCPConnection -State Listen -LocalPort 3211 -ErrorAction SilentlyContinue) -and (Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue)
  if ($ok) { break }
  Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "Адреса этого компьютера:" -ForegroundColor Cyan
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254\.)" } | ForEach-Object {
  Write-Host ("  {0,-16} {1}" -f $_.IPAddress, $_.InterfaceAlias)
  Write-Host ("     веб:            http://{0}:5173" -f $_.IPAddress)
  Write-Host ("     BaseUrl агента: http://{0}:3211" -f $_.IPAddress)
}
Write-Host ""
Write-Host "Окна Convex и Web не закрывайте, пока работаете со станком."
