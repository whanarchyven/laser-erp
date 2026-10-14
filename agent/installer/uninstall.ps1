$ErrorActionPreference = "Stop"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell -Verb RunAs -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"") -Wait
  exit
}

Unregister-ScheduledTask -TaskName "LaserAgent" -Confirm:$false -ErrorAction SilentlyContinue
Get-Process -Name "LaserAgent" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Remove-Item (Join-Path $env:ProgramFiles "LaserAgent") -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Агент удалён. Папка заданий C:\Jobs оставлена." -ForegroundColor Green
