<#
  float-preview.ps1 -- 只只 M3「手感验证」丑浮窗（一次性探针，非正式外壳）

  目的：用最丑最快的办法，把三个问题问明白 —— 位置舒不舒服 / 会不会挡我 / 按钮够不够。
  它不是 M4 的外壳；M4 会重写，这里只验证「手感」。

  命门扩展样式（缺一不可）：
    WS_EX_NOACTIVATE  点浮窗按钮时不抢走编辑器焦点（否则 Ctrl+V 会失效）
    WS_EX_TOPMOST     永远置顶
    WS_EX_TOOLWINDOW  不进 Alt+Tab、不占任务栏

  ⚠️ 本文件必须存成「UTF-8 带 BOM」。
     PS 5.1 读无 BOM 的 .ps1 会按 GBK 解码 → 中文全乱码。
     若用编辑器改完发现中文变乱码，请重新另存为 UTF-8 with BOM。

  ⚠️ PowerShell 变量名大小写不敏感：$FormW 与 $formw 是同一个变量。
     本脚本刻意用 $FormW / $FormH 而非 $W / $H，避免与句柄等短名相撞。

  用法：
    powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1
    powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -Position TopCenter
    powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -SelfTest   # 只自检，不弹窗
#>

[CmdletBinding()]
param(
  [ValidateSet('BottomRight', 'TopCenter', 'Taskbar')]
  [string]$Position = 'BottomRight',

  [double]$Opacity = 0.94,

  # 留空则自动从 PATH 找 node
  [string]$NodeExe = '',

  # 只搭窗口 + 打印自检，不真的显示（给自动化验证用）
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ─────────────────────────────── Win32 ───────────────────────────────

if (-not ('ZhizhiWin32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZhizhiWin32 {
  [DllImport("user32.dll", SetLastError=true)] public static extern int  GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError=true)] public static extern int  SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern bool ReleaseCapture();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
}

# 让文字在缩放屏上不糊（进程级，必须在建窗之前调）
[void][ZhizhiWin32]::SetProcessDPIAware()

$script:GWL_EXSTYLE      = -20
$script:WS_EX_NOACTIVATE = 0x08000000
$script:WS_EX_TOPMOST    = 0x00000008
$script:WS_EX_TOOLWINDOW = 0x00000080

$script:REPO_ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# ─────────────────────────────── 配色（浅色主题）───────────────────────────────

$cCard   = [System.Drawing.Color]::FromArgb(255, 250, 250, 250)
$cInk    = [System.Drawing.Color]::FromArgb(255,  32,  32,  32)
$cSub    = [System.Drawing.Color]::FromArgb(255, 130, 130, 130)
$cLine   = [System.Drawing.Color]::FromArgb(255, 224, 224, 224)
$cAccent = [System.Drawing.Color]::FromArgb(255,  22, 123, 250)   # 项目主色 #167BFA

# ─────────────────────────────── 小工具 ───────────────────────────────

function New-RoundRegion([int]$rw, [int]$rh, [int]$rr) {
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddArc(0, 0, $rr * 2, $rr * 2, 180, 90)
  $gp.AddArc($rw - $rr * 2, 0, $rr * 2, $rr * 2, 270, 90)
  $gp.AddArc($rw - $rr * 2, $rh - $rr * 2, $rr * 2, $rr * 2, 0, 90)
  $gp.AddArc(0, $rh - $rr * 2, $rr * 2, $rr * 2, 90, 90)
  $gp.CloseFigure()
  return (New-Object System.Drawing.Region($gp))
}

function Apply-ExStyles([IntPtr]$handle) {
  $before = [ZhizhiWin32]::GetWindowLong($handle, $script:GWL_EXSTYLE)
  $want   = $before -bor $script:WS_EX_NOACTIVATE -bor $script:WS_EX_TOPMOST -bor $script:WS_EX_TOOLWINDOW
  [void][ZhizhiWin32]::SetWindowLong($handle, $script:GWL_EXSTYLE, $want)
  $after  = [ZhizhiWin32]::GetWindowLong($handle, $script:GWL_EXSTYLE)
  return [pscustomobject]@{ Before = $before; After = $after }
}

