# PowerShell Script: Them hoac go bo Auto-start cung Windows
param (
    [switch]$Uninstall
)

$startupFolder = [System.Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder "MSRewardsAutoStart.lnk"
$batPath = Join-Path $PSScriptRoot "start-ms-rewards.bat"

if ($Uninstall) {
    if (Test-Path $shortcutPath) {
        Remove-Item $shortcutPath -Force
        Write-Host "[OK] Da go bo Microsoft Rewards khoi thu muc Startup cua Windows." -ForegroundColor Yellow
    } else {
        Write-Host "[INFO] Chua co shortcut trong thu muc Startup." -ForegroundColor Gray
    }
    return
}

# Tao shortcut
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $batPath
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = "Tu dong chay Microsoft Rewards khi bat may"
$shortcut.Save()

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  DA CAI DAT TU DONG KHOI CHAY CUNG WINDOWS THANH CONG!" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "Moi khi ban bat may tinh, Windows se tu dong mo Edge"
Write-Host "den trang Microsoft Rewards de Extension tu dong thuc hien."
Write-Host "Shortcut da luu tai: $shortcutPath" -ForegroundColor DarkGray
Write-Host ""
Write-Host "De go bo bat ky luc nao, chay: powershell -File setup-startup.ps1 -Uninstall" -ForegroundColor Yellow
