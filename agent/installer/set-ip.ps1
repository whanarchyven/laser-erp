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
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "network.ps1")

Write-Host ""
Write-Host "Адрес для прямого кабеля" -ForegroundColor Cyan
Write-Host "Подключите кабель к обоим компьютерам до запуска."
Write-Host ""

$adapter = Select-WiredAdapter
if (-not $Ip) { $Ip = Read-Host "Адрес этого компьютера (сервер 192.168.50.1, станки 192.168.50.2, .3 ...)" }
if (-not (Test-Ipv4 $Ip)) { throw "Неверный адрес: $Ip" }
Set-StaticAddress $adapter $Ip $Prefix
Write-Host "Готово." -ForegroundColor Green
