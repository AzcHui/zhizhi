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

  ⚠️ 关闭请点右上角的 ✕。
     **不要在本控制台按 Ctrl+C** —— 那会「停止 PowerShell 管道」，此后浮窗的
     任何一个事件（点击 / 重绘）都会抛 PipelineStoppedException，弹出 .NET 致命
     对话框，控制台也再回不来。（2026-10-14 实测踩坑，详见《环境基线》第七节）

  出错时：任何未预期的异常都会被兜住 → 写进 tools\float-preview.log，
          并在浮窗上给出提示。**不会再弹致命对话框，也不会卡死。**
#>

[CmdletBinding()]
param(
  [ValidateSet('BottomRight', 'TopCenter', 'Taskbar')]
  [string]$Position = 'BottomRight',

  # 留空则自动从 PATH 找 node
  [string]$NodeExe = '',

  # 只搭窗口 + 打印自检，不真的显示，也不写设置文件（给自动化验证用）
  # ⚠️ 它**不绘制**，所以抓不到「绘制类」缺陷 —— 2026-10-14 的红叉事件就是这么漏过去的
  [switch]$SelfTest,

  # 真开一次窗口 ~0.9 秒：数「绘制期异常」次数 + 截图存证 + 退出（渲染回归专用）
  [switch]$RenderCheck
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

# ⚠️ ⚠️ 「只读」必须在这里就定下来，**不能等到 SelfTest / RenderCheck 的代码块里再设**。
#     因为「读存档位置 + Apply-Settings」跑在那两个分支**之前**（约 913–919 行）；
#     若 rememberPos=on，Move-ToPreset 会调 Save-Settings → **改写用户设置**。
#     （2026-10-14 复验实测：-RenderCheck 会把 settings.json 的 LastWriteTime 推后 → 已修）
#     => 原则：**验收模式绝不污染用户状态。**
$script:settingsReadOnly = [bool]($SelfTest -or $RenderCheck)

# ───────────────────── 日志与异常兜底（⭐ M3 踩坑后补）─────────────────────
# 为什么要有这一套：
#   PowerShell + WinForms 的特性是「事件处理器里抛出的异常直接冒到消息循环」，
#   默认行为是弹一个 .NET 致命对话框，窗口与控制台一起僵住。
#   更狠的是：管道（pipeline）一旦被 Ctrl+C 停止，之后**任何**处理器调用都会
#   抛 PipelineStoppedException，连 try/catch 都来不及进。
#   对策三层：① 处理器本体抽成普通函数（好测）② 处理器只剩 try/catch + 调用
#            ③ 再加一个全局兜底（下面这段）④ 处理器里**一律不写控制台**，只写日志文件

$script:LOG_PATH = Join-Path $script:SCRIPT_DIR 'float-preview.log'
$script:lastError = ''
$script:paintErrorLogged = $false
$script:errorCount = 0

function Write-ZhiLog([string]$msg) {
  try {
    $line = '[' + [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff') + '] ' + $msg + "`r`n"
    [System.IO.File]::AppendAllText($script:LOG_PATH, $line, (New-Object System.Text.UTF8Encoding($true)))
  } catch {
    # 连日志都写不了就算了 —— 绝不因为它再抛一次
  }
}

# 在浮窗上留个显眼但不挡路的痕迹（项目原则：不静默吞错）
function Show-ErrorHint([string]$text) {
  try {
    if ($lblPos) {
      $lblPos.Text = '⚠ ' + $text
      $lblPos.ForeColor = [System.Drawing.Color]::FromArgb(255, 190, 60, 60)
    }
  } catch { }
}

function Report-HandlerError([string]$where, $err) {
  try {
    $ex = $err.Exception
    $script:lastError = $where + ' -> ' + $ex.GetType().FullName + ' | ' + $ex.Message
    Write-ZhiLog ('[ERR] ' + $script:lastError)
    if ($err.ScriptStackTrace) {
      Write-ZhiLog ('      script: ' + ($err.ScriptStackTrace -replace "`r?`n", ' | '))
    }
    if ($ex.StackTrace) {
      Write-ZhiLog ('      .net  : ' + ($ex.StackTrace -replace "`r?`n", ' | '))
    }
    Show-ErrorHint ($where + ' 出错，详情见 float-preview.log')
  } catch { }
}

# 全局兜底：UI 线程上逃出来的异常 → 记日志 + 提示，**不再弹致命对话框**
try {
  [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
  [System.Windows.Forms.Application]::add_ThreadException({
    param($s, $e)
    $script:errorCount += 1
    Report-HandlerError 'Application.ThreadException（全局兜底）' $e
  })
  Write-ZhiLog ''
  Write-ZhiLog '===== float-preview 启动 ====='
} catch {
  Write-Host ('[只只] 全局异常兜底注册失败：' + $_.Exception.Message) -ForegroundColor DarkYellow
}

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
    Write-ZhiLog ('设置已保存：' + $script:SETTINGS_PATH)
  } catch {
    Write-ZhiLog ('[ERR] 设置存不下：' + $_.Exception.Message)
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
  # ⚠️ 这里**刻意不 OR `WS_EX_TOPMOST`** —— 窗口尚未显示时系统会把该位剥掉
  #    （实测 EXSTYLE 里没有 0x8），所以它既无效、又容易让人误以为「置顶是这儿设的」。
  #    **置顶一律走 `Form.TopMost` 属性**（见 Apply-Settings）。
  $before = [ZhizhiWin32]::GetWindowLong($handle, $script:GWL_EXSTYLE)
  $want   = $before -bor $script:WS_EX_NOACTIVATE -bor $script:WS_EX_TOOLWINDOW
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

# ─────────────────────────────── 字体（按尺寸缓存，永不 Dispose）───────────────────────────────
# 见 Set-Layout 里的 ⚠️ 注释：销毁已挂到控件上的字体 = 下次绘制红叉。

$script:fontCache = @{}

function New-FontSet([string]$sizeKey) {
  $k = Get-ScaleFactor $sizeKey
  return @{
    title = New-Object System.Drawing.Font('Microsoft YaHei UI', (11 * $k), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
    body  = New-Object System.Drawing.Font('Microsoft YaHei UI', (9 * $k), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
    small = New-Object System.Drawing.Font('Microsoft YaHei UI', (8 * $k), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  }
}

function Get-FontSet([string]$sizeKey) {
  if (-not $script:fontCache.ContainsKey($sizeKey)) {
    $script:fontCache[$sizeKey] = New-FontSet $sizeKey
  }
  return $script:fontCache[$sizeKey]
}

function Set-Layout {
  $k = Get-ScaleFactor $script:settings.size
  $script:k = $k

  # ⚠️⚠️ 字体**绝不 Dispose**（2026-10-14 踩坑，详见《环境基线》第六节 ⭐⭐⭐ 条）
  #   曾经这里写的是「先 Dispose 旧字体、再重建」—— 结果：控件还指着一个已释放的
  #   字体对象，GDI+ 下一次画字就抛 ArgumentException「参数无效」，WinForms 于是把
  #   每个控件画成**红叉**（实测：6 标签 + 5 按钮 = 11 个红叉）。
  #   而且字体 GDI+ 句柄带引用计数 → 表现**时好时坏**，极难复现（我被它骗过两次）。
  #   正解：按尺寸缓存，每种尺寸只建一次，进程内永不释放（最多 9 个 Font，可忽略）。
  $script:fonts = Get-FontSet $script:settings.size
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
    Write-ZhiLog ('采样失败：' + $m.Err)
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

# ── 拖拽 ─────────────────────────────────────────────────────────────────────
# ⚠️ 这里**刻意不用** SendMessage(WM_NCLBUTTONDOWN) 那套「借系统标题栏拖动」。
#    它会在处理器内部再开一个模态消息循环 —— 等于在 PowerShell 委托里再抽一次消息，
#    是「处理器重入」的高风险点（M3 踩坑，见《环境基线》第七节）。
#    改成纯手工拖：按下时记「光标位置 + 窗口位置」，移动时算差值。零重入、零 Win32。
#    （user32 那两个 P/Invoke 就留着当备件，不再从处理器里调用。）
$script:dragOrigin = $null

function Start-Drag([int]$cx, [int]$cy) {
  $script:dragOrigin = @{ CX = $cx; CY = $cy; WX = $form.Left; WY = $form.Top }
}

function Move-Drag([int]$cx, [int]$cy) {
  if ($null -eq $script:dragOrigin) { return $false }
  $x = $script:dragOrigin.WX + ($cx - $script:dragOrigin.CX)
  $y = $script:dragOrigin.WY + ($cy - $script:dragOrigin.CY)
  $form.Location = New-Object System.Drawing.Point($x, $y)
  return $true
}

function End-Drag {
  $script:dragOrigin = $null
}

# ── 处理器本体：全部抽成普通函数 ─────────────────────────────────────────────
# 好处：① 处理器只剩「try/catch + 调函数」，异常无处可逃
#       ② 自检（-SelfTest）可以直接调这些函数，不必真去点按钮

function Set-StatusText([string]$text) {
  $script:stateText = $text
  Update-PosLabel
}

function Move-NextPosition {
  $order = @('BottomRight', 'TopCenter', 'Taskbar')
  $i = -1
  for ($n = 0; $n -lt $order.Count; $n++) {
    if ($order[$n] -eq [string]$script:Position) { $i = $n }
  }
  $next = $order[($i + 1) % $order.Count]
  $script:Position = $next
  [void](Move-ToPreset $next)
  Update-PosLabel
  return $next
}

function Toggle-Panel {
  $script:panelOpen = -not $script:panelOpen
  if ($script:panelOpen) { $btnSet.Text = '收起' } else { $btnSet.Text = '设置' }
  Set-Layout
  Refresh-Toggles
  Keep-OnScreen
  $form.Invalidate()
  return $script:panelOpen
}

function Set-SettingOption([string]$name, [string]$value) {
  $script:settings.$name = $value
  # 打开「记住位置」时，立刻把当前位置记下来
  if ($name -eq 'rememberPos' -and $value -eq 'on') {
    $script:settings.posX = $form.Left
    $script:settings.posY = $form.Top
  }
  Apply-Settings
  Update-PosLabel
  Save-Settings
  Write-ZhiLog ('设置变更：' + $name + ' = ' + $value)
}

# ── 把事件挂上去（处理器只做两件事：调函数、兜异常）──────────────────────────

$dragTargets = @($form, $lblTitle, $lblPos)
foreach ($c in $dragTargets) {
  $c.Add_MouseDown({
    param($s, $e)
    try {
      $p = [System.Windows.Forms.Cursor]::Position
      Start-Drag $p.X $p.Y
      $form.Capture = $true
    } catch { Report-HandlerError 'mousedown' $_ }
  })
  $c.Add_MouseMove({
    param($s, $e)
    try {
      $p = [System.Windows.Forms.Cursor]::Position
      [void](Move-Drag $p.X $p.Y)
    } catch { Report-HandlerError 'mousemove' $_ }
  })
  $c.Add_MouseUp({
    param($s, $e)
    try {
      End-Drag
      $form.Capture = $false
    } catch { Report-HandlerError 'mouseup' $_ }
  })
}

$btnClose.Add_Click({
  try {
    Write-ZhiLog '点击 ✕ → 关闭'
    $form.Close()
  } catch { Report-HandlerError 'click:关闭' $_ }
})

$btnSay.Add_Click({
  try {
    Set-StatusText '（以后这里展开详情）'
    Write-ZhiLog '点击 说说'
  } catch { Report-HandlerError 'click:说说' $_ }
})

$btnQuiet.Add_Click({
  try {
    Set-StatusText '（以后这里是静音/降频）'
    Write-ZhiLog '点击 安静'
  } catch { Report-HandlerError 'click:安静' $_ }
})

$btnPos.Add_Click({
  try {
    $next = Move-NextPosition
    Write-ZhiLog ('点击 位置 → ' + $next)
  } catch { Report-HandlerError 'click:位置' $_ }
})

$btnSet.Add_Click({
  try {
    $open = Toggle-Panel
    if ($open) { Write-ZhiLog '点击 设置 → 展开' } else { Write-ZhiLog '点击 设置 → 收起' }
  } catch { Report-HandlerError 'click:设置' $_ }
})

# 设置项：一处处理全部切换按钮
foreach ($b in $script:toggleButtons) {
  $b.Add_Click({
    param($s, $e)
    try {
      $parts = $s.Tag -split '\|'
      Set-SettingOption $parts[0] $parts[1]
    } catch { Report-HandlerError 'click:设置项' $_ }
  })
}

# 边框（圆角描边）+ 设置面板上方的分隔线
$form.Add_Paint({
  param($s, $e)
  try {
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
  } catch {
    # Paint 出错会被反复触发，只记一次，免得日志被刷爆
    if (-not $script:paintErrorLogged) {
      $script:paintErrorLogged = $true
      Report-HandlerError 'paint' $_
    }
  }
})

# 句柄一建出来就上扩展样式
$form.Add_HandleCreated({
  param($s, $e)
  try {
    [void](Apply-ExStyles $s.Handle)
  } catch { Report-HandlerError 'handlecreated' $_ }
})

# 关窗时：如果开了「记住位置」，把当前位置存下来
$form.Add_FormClosing({
  try {
    if ($script:settings.rememberPos -eq 'on') {
      $script:settings.posX = $form.Left
      $script:settings.posY = $form.Top
    }
    Save-Settings
  } catch { Report-HandlerError 'formclosing' $_ }
})

# ─────────────────────────────── 自检模式 ───────────────────────────────

if ($SelfTest) {
  # 只读标志已在脚本开头（$script:settingsReadOnly 处）就设好 —— 不能在这儿设，太晚了
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

  # ── 事件处理器冒烟测试：直接调处理器本体（不弹窗、不写设置）──
  Write-Host ''
  Write-Host '--- 事件处理器冒烟测试（直接调函数，不弹窗）---' -ForegroundColor Cyan
  function Test-Step([string]$label, [scriptblock]$body) {
    try {
      $r = & $body
      Write-Host ("  OK    {0,-24} {1}" -f $label, $r)
    } catch {
      Write-Host ("  THREW {0,-24} {1}" -f $label, $_.Exception.Message) -ForegroundColor Red
    }
  }

  Test-Step 'Toggle-Panel 展开' { Toggle-Panel }
  Test-Step 'Toggle-Panel 收起' { Toggle-Panel }

  $keepSize = $script:settings.size
  Test-Step '设置项 尺寸=lg' { Set-SettingOption 'size' 'lg'; ('' + $form.ClientSize.Width + 'x' + $form.ClientSize.Height) }
  Test-Step '设置项 尺寸=sm' { Set-SettingOption 'size' 'sm'; ('' + $form.ClientSize.Width + 'x' + $form.ClientSize.Height) }
  $script:settings.size = $keepSize
  Set-Layout
  Refresh-Toggles

  Test-Step '设置项 置顶=off' {
    Set-SettingOption 'topmost' 'off'
    $ex = [ZhizhiWin32]::GetWindowLong($form.Handle, $script:GWL_EXSTYLE)
    ('EXSTYLE TOP=' + [bool]($ex -band $script:WS_EX_TOPMOST))
  }
  Test-Step '设置项 置顶=on' {
    Set-SettingOption 'topmost' 'on'
    $ex = [ZhizhiWin32]::GetWindowLong($form.Handle, $script:GWL_EXSTYLE)
    ('EXSTYLE TOP=' + [bool]($ex -band $script:WS_EX_TOPMOST))
  }

  Test-Step '位置轮换' {
    $before = [string]$script:Position
    $after = Move-NextPosition
    ($before + ' -> ' + $after)
  }

  Test-Step '拖拽模拟 (+120,+90)' {
    $l0 = $form.Location
    Start-Drag 500 500
    [void](Move-Drag 620 590)
    End-Drag
    $l1 = $form.Location
    ('(' + $l0.X + ',' + $l0.Y + ') -> (' + $l1.X + ',' + $l1.Y + ')  delta=(' + ($l1.X - $l0.X) + ',' + ($l1.Y - $l0.Y) + ')')
  }

  Test-Step 'Set-StatusText' { Set-StatusText '（自检）'; $script:stateText }

  Write-Host ("  处理器错误累计 : '" + $script:lastError + "'  （应为空）")
  Write-Host ("  日志文件       : " + $script:LOG_PATH)

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

# ─────────────────────── 渲染检查模式（-RenderCheck）───────────────────────
# 为什么需要它：-SelfTest **不弹窗 = 不绘制**，因此「画字失败」这类缺陷它抓不到。
# 2026-10-14 的「满屏红叉」正是这么漏过去的 —— 补一个真开窗、只数错的回归模式。
if ($RenderCheck) {
  # 只读标志已在脚本开头设好（不能在这儿设 —— 太晚，那时设置可能已经被写过了）
  $script:renderErrors = -1
  $script:renderSize = ''
  $shotPath = Join-Path $script:SCRIPT_DIR 'float-preview.render.png'
  $shotTimer = New-Object System.Windows.Forms.Timer
  $shotTimer.Interval = 900
  $shotTimer.Add_Tick({
    $shotTimer.Stop()
    try {
      $sx = $form.Left - 10
      $sy = $form.Top - 10
      $sw = $form.Width + 20
      $sh = $form.Height + 20
      $bmp = New-Object System.Drawing.Bitmap($sw, $sh)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($sx, $sy, 0, 0, (New-Object System.Drawing.Size($sw, $sh)))
      $bmp.Save($shotPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose()
      $bmp.Dispose()
      Write-ZhiLog ('渲染检查截图：' + $shotPath)
    } catch {
      Write-ZhiLog ('[ERR] 渲染检查截图失败：' + $_.Exception.Message)
    }
    $script:renderSize = '' + $form.ClientSize.Width + 'x' + $form.ClientSize.Height
    $script:renderErrors = $script:errorCount
    $form.Close()
  })
  $shotTimer.Start()
  [void]$form.ShowDialog()

  Write-Host ''
  Write-Host '=== 渲染检查（-RenderCheck）===' -ForegroundColor Cyan
  Write-Host ("绘制期异常次数 : " + $script:renderErrors + "   （0 = 正常；每多 1 个 = 有 1 个控件会被画成红叉）")
  Write-Host ("窗口尺寸       : " + $script:renderSize)
  Write-Host ("截图           : " + $shotPath)
  Write-Host ("日志           : " + $script:LOG_PATH)
  if ($script:renderErrors -eq 0) {
    Write-Host '结果：✅ 通过（画字正常，无红叉）' -ForegroundColor Green
  } else {
    Write-Host '结果：❌ 未通过 —— 见日志里的 [ERR] 行' -ForegroundColor Red
  }
  exit 0
}

Write-Host '=== 只只 · M3 手感验证浮窗 ===' -ForegroundColor Cyan
Write-Host ("位置        : " + (Get-PositionLabel $Position) + "   （点「位置」按钮可轮换；开了「记住位置」就记你拖到哪）")
Write-Host ("设置        : 点「设置」原地展开；自动存到 " + $script:SETTINGS_PATH)
Write-Host ("node        : " + $(if ($script:nodeExe) { $script:nodeExe + ' ' + $script:nodeInfo.Raw } else { '未找到' }))
Write-Host '拖拽        : 按住窗口上方的「只只」文字区域可拖动'
Write-Host '关闭        : 点右上角 ✕' -ForegroundColor DarkGray
Write-Host '              ⚠️ 不要在本控制台按 Ctrl+C —— 会停止 PowerShell 管道，' -ForegroundColor Red
Write-Host '                 之后浮窗点任何按钮都会报 PipelineStoppedException' -ForegroundColor Red
Write-Host ("出错        : 异常会写进 " + $script:LOG_PATH + "（不弹框、不卡死）")
Write-Host ''
Write-Host '★ 硬指标验收（请真的做一次）：' -ForegroundColor Yellow
Write-Host '  1. 点一下浮窗里的任意按钮' -ForegroundColor Yellow
Write-Host '  2. 切到编辑器/输入框，按 Ctrl+V' -ForegroundColor Yellow
Write-Host '  → 能正常粘贴 = 没抢焦点（WS_EX_NOACTIVATE 生效）' -ForegroundColor Yellow
Write-Host ''

[void]$form.ShowDialog()
Write-Host '只只浮窗已关闭。' -ForegroundColor Cyan
