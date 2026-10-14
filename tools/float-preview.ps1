<#
  float-preview.ps1 -- 只只 M3「手感验证」丑浮窗（一次性探针，非正式外壳）

  目的：用最丑最快的办法，把「位置 / 尺寸 / 挡不挡 / 按钮够不够」问明白，
        并顺带验证「基础设置 + 配置外置」这条路走不走得通。
  它不是 M4 的外壳；M4 会重写，这里只验证手感与配置机制。

  命门扩展样式（缺一不可）：
    WS_EX_NOACTIVATE  点浮窗按钮时不抢走编辑器焦点（否则 Ctrl+V 会失效）
    WS_EX_TOPMOST     永远置顶  ← ⚠️ 运行时开关一律用 Form.TopMost 属性，
                                  手打这个位在「窗口还没显示」时不稳（M3 实测）
    WS_EX_TOOLWINDOW  不进 Alt+Tab、不占任务栏

  ⚠️ 本文件必须存成「UTF-8 带 BOM」。
     PS 5.1 读无 BOM 的 .ps1 会按 GBK 解码 → 中文全乱码（「只只」会变「鍙彧」）。
     若用编辑器改完发现中文乱码，请重新另存为 UTF-8 with BOM。

  ⚠️ PowerShell 变量名大小写不敏感：$FormW 与 $formw 是同一个变量。
     本脚本刻意避开 $W / $H / $h 这类短名。

  用法：
    powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1
    powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -Position TopCenter
    powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -SelfTest   # 只自检，不弹窗、不写设置

  设置：点浮窗里的「设置」原地展开，改完立即生效，自动存到
        tools\float-preview.settings.json（下次打开自动生效）
#>

[CmdletBinding()]
param(
  [ValidateSet('BottomRight', 'TopCenter', 'Taskbar')]
  [string]$Position = 'BottomRight',

  # 留空则自动从 PATH 找 node
  [string]$NodeExe = '',

  # 只搭窗口 + 打印自检，不真的显示，也不写设置文件（给自动化验证用）
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

$script:SCRIPT_DIR    = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:REPO_ROOT     = Split-Path -Parent $script:SCRIPT_DIR
$script:SETTINGS_PATH = Join-Path $script:SCRIPT_DIR 'float-preview.settings.json'
$script:settingsReadOnly = $false

# ─────────────────────────────── 配色（浅色主题）───────────────────────────────

$cCard   = [System.Drawing.Color]::FromArgb(255, 250, 250, 250)
$cInk    = [System.Drawing.Color]::FromArgb(255,  32,  32,  32)
$cSub    = [System.Drawing.Color]::FromArgb(255, 130, 130, 130)
$cLine   = [System.Drawing.Color]::FromArgb(255, 224, 224, 224)
$cAccent = [System.Drawing.Color]::FromArgb(255,  22, 123, 250)   # 项目主色 #167BFA

# ─────────────────────────────── 设置模型 ───────────────────────────────
# 全部用「短字符串」存，好处：① 存 JSON 好读 ② 切换按钮的逻辑能完全统一

function Get-DefaultSettings {
  return [pscustomobject]@{
    size        = 'md'      # sm | md | lg
    opacity     = 'mid'     # thin(0.75) | mid(0.88) | solid(1.0)
    topmost     = 'on'      # on | off
    rememberPos = 'off'     # on | off
    posX        = -1
    posY        = -1
  }
}

function Get-ScaleFactor([string]$sizeKey) {
  if ($sizeKey -eq 'sm') { return 0.82 }
  if ($sizeKey -eq 'lg') { return 1.22 }
  return 1.0
}

function Get-OpacityValue([string]$key) {
  if ($key -eq 'thin') { return 0.75 }
  if ($key -eq 'solid') { return 1.0 }
  return 0.88
}

function Read-Settings([string]$path) {
  $def = Get-DefaultSettings
  if (-not (Test-Path $path)) { return $def }
  try {
    $obj = (Get-Content -Path $path -Raw -Encoding UTF8) | ConvertFrom-Json
    $out = Get-DefaultSettings
    foreach ($p in @('size', 'opacity', 'topmost', 'rememberPos', 'posX', 'posY')) {
      if ($null -ne $obj.$p) { $out.$p = $obj.$p }
    }
    # 非法值一律回落默认（别让一个手改坏的 JSON 把窗口搞成怪物）
    if ($out.size -notin @('sm', 'md', 'lg')) { $out.size = $def.size }
    if ($out.opacity -notin @('thin', 'mid', 'solid')) { $out.opacity = $def.opacity }
    if ($out.topmost -notin @('on', 'off')) { $out.topmost = $def.topmost }
    if ($out.rememberPos -notin @('on', 'off')) { $out.rememberPos = $def.rememberPos }
    return $out
  } catch {
    Write-Host ("[只只] 设置文件读不动，改用默认值：" + $_.Exception.Message) -ForegroundColor DarkYellow
    return $def
  }
}

function Save-Settings {
  if ($script:settingsReadOnly) { return }
  try {
    $script:settings | ConvertTo-Json | Set-Content -Path $script:SETTINGS_PATH -Encoding UTF8
  } catch {
    Write-Host ("[只只] 设置存不下：" + $_.Exception.Message) -ForegroundColor DarkYellow
  }
}

$script:settings  = Read-Settings $script:SETTINGS_PATH
$script:panelOpen = $false
$script:fonts     = @{}
$script:k         = 1.0
$script:mainH     = 146

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

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition   = 'Manual'
$form.BackColor       = $cCard
$form.ShowInTaskbar   = $false
$form.Text            = '只只 · 手感验证'

function New-Label([string]$text, [System.Drawing.Color]$color, [string]$align) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text
  $l.ForeColor = $color
  $l.BackColor = [System.Drawing.Color]::Transparent
  $l.AutoSize = $false
  $l.TextAlign = $align
  $l.Cursor = [System.Windows.Forms.Cursors]::Hand
  return $l
}