function Get-PresetPoint([string]$which, [System.Drawing.Rectangle]$wa, [int]$pw, [int]$ph) {
  switch ($which) {
    'BottomRight' { return @{ X = $wa.Right - $pw - 16; Y = $wa.Bottom - $ph - 16 } }
    'TopCenter'   { return @{ X = [int]($wa.Left + ($wa.Width - $pw) / 2); Y = $wa.Top + 12 } }
    'Taskbar'     { return @{ X = $wa.Right - $pw - 16; Y = $wa.Bottom - $ph } }
    default       { return @{ X = $wa.Right - $pw - 16; Y = $wa.Bottom - $ph - 16 } }
  }
}

function Get-PositionLabel([string]$which) {
  switch ($which) {
    'BottomRight' { return '右下角' }
    'TopCenter'   { return '顶部居中' }
    'Taskbar'     { return '贴任务栏' }
    default       { return $which }
  }
}

function Resolve-NodeExe([string]$explicit) {
  if ($explicit -and (Test-Path $explicit)) { return $explicit }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

# node 版本是否够新（原生跑 .ts 要 >= 22.18）
function Get-NodeScore([string]$exe) {
  try {
    $v = (& $exe -v 2>&1 | Out-String).Trim()
    if ($v -match '^v(\d+)\.(\d+)') { return [pscustomobject]@{ Raw = $v; Score = ([int]$matches[1] * 100 + [int]$matches[2]) } }
  } catch { }
  return [pscustomobject]@{ Raw = 'unknown'; Score = 0 }
}

# 读一次 cli 的 stdout（一行 JSON）—— 单次采样，不驻留进程
function Read-Metrics([string]$nodeExe) {
  $result = [pscustomobject]@{ Ok = $false; Cpu = $null; Mem = $null; Err = '' }
  if (-not $nodeExe) { $result.Err = 'node 未找到'; return $result }

  # 关键：cli 的日志走 stderr；在 ErrorActionPreference=Stop 下，
  # 原生命令写 stderr 会被 PowerShell 当成「终止错误」抛出来 → 这里必须临时放宽。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $script:REPO_ROOT
  try {
    $raw = & $nodeExe --disable-warning=ExperimentalWarning 'packages/cli/src/main.ts' --ticks=1 --interval=250 2>$null | Out-String
  } catch {
    $result.Err = $_.Exception.Message
    return $result
  } finally {
    Pop-Location
    $ErrorActionPreference = $prevEap
  }

  $line = ($raw -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  if (-not $line) { $result.Err = 'cli 没有输出 JSON'; return $result }
  try {
    $obj = $line | ConvertFrom-Json
    $result.Cpu = ($obj.probes.'probe-cpu' | Where-Object { $_.key -eq 'cpu.usage' } | Select-Object -First 1).value
    $result.Mem = ($obj.probes.'probe-mem' | Where-Object { $_.key -eq 'mem.usage' } | Select-Object -First 1).value
    $result.Ok = $true
  } catch {
    $result.Err = 'JSON 解析失败：' + $_.Exception.Message
  }
  return $result
}

# ─────────────────────────────── 建窗 ───────────────────────────────

$FormW = 244
$FormH = 146
$R     = 14

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition   = 'Manual'
$form.Size            = New-Object System.Drawing.Size($FormW, $FormH)
$form.BackColor       = $cCard
$form.TopMost         = $true
$form.ShowInTaskbar   = $false
$form.Opacity         = $Opacity
$form.Text            = '只只 · 手感验证'
$form.Region          = New-RoundRegion $FormW $FormH $R

$fTitle = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
$fBody  = New-Object System.Drawing.Font('Microsoft YaHei UI', 9,  [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$fSmall = New-Object System.Drawing.Font('Microsoft YaHei UI', 8,  [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)

function New-Label([string]$text, [System.Drawing.Font]$font, [System.Drawing.Color]$color, [int]$x, [int]$y, [int]$lw, [int]$lh, [string]$align) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text
  $l.Font = $font
  $l.ForeColor = $color
  $l.BackColor = [System.Drawing.Color]::Transparent
  $l.Bounds = New-Object System.Drawing.Rectangle($x, $y, $lw, $lh)
  $l.AutoSize = $false
  $l.TextAlign = $align
  $l.Cursor = [System.Windows.Forms.Cursors]::Hand
  return $l
}

$lblTitle = New-Label '只只' $fTitle $cAccent 16 12 80 22 'MiddleLeft'
$lblPos   = New-Label '' $fSmall $cSub 16 36 210 16 'MiddleLeft'
$lblCpuK  = New-Label 'CPU' $fBody $cSub 16 58 60 22 'MiddleLeft'
$lblCpuV  = New-Label '—'   $fBody $cInk 100 58 128 22 'MiddleRight'
$lblMemK  = New-Label 'MEM' $fBody $cSub 16 82 60 22 'MiddleLeft'
$lblMemV  = New-Label '—'   $fBody $cInk 100 82 128 22 'MiddleRight'

$form.Controls.AddRange(@($lblTitle, $lblPos, $lblCpuK, $lblCpuV, $lblMemK, $lblMemV))

function New-FlatButton([string]$text, [int]$x, [int]$y, [int]$bw, [int]$bh) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Font = $fSmall
  $b.Bounds = New-Object System.Drawing.Rectangle($x, $y, $bw, $bh)
  $b.FlatStyle = 'Flat'
  $b.FlatAppearance.BorderColor = $cLine
  $b.FlatAppearance.BorderSize = 1
  $b.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(255, 240, 246, 255)
  $b.BackColor = [System.Drawing.Color]::White
  $b.ForeColor = $cInk
  $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  $b.TabStop = $false
  return $b
}

$btnSay   = New-FlatButton '说说' 16  110 66 26
$btnQuiet = New-FlatButton '安静' 90  110 66 26
$btnPos   = New-FlatButton '位置' 164 110 64 26
$form.Controls.AddRange(@($btnSay, $btnQuiet, $btnPos))

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = '✕'
$btnClose.Font = $fSmall
$btnClose.Bounds = New-Object System.Drawing.Rectangle(206, 11, 24, 22)
$btnClose.FlatStyle = 'Flat'
$btnClose.FlatAppearance.BorderSize = 0
$btnClose.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(255, 240, 240, 240)
$btnClose.BackColor = $cCard
$btnClose.ForeColor = $cSub
$btnClose.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnClose.TabStop = $false
$form.Controls.Add($btnClose)

# ─────────────────────────────── 行为 ───────────────────────────────

$script:nodeExe   = Resolve-NodeExe $NodeExe
$script:nodeInfo  = if ($script:nodeExe) { Get-NodeScore $script:nodeExe } else { [pscustomobject]@{ Raw = 'n/a'; Score = 0 } }
$script:posOrder  = @('BottomRight', 'TopCenter', 'Taskbar')
$script:stateText = ''

function Update-PosLabel {
  $label = Get-PositionLabel $Position
  $node = if (-not $script:nodeExe) { 'node 未找到' } elseif ($script:nodeInfo.Score -lt 2218) { 'node 版本过低(' + $script:nodeInfo.Raw + ')' } else { 'node ' + $script:nodeInfo.Raw }
  $lblPos.Text = "$label · $node · $($script:stateText)"
}

function Update-Metrics {
  $lblCpuV.Text = '采样中…'
  $lblMemV.Text = '采样中…'
  $form.Refresh()
  $m = Read-Metrics $script:nodeExe
  if ($m.Ok) {
    $lblCpuV.Text = ('{0:N1}%' -f [double]$m.Cpu)
    $lblMemV.Text = ('{0:N1}%' -f [double]$m.Mem)
  } else {
    $lblCpuV.Text = '—'
    $lblMemV.Text = '—'
    Write-Host ("[只只] 采样失败：" + $m.Err) -ForegroundColor DarkYellow
  }
}

function Move-ToPreset([string]$which) {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $pt = Get-PresetPoint $which $wa $form.Width $form.Height
  $form.Location = New-Object System.Drawing.Point($pt.X, $pt.Y)
  return $pt
}

# 拖拽：借用原生标题栏拖动，位置随手指走
$dragHandler = {
  [void][ZhizhiWin32]::ReleaseCapture()
  [void][ZhizhiWin32]::SendMessage($form.Handle, 0xA1, 0x2, 0)
}
$form.Add_MouseDown($dragHandler)
$lblTitle.Add_MouseDown($dragHandler)
$lblPos.Add_MouseDown($dragHandler)

$btnClose.Add_Click({ $form.Close() })

$btnSay.Add_Click({
  $script:stateText = '（以后这里展开详情）'
  Update-PosLabel
})

$btnQuiet.Add_Click({
  $script:stateText = '（以后这里是静音/降频）'
  Update-PosLabel
})

$btnPos.Add_Click({
  $i = $script:posOrder.IndexOf($Position)
  $next = $script:posOrder[($i + 1) % $script:posOrder.Count]
  $script:Position = $next
  [void](Move-ToPreset $next)
  Update-PosLabel
})

# 边框（圆角描边）
$form.Add_Paint({
  param($s, $e)
  $pen = New-Object System.Drawing.Pen($cLine, 1)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $cw = $s.ClientSize.Width
  $ch = $s.ClientSize.Height
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddArc(0.5, 0.5, $R * 2, $R * 2, 180, 90)
  $gp.AddArc($cw - $R * 2 - 0.5, 0.5, $R * 2, $R * 2, 270, 90)
  $gp.AddArc($cw - $R * 2 - 0.5, $ch - $R * 2 - 0.5, $R * 2, $R * 2, 0, 90)
  $gp.AddArc(0.5, $ch - $R * 2 - 0.5, $R * 2, $R * 2, 90, 90)
  $gp.CloseFigure()
  $g.DrawPath($pen, $gp)
  $pen.Dispose()
  $gp.Dispose()
})

# 句柄一建出来就上扩展样式（Show 之前就会触发）
$form.Add_HandleCreated({
  param($s, $e)
  [void](Apply-ExStyles $s.Handle)
})

# ─────────────────────────────── 自检模式 ───────────────────────────────

if ($SelfTest) {
  Write-Host '=== 只只 M3 浮窗 · 自检 ===' -ForegroundColor Cyan
  $waSelf = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  Write-Host ("屏幕工作区 : " + $waSelf.ToString())
  Write-Host ("窗口尺寸   : {0} x {1}  (圆角 r={2})" -f $FormW, $FormH, $R)
  Write-Host ("node       : " + $(if ($script:nodeExe) { $script:nodeExe } else { '(未找到)' }) + "  " + $script:nodeInfo.Raw)

  # 触发句柄创建 → 应用扩展样式 → 读回验证
  $hwnd = $form.Handle
  $st = Apply-ExStyles $hwnd
  $after = $st.After
  Write-Host ("EXSTYLE    : 0x{0:X8} -> 0x{1:X8}" -f $st.Before, $after) -ForegroundColor Yellow
  Write-Host ("  NOACTIVATE : " + [bool]($after -band $script:WS_EX_NOACTIVATE))
  Write-Host ("  TOPMOST    : " + [bool]($after -band $script:WS_EX_TOPMOST))
  Write-Host ("  TOOLWINDOW : " + [bool]($after -band $script:WS_EX_TOOLWINDOW))

  foreach ($preset in $script:posOrder) {
    $pt = Get-PresetPoint $preset $waSelf $FormW $FormH
    Write-Host ("位置预设   : {0,-12} -> X={1}, Y={2}" -f (Get-PositionLabel $preset), $pt.X, $pt.Y)
  }

  $m = Read-Metrics $script:nodeExe
  Write-Host ("读 cli     : Ok=" + $m.Ok + " Cpu=" + $m.Cpu + " Mem=" + $m.Mem)
  if (-not $m.Ok) { Write-Host ("              Err=" + $m.Err) -ForegroundColor DarkYellow }
  Write-Host ("控件数     : " + $form.Controls.Count)
  $form.Dispose()
  Write-Host '=== 自检结束（未弹窗）===' -ForegroundColor Cyan
  exit 0
}

# ─────────────────────────────── 上线 ───────────────────────────────

[void](Move-ToPreset $Position)
Update-PosLabel
Update-Metrics

Write-Host '=== 只只 · M3 手感验证浮窗 ===' -ForegroundColor Cyan
Write-Host ("位置        : " + (Get-PositionLabel $Position) + "   （点窗口里的「位置」按钮可轮换）")
Write-Host ("node        : " + $(if ($script:nodeExe) { $script:nodeExe + ' ' + $script:nodeInfo.Raw } else { '未找到' }))
Write-Host '拖拽        : 按住窗口上方的「只只」文字区域可拖动'
Write-Host '关闭        : 点右上角 ✕，或在本控制台按 Ctrl+C' -ForegroundColor DarkGray
Write-Host ''
Write-Host '★ 硬指标验收（请真的做一次）：' -ForegroundColor Yellow
Write-Host '  1. 点一下浮窗里的任意按钮' -ForegroundColor Yellow
Write-Host '  2. 切到编辑器/输入框，按 Ctrl+V' -ForegroundColor Yellow
Write-Host '  → 能正常粘贴 = 没抢焦点（WS_EX_NOACTIVATE 生效）' -ForegroundColor Yellow
Write-Host ''

[void]$form.ShowDialog()
Write-Host '只只浮窗已关闭。' -ForegroundColor Cyan
