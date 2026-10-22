@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Filter *.ps1 | ForEach-Object { $b=[IO.File]::ReadAllBytes($_.FullName); if($b.Length -lt 3 -or $b[0] -ne 239 -or $b[1] -ne 187 -or $b[2] -ne 191){ $t=[IO.File]::ReadAllText($_.FullName,(New-Object Text.UTF8Encoding $false)); [IO.File]::WriteAllText($_.FullName,$t,(New-Object Text.UTF8Encoding $true)) } }"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-ip.ps1"
pause