function New-FlatButton([string]$text) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.FlatStyle = 'Flat'
  $b.FlatAppearance.BorderSize = 1
  $b.FlatAppearance.BorderColor = $cLine
  $b.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(255, 240, 246, 255)
  $b.BackColor = [System.Drawing.Color]::White
  $b.ForeColor = $cInk
  $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  $b.TabStop = $false
  return $b
}

# —— 主区 ——
$lblTitle = New-Label '只只' $cAccent 'MiddleLeft'
$lblPos   = New-Label ''     $cSub    'MiddleLeft'
$lblCpuK  = New-Label 'CPU'  $cSub    'MiddleLeft'
$lblCpuV  = New-Label '—'    $cInk    'MiddleRight'
$lblMemK  = New-Label 'MEM'  $cSub    'MiddleLeft'
$lblMemV  = New-Label '—'    $cInk    'MiddleRight'

$btnSay   = New-FlatButton '说说'
$btnQuiet = New-FlatButton '安静'
$btnPos   = New-FlatButton '位置'
$btnSet   = New-FlatButton '设置'

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = '✕'
$btnClose.FlatStyle = 'Flat'
$btnClose.FlatAppearance.BorderSize = 0
$btnClose.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(255, 240, 240, 240)
$btnClose.BackColor = $cCard
$btnClose.ForeColor = $cSub
$btnClose.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnClose.TabStop = $false

# —— 设置面板（默认隐藏，点「设置」才显示）——
$lblSize = New-Label '尺寸'     $cSub 'MiddleLeft'
$lblOpa  = New-Label '透明'     $cSub 'MiddleLeft'
$lblTop  = New-Label '置顶'     $cSub 'MiddleLeft'
$lblRem  = New-Label '记住位置' $cSub 'MiddleLeft'

