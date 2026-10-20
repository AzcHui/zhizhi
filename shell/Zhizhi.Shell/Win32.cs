using System.Runtime.InteropServices;

namespace Zhizhi.Shell;

/// <summary>
/// Win32 声明 —— 只放 b1 真正用到的。
/// ⭐ 决策（2026-10-16 已定）：球要**可点**，所以只打 WS_EX_NOACTIVATE（不抢焦点），
///    **不打 WS_EX_TRANSPARENT**（穿透会让球点不着）—— 两个是不同的位，
///    「不抢焦点」不需要靠穿透实现（M3 在 PowerShell 壳上已实证这条路成立）。
/// </summary>
internal static class Win32
{
    public const int GWL_EXSTYLE = -20;
    public const nint WS_EX_NOACTIVATE = 0x0800_0000;
    public const nint WS_EX_TOOLWINDOW = 0x0000_0080;
    public const uint MAPVK_VSC_TO_VK_EX = 3;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true, EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    /// <summary>读写扩展样式 —— 32 位进程退回 SetWindowLong，64 位用 SetWindowLongPtrW。</summary>
    public static nint GetExStyle(IntPtr hWnd) =>
        IntPtr.Size == 8
            ? GetWindowLongPtr64(hWnd, GWL_EXSTYLE)
            : new IntPtr(GetWindowLong(hWnd, GWL_EXSTYLE));

    public static nint SetExStyle(IntPtr hWnd, nint newExStyle) =>
        IntPtr.Size == 8
            ? SetWindowLongPtr64(hWnd, GWL_EXSTYLE, newExStyle)
            : new IntPtr(SetWindowLong(hWnd, GWL_EXSTYLE, (int)newExStyle));

    // ── 空闲时长（只拿一个数字 —— 不是键鼠监听，M6 已定口径）───────────────
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll", SetLastError = false)]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();

    /// <summary>用户最后一次输入距今多少毫秒；失败返回 null（调用方按「不知道」处理）。</summary>
    public static double? GetIdleMs()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return null;
        var elapsed = unchecked(GetTickCount() - info.dwTime);
        return elapsed;
    }

    // ── M11-b1（二·AB）：前台窗口分类 ───────────────────────────────────────
    // ⛔ 隐私红线（结构保证）：**这里根本没有取标题的代码** —— 不 import GetWindowTextW，
    //    分类只靠「进程名 ＋ 窗口矩形 vs 显示器矩形」两个判据。标题想泄漏都没有通道。

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    private const uint MONITOR_DEFAULTTONEAREST = 2;

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public uint cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    /// <summary>会议软件进程名白名单（v1：精确等值、忽略大小写 —— 宁可漏判成 unknown，不要误伤）</summary>
    private static readonly string[] MeetingNames =
    {
        "wemeeting", "wemeetapp", "teams", "ms-teams", "zoom", "dingtalk", "feishu", "lark", "voov", "tencentmeeting",
    };

    /// <summary>IDE / 终端进程名白名单</summary>
    private static readonly string[] CodeNames =
    {
        "code", "devenv", "rider64", "idea64", "pycharm64", "webstorm64", "sublime_text", "notepad++", "windowsterminal",
    };

    /// <summary>浏览器进程名白名单</summary>
    private static readonly string[] BrowserNames = { "chrome", "msedge", "firefox", "brave", "opera" };

    /// <summary>pid → 进程名缓存（GetProcessById 每次都开句柄 —— pid 不变就不值得重复开）</summary>
    private static readonly Dictionary<int, string> ProcNameCache = new();

    /// <summary>
    /// 分类纯函数 —— 合成自测（--fg-test）直接打这里，不碰真窗口。
    /// ⚠️ 顺序是红线（易错点 2）：meeting → code → browser → **全屏** → unknown ——
    /// 进程名命中 code 就不再看全屏，否则 VS Code 按 F11 全屏写代码会被判 fullscreen → 整段不说话。
    /// </summary>
    public static string Classify(string? processName, bool fullscreen)
    {
        var name = processName?.ToLowerInvariant();
        if (name != null)
        {
            if (MeetingNames.Contains(name)) return "meeting";
            if (CodeNames.Contains(name)) return "code";
            if (BrowserNames.Contains(name)) return "browser";
        }
        // 易错点 3：Maximized ≠ 全屏 —— 调用方必须用「窗口矩形 == rcMonitor」判，不是查最大化状态
        if (fullscreen) return "fullscreen";
        // 易错点 5：取不到进程名 / 桌面 / 任务栏 → unknown，且 unknown **不构成 busy**（宁可多说一句）
        return "unknown";
    }

    /// <summary>窗口矩形是否与所在显示器矩形完全重合（真全屏；最大化只盖工作区，天然不命中）。</summary>
    private static bool IsFullscreen(IntPtr hwnd)
    {
        if (!GetWindowRect(hwnd, out var wr)) return false;
        var mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        var mi = new MONITORINFO { cbSize = (uint)Marshal.SizeOf<MONITORINFO>() };
        if (!GetMonitorInfo(mon, ref mi)) return false;
        return wr.Left == mi.rcMonitor.Left && wr.Top == mi.rcMonitor.Top
            && wr.Right == mi.rcMonitor.Right && wr.Bottom == mi.rcMonitor.Bottom;
    }

    /// <summary>
    /// 当前前台的分类结果（枚举字符串，**唯一允许跨界的东西**）。
    /// 取不到任何判据 → unknown（易错点 4：系统进程 / 已退出 / 权限不足不许抛）。
    /// </summary>
    public static string ForegroundClass()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return "unknown";
        GetWindowThreadProcessId(hwnd, out var pid);
        string? procName = null;
        if (pid > 0)
        {
            if (!ProcNameCache.TryGetValue((int)pid, out procName))
            {
                try { procName = System.Diagnostics.Process.GetProcessById((int)pid)?.ProcessName; }
                catch { procName = null; }   // 易错点 4：系统进程 / 已退出 / 权限不足 → unknown，不抛
                ProcNameCache[(int)pid] = procName ?? "";
            }
            if (procName == "") procName = null;
        }
        return Classify(procName, IsFullscreen(hwnd));
    }
}
