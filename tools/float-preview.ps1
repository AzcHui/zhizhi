<#
  float-preview.ps1 -- 只只的「最小可用外壳」（M4-a）

  它是什么：一个**能自己把内核跑起来**的小浮窗。
    · 自己拉起内核（node 的 sidecar 子进程），**长连接读它的 stdout**
      → 每来一行指标就刷新窗口（不再是「打开时采一次」）
    · 同时读内核的 stderr → 把它**说的话**显示在窗口上
      —— 显示 CPU 数字的叫监控工具，会说话的才是「只只」
    · 关窗时自动把内核收掉，不留孤儿进程

  它不是最终外壳（M4-b）：没有托盘、没有开机自启、长得还是 WinForms 那副样子。
  但它验证的是**数据接线**那条路，而这条路换成 Tauri / Electron 也一样成立
  ——「stdout = 一行 JSON」这个约定是 M0 就锁死的。

  演进：M3 时它只是「手感探针」（一次性采样）；**M4-a 起它变成 MVP 外壳（sidecar 宿主）**。

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

  ⚠️⚠️ **绝不用 `add_OutputDataReceived` 读子进程输出** —— 那个回调跑在**线程池线程**上，
     PowerShell 的脚本块在那种线程上会炸（没有 Runspace / 管道已停止）。
     本脚本用「轮询异步读」：每次只挂一个 `ReadLineAsync()`，由 UI 线程的 Timer 检查它
     完成没有 → 取结果 → 再挂下一个。**零线程、零阻塞**（M4-a 实测通过，见《环境基线》）。

  用法：
    powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1
    powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -Position TopCenter
    # 想快点看到只只开口（默认要「连续超标 2 分钟」才说）：
    powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -Interval 1000 -SustainMs 3000 -CooldownMs 5000
    powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -SelfTest   # 自检，不弹窗、不写设置

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

  # ── 内核（sidecar 子进程）的参数 ──
  # 采样间隔：越小窗口越「活」，但也越费 CPU。2000ms 是「看着像实时」与「不打扰」的折中。
  [int]$Interval = 2000,
  # 持续判定窗口 / 冷却期：0 = 用内核默认（2 分钟 / 15 分钟）。
  # 调小只为「快点看到只只开口」，不是产品默认值。
  [int]$SustainMs = 0,
  [int]$CooldownMs = 0,

  # 只搭窗口 + 打印自检，不真的显示，也不写设置文件（给自动化验证用）
  # ⚠️ 它**不绘制**，所以抓不到「绘制类」缺陷 —— 2026-10-14 的红叉事件就是这么漏过去的
  [switch]$SelfTest,

  # 真开一次窗口：数「绘制期异常」次数 + 截图存证 + 退出（渲染回归专用）
  # ShotDelayMs 默认 2600（够内核出第一条采样）；想连「只只开口」一起截到就调大
  [switch]$RenderCheck,
  [int]$ShotDelayMs = 2600
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
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
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
# 验收模式下不自检模式输出交织，内核日志不镜像到控制台（照常进文件）
$script:consoleMirror = -not $script:settingsReadOnly

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

# ──────────────────── 内核 sidecar：自己把它跑起来，长连接读它的流 ────────────────────
#
# 为什么这么写（M4-a 实测结论）：
#   ① **长连接读 stdout**：内核每 tick 吐一行 JSON —— 这个约定 M0 就锁死了，
#      今天终于有人消费它。换成 Tauri / Electron 外壳时，这条路径完全不变。
#   ② **轮询异步读**，绝不用 `add_OutputDataReceived` —— 那个回调跑在线程池线程上，
#      PowerShell 的脚本块在那儿会炸（没有 Runspace / 管道已停止）。
#   ③ **stderr 也必须一直抽干**：管道缓冲区写满（约 64KB）内核就会被阻塞。
#      顺带的收获：**只只说的话就在 stderr 里**，正好显示到窗口上。

$script:kernel = $null        # sidecar 进程
$script:kernelOut = $null     # stdout 的「待完成异步读」
$script:kernelErr = $null     # stderr 的「待完成异步读」
$script:kernelLines = 0       # 已收到几条采样
$script:eventLines = 0        # 已收到几条「只只说的话」（stdout 的 type:"event"/"alert"）
$script:kernelDead = $false
$script:metricsTimer = $null  # UI 线程上的轮询定时器