# 切换按钮：Tag = "<设置项>|<取值>"，点击后统一处理
$script:toggleButtons = @()
function New-Toggle([string]$text, [string]$group, [string]$value) {
  $b = New-FlatButton $text
  $b.Tag = "$group|$value"
  $script:toggleButtons += $b
  return $b
}
$btnSizeSm   = New-Toggle '小' 'size' 'sm'
$btnSizeMd   = New-Toggle '中' 'size' 'md'
$btnSizeLg   = New-Toggle '大' 'size' 'lg'
$btnOpaThin  = New-Toggle '细' 'opacity' 'thin'
$btnOpaMid   = New-Toggle '中' 'opacity' 'mid'
$btnOpaSolid = New-Toggle '实' 'opacity' 'solid'
$btnTopOn    = New-Toggle '开' 'topmost' 'on'
$btnTopOff   = New-Toggle '关' 'topmost' 'off'
$btnRemOn    = New-Toggle '开' 'rememberPos' 'on'
$btnRemOff   = New-Toggle '关' 'rememberPos' 'off'

$script:panelCtrls = @($lblSize, $lblOpa, $lblTop, $lblRem,
  $btnSizeSm, $btnSizeMd, $btnSizeLg,
  $btnOpaThin, $btnOpaMid, $btnOpaSolid,
  $btnTopOn, $btnTopOff, $btnRemOn, $btnRemOff)

$script:mainCtrls = @(
  $lblTitle, $lblPos, $lblCpuK, $lblCpuV, $lblMemK, $lblMemV,
  $btnSay, $btnQuiet, $btnPos, $btnSet, $btnClose
)

$form.Controls.AddRange($script:mainCtrls)
$form.Controls.AddRange($script:panelCtrls)

# ─────────────────────────────── 布局（等比缩放）───────────────────────────────

function Set-Bounds($ctrl, [double]$x, [double]$y, [double]$w, [double]$h) {
  $ctrl.Bounds = New-Object System.Drawing.Rectangle(
    [int][Math]::Round($x), [int][Math]::Round($y),
    [int][Math]::Round($w), [int][Math]::Round($h))
}

