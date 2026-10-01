<# : Batch-Teil (PowerShell ignoriert diesen Kommentar)
@echo off
set "APPDIR=%~dp0"
set "SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:SELF))"
pause
exit /b
#>

$ErrorActionPreference = 'Stop'
try {
  $dir  = $env:APPDIR
  $app  = Join-Path $dir 'PDF-Editor.html'
  $ico  = Join-Path $dir 'PDF-Editor.ico'
  if (-not (Test-Path -LiteralPath $app)) { Write-Host 'PDF-Editor.html wurde in diesem Ordner nicht gefunden.'; exit 1 }
  $cands = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
  $browser = $cands | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  $desk = [Environment]::GetFolderPath('Desktop')
  $lnk  = Join-Path $desk 'PDF-Editor.lnk'
  $sh = New-Object -ComObject WScript.Shell
  $s  = $sh.CreateShortcut($lnk)
  if ($browser) {
    $s.TargetPath = $browser
    $s.Arguments  = '--app="' + ([System.Uri]$app).AbsoluteUri + '"'
  } else {
    $s.TargetPath = $app
  }
  $s.WorkingDirectory = $dir
  if (Test-Path -LiteralPath $ico) { $s.IconLocation = "$ico,0" }
  $s.Description = 'PDF-Editor'
  $s.Save()
  Write-Host ''
  Write-Host '  Fertig: Auf dem Desktop liegt jetzt die Verknuepfung "PDF-Editor".'
  if ($browser) { Write-Host '  Sie startet PDF-Editor in einem eigenen Fenster (ohne Browser-Leisten).' }
  Write-Host '  Wichtig: Den Ordner nicht verschieben - sonst dieses Skript erneut ausfuehren.'
  Write-Host ''
} catch {
  Write-Host ('Fehler: ' + $_.Exception.Message)
  exit 1
}