function Start-Kernel {
  if (-not $script:nodeExe) {
    Write-ZhiLog '[ERR] 找不到 node，内核起不来'
    Show-ErrorHint '找不到 node'
    return
  }

  $kernelArgs = "--disable-warning=ExperimentalWarning packages/cli/src/main.ts --interval=$script:kernelIntervalMs"
  if ($script:kernelSustainMs -gt 0) { $kernelArgs += " --sustain-ms=$script:kernelSustainMs" }
  if ($script:kernelCooldownMs -gt 0) { $kernelArgs += " --cooldown-ms=$script:kernelCooldownMs" }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:nodeExe
  $psi.Arguments = $kernelArgs
  $psi.WorkingDirectory = $script:REPO_ROOT
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $true      # ⚠️ M6 反向通道：外壳要把 idleMs 喂给内核（stdin 一行 JSON）
  $psi.CreateNoWindow = $true
  # ⚠️ 这两行不设，只只说的中文会被 PowerShell 按 GBK 解码 → 全成乱码（实测踩过）
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $psi.StandardOutputEncoding = $utf8
  $psi.StandardErrorEncoding = $utf8

  try {
    $script:kernel = [System.Diagnostics.Process]::Start($psi)
  } catch {
    Write-ZhiLog ('[ERR] 内核启动失败：' + $_.Exception.Message)
    Show-ErrorHint '内核启动失败，详情见日志'
    return
  }

  $script:kernelOut = $script:kernel.StandardOutput.ReadLineAsync()
  $script:kernelErr = $script:kernel.StandardError.ReadLineAsync()
  Write-ZhiLog ('内核已作为 sidecar 启动：PID=' + $script:kernel.Id + ' 参数=' + $kernelArgs)
}

function Stop-Kernel {
  if ($null -eq $script:kernel) { return }
  try {
    if (-not $script:kernel.HasExited) {
      $script:kernel.Kill()
      [void]$script:kernel.WaitForExit(3000)
      Write-ZhiLog '内核 sidecar 已收掉'
    }
  } catch {
    Write-ZhiLog ('[ERR] 收内核时出错：' + $_.Exception.Message)
  }
  $script:kernel = $null
  $script:kernelOut = $null
  $script:kernelErr = $null
}

# stdout 来了一行。⚠️ M6 起它有**两种**行（都在设计好的数据通道上）：
#   {"tick":…,"probes":{…}}              → 采样，刷新 CPU / MEM
#   {"type":"event","level":…,"text":…}  → 只只说的话（channel-console 发的，告警+闲聊一条路）
function Apply-SampleLine([string]$line) {
  if (-not $line.TrimStart().StartsWith('{')) { return }   # stdout 只有数据，防一手
  try {
    $obj = $line | ConvertFrom-Json
    if ($obj.type -eq 'event' -or $obj.type -eq 'alert') {
      $script:eventLines++
      Apply-SaidText ([string]$obj.text)
      return
    }
    if ($null -ne $obj.probes) {
      $cpu = ($obj.probes.'probe-cpu' | Where-Object { $_.key -eq 'cpu.usage' } | Select-Object -First 1).value
      $mem = ($obj.probes.'probe-mem' | Where-Object { $_.key -eq 'mem.usage' } | Select-Object -First 1).value
      if ($null -ne $cpu) { $lblCpuV.Text = ('{0:N1}%' -f [double]$cpu) }
      if ($null -ne $mem) { $lblMemV.Text = ('{0:N1}%' -f [double]$mem) }
      $script:kernelLines++
      Update-PosLabel
    }
  } catch {
    Write-ZhiLog ('[ERR] 采样行解析失败：' + $_.Exception.Message)
  }
}

# 把「只只说的话」摆上窗口（M6 起数据源 = stdout 的 type:"event"，不再解析 stderr 日志行）
function Apply-SaidText([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return }
  if ($text.Length -gt 24) { $lblSaid.Text = $text.Substring(0, 24) + '…' }
  else { $lblSaid.Text = $text }
  Write-ZhiLog ('只只说了：' + $text)
}

# stderr 来了一行：日志。
# M6 起**镜像到控制台**（终端 = 看真实日志的地方），ERR/WRN 照旧进日志文件。
# ⚠️ 用 [Console]::WriteLine 直写、**不用 Write-Host** —— 后者走 PowerShell 管道，
#     在事件处理器里有 PipelineStoppedException 的前科；[Console] 绕开管道，无此风险。
function Apply-LogLine([string]$line) {
  if ($script:consoleMirror -and $line.Trim().Length -gt 0) {
    try { [Console]::WriteLine($line) } catch { }
  }
  if ($line -match 'ERR|WRN') {
    Write-ZhiLog ('内核日志：' + $line)
  }
}