function Set-Layout {
  $k = Get-ScaleFactor $script:settings.size
  $script:k = $k

  if ($script:fonts -and $script:fonts.Count -gt 0) {
    foreach ($f in @($script:fonts.Values)) { $f.Dispose() }
  }
  $script:fonts = @{
    title = New-Object System.Drawing.Font('Microsoft YaHei UI', (11 * $k), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
    body  = New-Object System.Drawing.Font('Microsoft YaHei UI', (9 * $k), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
    small = New-Object System.Drawing.Font('Microsoft YaHei UI', (8 * $k), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  }
  $fTitle = $script:fonts.title
  $fBody  = $script:fonts.body
  $fSmall = $script:fonts.small

  $mainH = [int][Math]::Round(146 * $k)
  $script:mainH = $mainH
  $panelH = [int][Math]::Round(116 * $k)
  $totalH = $mainH
  if ($script:panelOpen) { $totalH = $mainH + $panelH }
  $w = [int][Math]::Round(244 * $k)

  # —— 主区 ——
  Set-Bounds $lblTitle (16 * $k) (12 * $k) (80 * $k) (22 * $k)
  $lblTitle.Font = $fTitle
  Set-Bounds $lblPos (16 * $k) (36 * $k) (212 * $k) (16 * $k)
  $lblPos.Font = $fSmall
  Set-Bounds $lblCpuK (16 * $k) (58 * $k) (60 * $k) (22 * $k)
  $lblCpuK.Font = $fBody
  Set-Bounds $lblCpuV (100 * $k) (58 * $k) (128 * $k) (22 * $k)
  $lblCpuV.Font = $fBody
  Set-Bounds $lblMemK (16 * $k) (82 * $k) (60 * $k) (22 * $k)
  $lblMemK.Font = $fBody
  Set-Bounds $lblMemV (100 * $k) (82 * $k) (128 * $k) (22 * $k)
  $lblMemV.Font = $fBody

  Set-Bounds $btnSay   (16 * $k)  (110 * $k) (50 * $k) (26 * $k)
  Set-Bounds $btnQuiet (70 * $k)  (110 * $k) (50 * $k) (26 * $k)
  Set-Bounds $btnPos   (124 * $k) (110 * $k) (50 * $k) (26 * $k)
  Set-Bounds $btnSet   (178 * $k) (110 * $k) (50 * $k) (26 * $k)
  foreach ($b in @($btnSay, $btnQuiet, $btnPos, $btnSet)) { $b.Font = $fSmall }

  Set-Bounds $btnClose (206 * $k) (11 * $k) (24 * $k) (22 * $k)
  $btnClose.Font = $fSmall

  # —— 设置面板：行 154 / 180 / 206 / 232，按钮组右对齐到 228 ——
  $rows = @(154, 180, 206, 232)
  $lbls = @($lblSize, $lblOpa, $lblTop, $lblRem)
  for ($i = 0; $i -lt 4; $i++) {
    $c = $lbls[$i]
    Set-Bounds $c (16 * $k) ($rows[$i] * $k) (68 * $k) (22 * $k)
    $c.Font = $fSmall
  }
  # 三选一行（尺寸 / 透明）：x = 96 / 141 / 186（宽 42）
  $x3 = @(96, 141, 186)
  $three = @(
    @{ y = 154; btns = @($btnSizeSm, $btnSizeMd, $btnSizeLg) },
    @{ y = 180; btns = @($btnOpaThin, $btnOpaMid, $btnOpaSolid) }
  )
  foreach ($g in $three) {
    for ($i = 0; $i -lt 3; $i++) {
      $c = $g.btns[$i]
      Set-Bounds $c ($x3[$i] * $k) ($g.y * $k) (42 * $k) (22 * $k)
      $c.Font = $fSmall
    }
  }
  # 二选一行（置顶 / 记住位置）：x = 141 / 186，对齐到三选一的后两格
  $x2 = @(141, 186)
  $two = @(
    @{ y = 206; btns = @($btnTopOn, $btnTopOff) },
    @{ y = 232; btns = @($btnRemOn, $btnRemOff) }
  )
  foreach ($g in $two) {
    for ($i = 0; $i -lt 2; $i++) {
      $c = $g.btns[$i]
      Set-Bounds $c ($x2[$i] * $k) ($g.y * $k) (42 * $k) (22 * $k)
      $c.Font = $fSmall
    }
  }

  foreach ($c in $script:panelCtrls) { $c.Visible = $script:panelOpen }

  $form.ClientSize = New-Object System.Drawing.Size($w, $totalH)
  $rr = [int][Math]::Round(14 * $k)
  if ($rr -lt 2) { $rr = 2 }
  $form.Region = New-RoundRegion $w $totalH $rr
}

function Refresh-Toggles {
  foreach ($b in $script:toggleButtons) {
    $parts = $b.Tag -split '\|'
    $name = $parts[0]
    $active = ($script:settings.$name -eq $parts[1])
    if ($active) {
      $b.BackColor = $cAccent
      $b.ForeColor = [System.Drawing.Color]::White
      $b.FlatAppearance.BorderColor = $cAccent
    } else {
      $b.BackColor = [System.Drawing.Color]::White
      $b.ForeColor = $cInk
      $b.FlatAppearance.BorderColor = $cLine
    }
  }
}

function Keep-OnScreen {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $x = [Math]::Min([Math]::Max($form.Left, $wa.Left), $wa.Right - $form.Width)
  $y = [Math]::Min([Math]::Max($form.Top, $wa.Top), $wa.Bottom - $form.Height)
  $form.Location = New-Object System.Drawing.Point($x, $y)
}

function Move-ToPreset([string]$which) {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $pt = Get-PresetPoint $which $wa $form.Width $form.Height
  $form.Location = New-Object System.Drawing.Point($pt.X, $pt.Y)
  if ($script:settings.rememberPos -eq 'on') {
    $script:settings.posX = $pt.X
    $script:settings.posY = $pt.Y
    Save-Settings
  }
  return $pt
}

function Update-PosLabel {
  $label = Get-PositionLabel $Position
  $node = 'node 未找到'
  if ($script:nodeExe) {
    if ($script:nodeInfo.Score -lt 2218) { $node = 'node 版本过低(' + $script:nodeInfo.Raw + ')' }
    else { $node = 'node ' + $script:nodeInfo.Raw }
  }
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

# 把设置真正作用到窗口上
function Apply-Settings {
  $form.Opacity = Get-OpacityValue $script:settings.opacity
  $form.TopMost = ($script:settings.topmost -eq 'on')
  Set-Layout
  Refresh-Toggles
  Keep-OnScreen
  $form.Invalidate()
}

# ─────────────────────────────── 行为 ───────────────────────────────

$script:nodeExe   = Resolve-NodeExe $NodeExe
if ($script:nodeExe) { $script:nodeInfo = Get-NodeScore $script:nodeExe }
else { $script:nodeInfo = [pscustomobject]@{ Raw = 'n/a'; Score = 0 } }
$script:stateText = ''

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
  $order = @('BottomRight', 'TopCenter', 'Taskbar')
  $i = $order.IndexOf($Position)
  $next = $order[($i + 1) % $order.Count]
  $script:Position = $next
  [void](Move-ToPreset $next)
  Update-PosLabel
})

$btnSet.Add_Click({
  $script:panelOpen = -not $script:panelOpen
  if ($script:panelOpen) { $btnSet.Text = '收起' } else { $btnSet.Text = '设置' }
  Set-Layout
  Refresh-Toggles
  Keep-OnScreen
  $form.Invalidate()
})

# 设置项：一处处理全部切换按钮
foreach ($b in $script:toggleButtons) {
  $b.Add_Click({
    param($s, $e)
    $parts = $s.Tag -split '\|'
    $name = $parts[0]
    $script:settings.$name = $parts[1]
    # 打开「记住位置」时，立刻把当前位置记下来
    if ($name -eq 'rememberPos' -and $parts[1] -eq 'on') {
      $script:settings.posX = $form.Left
      $script:settings.posY = $form.Top
    }
    Apply-Settings
    Update-PosLabel
    Save-Settings
  })
}

# 边框（圆角描边）+ 设置面板上方的分隔线
$form.Add_Paint({
  param($s, $e)
  $pen = New-Object System.Drawing.Pen($cLine, 1)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $cw = $s.ClientSize.Width
  $ch = $s.ClientSize.Height
  $rr = [int][Math]::Round(14 * $script:k)
  if ($rr -gt 1) {
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddArc(0.5, 0.5, $rr * 2, $rr * 2, 180, 90)
    $gp.AddArc($cw - $rr * 2 - 0.5, 0.5, $rr * 2, $rr * 2, 270, 90)
    $gp.AddArc($cw - $rr * 2 - 0.5, $ch - $rr * 2 - 0.5, $rr * 2, $rr * 2, 0, 90)
    $gp.AddArc(0.5, $ch - $rr * 2 - 0.5, $rr * 2, $rr * 2, 90, 90)
    $gp.CloseFigure()
    $g.DrawPath($pen, $gp)
    $gp.Dispose()
  }
  if ($script:panelOpen) {
    $sy = $script:mainH
    $x1 = [int][Math]::Round(16 * $script:k)
    $g.DrawLine($pen, $x1, $sy, $cw - $x1, $sy)
  }
  $pen.Dispose()
})

# 句柄一建出来就上扩展样式
$form.Add_HandleCreated({
  param($s, $e)
  [void](Apply-ExStyles $s.Handle)
})

# 关窗时：如果开了「记住位置」，把当前位置存下来
$form.Add_FormClosing({
  if ($script:settings.rememberPos -eq 'on') {
    $script:settings.posX = $form.Left
    $script:settings.posY = $form.Top
  }
  Save-Settings
})

# ─────────────────────────────── 自检模式 ───────────────────────────────

if ($SelfTest) {
  $script:settingsReadOnly = $true   # ⚠️ 自检绝不写设置文件
  Write-Host '=== 只只 M3 浮窗 · 自检 ===' -ForegroundColor Cyan
  $waSelf = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  Write-Host ("屏幕工作区   : " + $waSelf.ToString())
  Write-Host ("设置文件     : " + $script:SETTINGS_PATH + "  (已存在: " + (Test-Path $script:SETTINGS_PATH) + ")")
  Write-Host ("已载入设置   : size={0} opacity={1} topmost={2} rememberPos={3} pos=({4},{5})" -f `
      $script:settings.size, $script:settings.opacity, $script:settings.topmost, $script:settings.rememberPos, $script:settings.posX, $script:settings.posY)

  $hwnd = $form.Handle
  $st = Apply-ExStyles $hwnd
  $ex = $st.After
  Write-Host ("EXSTYLE      : 0x{0:X8} -> 0x{1:X8}" -f $st.Before, $ex) -ForegroundColor Yellow
  Write-Host ("  NOACTIVATE : " + [bool]($ex -band $script:WS_EX_NOACTIVATE))
  Write-Host ("  TOPMOST    : " + [bool]($ex -band $script:WS_EX_TOPMOST))
  Write-Host ("  TOOLWINDOW : " + [bool]($ex -band $script:WS_EX_TOOLWINDOW))

  # 置顶：走 Form.TopMost 属性（实测运行时开关靠它，不靠手打位）
  $form.TopMost = $false
  $exOff = [ZhizhiWin32]::GetWindowLong($hwnd, $script:GWL_EXSTYLE)
  $form.TopMost = $true
  $exOn = [ZhizhiWin32]::GetWindowLong($hwnd, $script:GWL_EXSTYLE)
  Write-Host ("置顶 关/开    : 0x{0:X8}(TOP={1})  ->  0x{2:X8}(TOP={3})" -f $exOff, [bool]($exOff -band $script:WS_EX_TOPMOST), $exOn, [bool]($exOn -band $script:WS_EX_TOPMOST))

  $savedSize = $script:settings.size
  foreach ($sz in @('sm', 'md', 'lg')) {
    $script:settings.size = $sz
    Set-Layout
    Write-Host ("尺寸 {0,-3}      : 窗口 {1}x{2} · 正文字号 {3:N1}pt" -f $sz, $form.ClientSize.Width, $form.ClientSize.Height, $script:fonts.body.Size)
  }
  $script:settings.size = $savedSize

  foreach ($op in @('thin', 'mid', 'solid')) {
    Write-Host ("透明度 {0,-6} : {1:N2}" -f $op, (Get-OpacityValue $op))
  }

  Set-Layout
  $hClosed = $form.ClientSize.Height
  $script:panelOpen = $true
  Set-Layout
  $hOpen = $form.ClientSize.Height
  $script:panelOpen = $false
  Set-Layout
  Write-Host ("设置面板     : 收起 {0}px -> 展开 {1}px" -f $hClosed, $hOpen)

  foreach ($preset in @('BottomRight', 'TopCenter', 'Taskbar')) {
    $pt = Get-PresetPoint $preset $waSelf $form.ClientSize.Width $form.ClientSize.Height
    Write-Host ("位置 {0,-9} : X={1}, Y={2}" -f (Get-PositionLabel $preset), $pt.X, $pt.Y)
  }

  Write-Host ("控件总数     : " + $form.Controls.Count)
  $m = Read-Metrics $script:nodeExe
  Write-Host ("读 cli       : Ok=" + $m.Ok + " Cpu=" + $m.Cpu + " Mem=" + $m.Mem)
  if (-not $m.Ok) { Write-Host ("               Err=" + $m.Err) -ForegroundColor DarkYellow }
  $form.Dispose()
  Write-Host '=== 自检结束（未弹窗、未写设置文件）===' -ForegroundColor Cyan
  exit 0
}

# ─────────────────────────────── 上线 ───────────────────────────────

Set-Layout
# 位置：开了「记住位置」且有存档 → 用存档；否则用 -Position
if ($script:settings.rememberPos -eq 'on' -and $script:settings.posX -ge 0 -and $script:settings.posY -ge 0) {
  $form.Location = New-Object System.Drawing.Point([int]$script:settings.posX, [int]$script:settings.posY)
  Keep-OnScreen
} else {
  [void](Move-ToPreset $Position)
}
Apply-Settings
Update-PosLabel
Update-Metrics

Write-Host '=== 只只 · M3 手感验证浮窗 ===' -ForegroundColor Cyan
Write-Host ("位置        : " + (Get-PositionLabel $Position) + "   （点「位置」按钮可轮换；开了「记住位置」就记你拖到哪）")
Write-Host ("设置        : 点「设置」原地展开；自动存到 " + $script:SETTINGS_PATH)
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
