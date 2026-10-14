$ErrorActionPreference = "Stop"
$agent = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $agent "usb\LaserAgent"
$dotnet = Join-Path $agent ".tools\dotnet\dotnet.exe"
if (-not (Test-Path $dotnet)) { $dotnet = "dotnet" }

& $dotnet publish (Join-Path $agent "LaserAgent.csproj") -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o (Join-Path $agent "publish-one")
if ($LASTEXITCODE -ne 0) { throw "Сборка не удалась" }

Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item (Join-Path $agent "publish-one\LaserAgent.exe") $out

$bom = New-Object Text.UTF8Encoding($true)
foreach ($name in @("install.ps1", "uninstall.ps1", "set-ip.ps1")) {
  $text = [IO.File]::ReadAllText((Join-Path $agent "installer\$name"))
  [IO.File]::WriteAllText((Join-Path $out $name), $text, $bom)
}
foreach ($name in @("laser-agent.json", "Установить.cmd", "Удалить.cmd", "Настроить-сеть.cmd")) {
  Copy-Item (Join-Path $agent "installer\$name") $out
}
$guide = [IO.File]::ReadAllText((Join-Path $agent "installer\ИНСТРУКЦИЯ.txt"))
[IO.File]::WriteAllText((Join-Path $out "ИНСТРУКЦИЯ.txt"), $guide, $bom)

Write-Host "Готово: $out"
Get-ChildItem $out | Format-Table Name, Length