# ── M6 反向通道：把「你闲了多久」喂给内核 ──
# ⚠️ 不是键鼠监听：GetLastInputInfo 只返回**一个数字**（最后一次输入距今多少毫秒），
#    根本不知道你按了什么 —— 与当初明确砍掉的键鼠钩子性质完全不同。
function Get-IdleMs {
  try {
    $lii = New-Object 'ZhizhiWin32+LASTINPUTINFO'
    $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'ZhizhiWin32+LASTINPUTINFO')
    if (-not [ZhizhiWin32]::GetLastInputInfo([ref]$lii)) { return $null }
    $idle = [int64][Environment]::TickCount - [int64]$lii.dwTime
    if ($idle -lt 0) { return $null }   # TickCount 回绕（约 25 天不重启才可能），宁可这次不喂
    return $idle
  } catch {
    Write-ZhiLog ('[ERR] 取空闲时长失败：' + $_.Exception.Message)
    return $null
  }
}

function Feed-Idle {
  if ($null -eq $script:kernel -or $script:kernel.HasExited) { return }
  $idle = Get-IdleMs
  if ($null -eq $idle) { return }
  try {
    # 一行一个 JSON 对象，与内核约定的上下文协议（{"idleMs":<非负毫秒>}）
    $script:kernel.StandardInput.WriteLine('{"idleMs":' + $idle + '}')
  } catch {
    Write-ZhiLog ('[ERR] 喂 idleMs 失败（闲聊会静默，监控不受影响）：' + $_.Exception.Message)
  }
}

# 「说说」按钮：请内核现在就说一句（{"requestSay":true}）—— 用户指令，内核照样走标准出口
function Feed-RequestSay {
  if ($null -eq $script:kernel -or $script:kernel.HasExited) { return $false }
  try {
    $script:kernel.StandardInput.WriteLine('{"requestSay":true}')
    return $true
  } catch {
    Write-ZhiLog ('[ERR] 发送 requestSay 失败：' + $_.Exception.Message)
    return $false
  }
}

# 主循环每 200ms 调一次 —— **刻意跑在 UI 线程上**（见文件头的 ⚠️⚠️ 注释）
function Poll-Kernel {
  if ($null -eq $script:kernel) { return }

  if ($null -ne $script:kernelOut -and $script:kernelOut.IsCompleted) {
    $line = $script:kernelOut.Result
    if ($null -eq $line) {
      $script:kernelOut = $null                 # EOF：不再挂新的读
    } else {
      $script:kernelOut = $script:kernel.StandardOutput.ReadLineAsync()
      Apply-SampleLine $line
    }
  }

  if ($null -ne $script:kernelErr -and $script:kernelErr.IsCompleted) {
    $line = $script:kernelErr.Result
    if ($null -eq $line) {
      $script:kernelErr = $null
    } else {
      $script:kernelErr = $script:kernel.StandardError.ReadLineAsync()
      Apply-LogLine $line
    }
  }

  # 内核意外退出了？**必须说出来**（不许静默：窗口会一直停在最后一个数字上）
  if ($script:kernel.HasExited -and -not $script:kernelDead) {
    $script:kernelDead = $true
    Write-ZhiLog ('[ERR] 内核退出了（退出码 ' + $script:kernel.ExitCode + '）—— 数据不再更新')
    $lblCpuV.Text = '—'
    $lblMemV.Text = '—'
    Show-ErrorHint '内核退出，数据已停'
  }
}

