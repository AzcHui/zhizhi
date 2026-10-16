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
}
