# ============================================================================
# 网文小说生成器 · 作者 Jace
# 防止 Windows 在自动写作期间休眠
# 用法（建议管理员 PowerShell）：
#   powershell -File scripts/keep-awake-win.ps1        # 开启
#   powershell -File scripts/keep-awake-win.ps1 -Off   # 恢复默认
# © Jace · MIT License
# ============================================================================

param(
  [switch]$Off
)

function Require-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "请用「以管理员身份运行」的 PowerShell 再执行本脚本。" -ForegroundColor Yellow
    exit 1
  }
}

Require-Admin

if ($Off) {
  powercfg /change standby-timeout-ac 30
  powercfg /change hibernate-timeout-ac 60
  powercfg /change standby-timeout-dc 15
  powercfg /change hibernate-timeout-dc 30
  Write-Host "已恢复较常见的默认超时（插电睡眠30分/休眠60分；电池更短）。可按需在系统设置里再调。"
  exit 0
}

# 插电：不睡眠、不休眠；电池保持较短以免耗尽
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change standby-timeout-dc 20
powercfg /change hibernate-timeout-dc 40
Write-Host "已设置：插电时不自动睡眠/休眠。自动写作期间请接电源。"
Write-Host "恢复：powershell -File scripts/keep-awake-win.ps1 -Off"