# ─────────────────────────────── 建窗 ───────────────────────────────

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition   = 'Manual'
$form.BackColor       = $cCard
$form.ShowInTaskbar   = $false
$form.Text            = '只只 · 最小可用外壳'

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
# 只只说的话（M4-a）：内核 stderr 里的「只只说了…」会显示到这里
$lblSaid  = New-Label '（正在看着这台机器…）' $cInk 'MiddleLeft'

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
  $lblTitle, $lblPos, $lblCpuK, $lblCpuV, $lblMemK, $lblMemV, $lblSaid,
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

  # 主区高度：M4-a 起多了一行「只只说的话」，146 → 170
  $mainH = [int][Math]::Round(170 * $k)
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

  # 只只说的话（M4-a 新增）—— 它是这个窗口里唯一「有温度」的一行
  Set-Bounds $lblSaid (16 * $k) (106 * $k) (212 * $k) (20 * $k)
  $lblSaid.Font = $fSmall

  Set-Bounds $btnSay   (16 * $k)  (134 * $k) (50 * $k) (26 * $k)
  Set-Bounds $btnQuiet (70 * $k)  (134 * $k) (50 * $k) (26 * $k)
  Set-Bounds $btnPos   (124 * $k) (134 * $k) (50 * $k) (26 * $k)
  Set-Bounds $btnSet   (178 * $k) (134 * $k) (50 * $k) (26 * $k)
  foreach ($b in @($btnSay, $btnQuiet, $btnPos, $btnSet)) { $b.Font = $fSmall }

  Set-Bounds $btnClose (206 * $k) (11 * $k) (24 * $k) (22 * $k)
  $btnClose.Font = $fSmall

  # —— 设置面板：行 178 / 204 / 230 / 256（M4-a 因主区多一行整体下移 24），按钮组右对齐到 228 ——
  $rows = @(178, 204, 230, 256)
  $lbls = @($lblSize, $lblOpa, $lblTop, $lblRem)
  for ($i = 0; $i -lt 4; $i++) {
    $c = $lbls[$i]
    Set-Bounds $c (16 * $k) ($rows[$i] * $k) (68 * $k) (22 * $k)
    $c.Font = $fSmall
  }
  # 三选一行（尺寸 / 透明）：x = 96 / 141 / 186（宽 42）
  $x3 = @(96, 141, 186)
  $three = @(
    @{ y = 178; btns = @($btnSizeSm, $btnSizeMd, $btnSizeLg) },
    @{ y = 204; btns = @($btnOpaThin, $btnOpaMid, $btnOpaSolid) }
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
    @{ y = 230; btns = @($btnTopOn, $btnTopOff) },
    @{ y = 256; btns = @($btnRemOn, $btnRemOff) }
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
  $parts = @((Get-PositionLabel $Position))
  if ($script:nodeExe) {
    if ($script:nodeInfo.Score -lt 2218) { $parts += ('node 版本过低(' + $script:nodeInfo.Raw + ')') }
    else { $parts += ('node ' + $script:nodeInfo.Raw) }
  } else {
    $parts += 'node 未找到'
  }
  # 内核活着的话，把「已经看了几轮」报出来 —— 这是窗口活着最直观的证据
  if ($script:kernelDead) { $parts += '内核已停' }
  elseif ($script:kernelLines -gt 0) { $parts += ('已看 ' + $script:kernelLines + ' 轮') }
  if ($script:stateText) { $parts += $script:stateText }
  $lblPos.Text = ($parts -join ' · ')
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

# 内核参数（命令行给的，或默认）—— M4-a：这个窗口会自己把内核拉起来
$script:kernelIntervalMs = 2000
if ($Interval -gt 0) { $script:kernelIntervalMs = $Interval }
$script:kernelSustainMs = $SustainMs
$script:kernelCooldownMs = $CooldownMs

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
    if (Feed-RequestSay) { Set-StatusText '（去说了，等它回话…）' }
    else { Set-StatusText '（内核没在跑，叫不动）' }
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

# 关窗时：收掉内核 sidecar + 停掉轮询与喂食 + 记住位置
$form.Add_FormClosing({
  try {
    if ($null -ne $script:metricsTimer) { $script:metricsTimer.Stop() }
    if ($null -ne $script:idleTimer) { $script:idleTimer.Stop() }
    Stop-Kernel            # ⚠️ 必须收 —— 不然会在后台留一个孤儿的 node 进程
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
  Write-Host '=== 只只 · 最小可用外壳 自检（M4-a）===' -ForegroundColor Cyan
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

  # ── 内核 sidecar + 长连接读流（M4-a 的**真机制**；不再是一次性采样）──
  Write-Host ''
  Write-Host '--- 流式读内核（sidecar + 长连接，M4-a 真机制）---' -ForegroundColor Cyan
  $script:kernelIntervalMs = 400      # 自检只为快，不代表产品默认值
  Start-Kernel
  if ($null -ne $script:kernel) {
    Write-Host ("  sidecar PID  : " + $script:kernel.Id)
    $t0 = Get-Date
    while ($script:kernelLines -lt 3 -and ((Get-Date) - $t0).TotalSeconds -lt 12) {
      Poll-Kernel
      Start-Sleep -Milliseconds 120
    }
    Write-Host ("  收到采样     : " + $script:kernelLines + " 条（CPU " + $lblCpuV.Text + " / MEM " + $lblMemV.Text + "）")
    Write-Host ("  只只说的话   : " + $lblSaid.Text)
    $fed = Get-IdleMs
    Feed-Idle             # 反向通道冒烟：真往 stdin 写一行，写不进去会记日志
    Write-Host ("  反向通道     : GetLastInputInfo=" + $(if ($null -eq $fed) { '失败' } else { "$fed ms" }) + " · 已往 stdin 喂 1 次")
    [void](Feed-RequestSay)   # 「说说」链路冒烟：应立刻回一句闲聊（走 stdout 的 type:"event"）
    $t1 = Get-Date
    while ($script:eventLines -lt 1 -and ((Get-Date) - $t1).TotalSeconds -lt 5) {
      Poll-Kernel
      Start-Sleep -Milliseconds 120
    }
    Write-Host ("  说说应答     : " + $(if ($script:eventLines -ge 1) { $lblSaid.Text } else { '（5 秒内没等到回话 → 异常）' }))
    Stop-Kernel
    Write-Host ("  内核已收掉   : " + ($null -eq $script:kernel))
  } else {
    Write-Host '  ⚠️ 内核没起来（详情见日志）' -ForegroundColor Red
  }

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

# ───────────── M4-a：窗口自己把内核拉起来，并开始长连接读它的流 ─────────────
# 轮询跑在 **UI 线程的 Timer** 上（刻意如此，见文件头 ⚠️⚠️）：
# 不用线程池、不用 add_OutputDataReceived —— 那条路在 PowerShell 里必炸。
Start-Kernel
$script:metricsTimer = New-Object System.Windows.Forms.Timer
$script:metricsTimer.Interval = 200
$script:metricsTimer.Add_Tick({
  try { Poll-Kernel } catch { Report-HandlerError 'poll-kernel' $_ }
})
$script:metricsTimer.Start()

# M6 反向通道：每秒把空闲时长喂给内核（同样跑在 UI 线程的 Timer 上）
$script:idleTimer = New-Object System.Windows.Forms.Timer
$script:idleTimer.Interval = 1000
$script:idleTimer.Add_Tick({
  try { Feed-Idle } catch { Report-HandlerError 'feed-idle' $_ }
})
$script:idleTimer.Start()

# ─────────────────────── 渲染检查模式（-RenderCheck）───────────────────────
# 为什么需要它：-SelfTest **不弹窗 = 不绘制**，因此「画字失败」这类缺陷它抓不到。
# 2026-10-14 的「满屏红叉」正是这么漏过去的 —— 补一个真开窗、只数错的回归模式。
if ($RenderCheck) {
  # 只读标志已在脚本开头设好（不能在这儿设 —— 太晚，那时设置可能已经被写过了）
  $script:renderErrors = -1
  $script:renderSize = ''
  $shotPath = Join-Path $script:SCRIPT_DIR 'float-preview.render.png'
  $shotTimer = New-Object System.Windows.Forms.Timer
  # 默认 2600ms 是**刻意等够**的：内核默认 2000ms 出第一条采样，等它落进标签里再截图 ——
  # 否则截到的是一张「—」的空图，看不出渲染对不对。
  $shotTimer.Interval = $ShotDelayMs
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

Write-Host '=== 只只 · 最小可用外壳（M4-a）===' -ForegroundColor Cyan
Write-Host ("位置        : " + (Get-PositionLabel $Position) + "   （点「位置」按钮可轮换；开了「记住位置」就记你拖到哪）")
Write-Host ("内核        : 已作为 sidecar 启动 —— 每 " + $script:kernelIntervalMs + " ms 采一次，数据实时刷到窗口上")
Write-Host ("只只会说话  : 默认「连续超标 2 分钟」才开口；想快点看到它说话就加 -SustainMs 3000 -CooldownMs 5000")
Write-Host ("设置        : 点「设置」原地展开；自动存到 " + $script:SETTINGS_PATH)
Write-Host ("node        : " + $(if ($script:nodeExe) { $script:nodeExe + ' ' + $script:nodeInfo.Raw } else { '未找到' }))
Write-Host '拖拽        : 按住窗口上方的「只只」文字区域可拖动'
Write-Host '关闭        : 点右上角 ✕（会顺带把内核子进程收掉）' -ForegroundColor DarkGray
Write-Host '              ⚠️ 不要在本控制台按 Ctrl+C —— 会停止 PowerShell 管道，' -ForegroundColor Red
Write-Host '                 之后浮窗点任何按钮都会报 PipelineStoppedException' -ForegroundColor Red
Write-Host ("出错        : 异常会写进 " + $script:LOG_PATH + "（不弹框、不卡死）")
Write-Host '日志        : 内核日志**实时显示在下方**（同时写一份进 tools\float-preview.log）'
Write-Host '说说        : 点浮窗「说说」= 叫它现在就说一句；闲聊节奏看 data\zhizhi.settings.json'
Write-Host ''

[void]$form.ShowDialog()
Write-Host '只只浮窗已关闭（内核 sidecar 也已收掉）。' -ForegroundColor Cyan
