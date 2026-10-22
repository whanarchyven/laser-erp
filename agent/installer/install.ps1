param(
  [string]$ServerIp,
  [string]$MachineIp,
  [string]$BaseUrl,
  [string]$Token,
  [string]$MachineId,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:ProgramFiles "LaserAgent"
$taskName = "LaserAgent"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  $forward = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"")
  if ($ServerIp) { $forward += @("-ServerIp", $ServerIp) }
  if ($MachineIp) { $forward += @("-MachineIp", $MachineIp) }
  if ($BaseUrl) { $forward += @("-BaseUrl", "`"$BaseUrl`"") }
  if ($Token) { $forward += @("-Token", "`"$Token`"") }
  if ($MachineId) { $forward += @("-MachineId", "`"$MachineId`"") }
  if ($Quiet) { $forward += "-Quiet" }
  Start-Process powershell -Verb RunAs -ArgumentList $forward -Wait
  exit
}
. (Join-Path $here "network.ps1")

function Ask([string]$label, [string]$default) {
  if ($Quiet) { return $default }
  $answer = Read-Host "$label [$default]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim()
}

function Find-CypCut {
  $candidates = @()
  try {
    $progId = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\.lxds" -ErrorAction Stop)."(default)"
    if ($progId) {
      $command = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction Stop)."(default)"
      if ($command -match '^"([^"]+)"') { $candidates += $Matches[1] }
    }
  } catch {}
  $candidates += @(
    "${env:ProgramFiles(x86)}\Friendess\CypCut\CypCut.exe",
    "$env:ProgramFiles\Friendess\CypCut\CypCut.exe",
    "${env:ProgramFiles(x86)}\Friendess\CypCutE\CypCutE.exe",
    "$env:ProgramFiles\Friendess\CypCutE\CypCutE.exe"
  )
  $running = Get-Process | Where-Object { $_.ProcessName -like "CypCut*" -and $_.Path } | Select-Object -First 1
  if ($running) { $candidates = @($running.Path) + $candidates }
  foreach ($path in $candidates) { if ($path -and (Test-Path $path)) { return $path } }
  return ""
}

Write-Host ""
Write-Host "Установка агента станка" -ForegroundColor Cyan
Write-Host ""

$defaults = @{ BaseUrl = ""; Token = ""; MachineId = ""; JobsDir = "C:\Jobs"; FinishPatterns = @("Конец обработки", "Processing End", "Production ends", "加工结束") }
$templatePath = Join-Path $here "laser-agent.json"
if (Test-Path $templatePath) {
  $template = Get-Content $templatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($name in @("BaseUrl", "Token", "MachineId", "JobsDir", "FinishPatterns")) {
    if ($null -ne $template.$name -and "$($template.$name)" -ne "") { $defaults[$name] = $template.$name }
  }
}

$existingPath = Join-Path $installDir "appsettings.json"
if (Test-Path $existingPath) {
  $existing = Get-Content $existingPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($name in @("BaseUrl", "Token", "MachineId", "JobsDir", "FinishPatterns")) {
    if ($null -ne $existing.$name -and "$($existing.$name)" -ne "") { $defaults[$name] = $existing.$name }
  }
}
if (-not $defaults.MachineId) { $defaults.MachineId = $env:COMPUTERNAME }

Write-Host "Шаг 1. Сеть" -ForegroundColor Cyan
$defaultServer = "192.168.50.1"
$knownUrl = if ($BaseUrl) { $BaseUrl } else { $defaults.BaseUrl }
if ($knownUrl) { try { $defaultServer = ([Uri]$knownUrl).Host } catch {} }
if (-not $ServerIp) { $ServerIp = Ask "IP-адрес сервера" $defaultServer }
if (-not (Test-Ipv4 $ServerIp)) { throw "Неверный IP-адрес сервера: $ServerIp" }

$near = Find-AddressNear $ServerIp
if ($near -and -not $MachineIp) {
  Write-Host ("IP-адрес станка уже есть: {0} (адаптер {1})" -f $near.IPAddress, $near.InterfaceAlias) -ForegroundColor Green
  $MachineIp = $near.IPAddress
} else {
  if (-not $near) { Write-Host "У станка нет адреса в сети сервера $ServerIp — зададим его сейчас." -ForegroundColor Yellow }
  $adapter = if ($Quiet) { Get-WiredAdapters | Where-Object Status -eq "Up" | Select-Object -First 1 } else { Select-WiredAdapter }
  if (-not $adapter) { throw "Не найден подключённый проводной адаптер" }
  if (-not $MachineIp) { $MachineIp = Ask "IP-адрес этого станка" (Find-FreeAddress $ServerIp) }
  if (-not (Test-Ipv4 $MachineIp)) { throw "Неверный IP-адрес станка: $MachineIp" }
  if (-not (Test-SameSubnet $MachineIp $ServerIp 24)) { Write-Host "Внимание: $MachineIp и сервер $ServerIp в разных подсетях /24." -ForegroundColor Yellow }
  Set-StaticAddress $adapter $MachineIp 24
}
if (Test-Connection -ComputerName $ServerIp -Count 2 -Quiet -ErrorAction SilentlyContinue) {
  Write-Host "Сервер $ServerIp отвечает на ping" -ForegroundColor Green
} else {
  Write-Host "Сервер $ServerIp не отвечает на ping (проверьте кабель; на сервере ping может быть закрыт брандмауэром)." -ForegroundColor Yellow
}
if (-not $BaseUrl -or ([Uri]$BaseUrl).Host -ne $ServerIp) { $BaseUrl = "http://${ServerIp}:3211" }
Write-Host ""
Write-Host "Шаг 2. Агент" -ForegroundColor Cyan
if (-not $Token) { $Token = Ask "Ключ агента" $defaults.Token }
if (-not $MachineId) { $MachineId = Ask "Имя станка (так он будет виден в вебе)" $defaults.MachineId }
$BaseUrl = $BaseUrl.TrimEnd("/")
if (-not $BaseUrl -or -not $Token -or -not $MachineId) { throw "Адрес сервера, ключ и имя станка обязательны" }

$cypcut = Find-CypCut
if (-not $cypcut) {
  Write-Host "CypCut не найден автоматически." -ForegroundColor Yellow
  $cypcut = Ask "Полный путь к CypCut.exe" "C:\Program Files (x86)\Friendess\CypCut\CypCut.exe"
}
Write-Host "CypCut: $cypcut"

Get-Process -Name "LaserAgent" -ErrorAction SilentlyContinue | Stop-Process -Force
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item (Join-Path $here "LaserAgent.exe") (Join-Path $installDir "LaserAgent.exe") -Force
New-Item -ItemType Directory -Force -Path $defaults.JobsDir | Out-Null
& icacls $defaults.JobsDir /grant "*S-1-5-32-545:(OI)(CI)M" /T /Q | Out-Null

$settings = [ordered]@{
  BaseUrl = $BaseUrl
  ServerIp = $ServerIp
  MachineIp = $MachineIp
  Token = $Token
  JobsDir = $defaults.JobsDir
  PollSeconds = 5
  MachineId = $MachineId
  CypCutPath = $cypcut
  AutoOpen = $true
  WindowDumpSeconds = 30
  ScreenSeconds = 15
  FinishPatterns = @($defaults.FinishPatterns)
}
[IO.File]::WriteAllText($existingPath, ($settings | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding($false)))

Write-Host "Проверяю связь с сервером..."
try {
  $probe = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Headers @{ Authorization = "Bearer $Token" } -Uri "$BaseUrl/agent/programs?machineId=$([Uri]::EscapeDataString($MachineId))"
  Write-Host "Сервер отвечает ($($probe.StatusCode))" -ForegroundColor Green
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 401) { Write-Host "Сервер отклонил ключ агента. Проверьте Token." -ForegroundColor Red }
  else { Write-Host "Сервер недоступен: $($_.Exception.Message). Агент будет пытаться подключиться сам." -ForegroundColor Yellow }
}

$action = New-ScheduledTaskAction -Execute (Join-Path $installDir "LaserAgent.exe") -WorkingDirectory $installDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -GroupId "S-1-5-32-545" -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Description "Агент очереди лазерного станка" | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 5
$running = Get-Process -Name "LaserAgent" -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ne 0 }
if (-not $running) {
  Start-Process -FilePath (Join-Path $installDir "LaserAgent.exe") -WorkingDirectory $installDir -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

Write-Host ""
if (Get-Process -Name "LaserAgent" -ErrorAction SilentlyContinue) {
  Write-Host "Готово. Агент работает в фоне и будет запускаться сам при входе в Windows." -ForegroundColor Green
} else {
  Write-Host "Агент установлен, но не запустился. Журнал: $($defaults.JobsDir)\agent.log" -ForegroundColor Red
}
Write-Host "Станок: $MachineId, IP $MachineIp"
Write-Host "Сервер: $BaseUrl"
Write-Host "Папка заданий и журнал: $($defaults.JobsDir)"
