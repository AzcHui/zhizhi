using Microsoft.Win32;

namespace Zhizhi.Shell;

/// <summary>
/// 开机自启（b2-b1 ③）：写 <c>HKCU\Software\Microsoft\Windows\CurrentVersion\Run</c>。
/// 口径（开工单）：**默认关闭** —— 自启是侵入性的，用户在托盘勾了才写；HKCU 不需要管理员。
/// 路径用 <see cref="Environment.ProcessPath"/>（当前 exe 全路径；开发期即 bin 目录，发布归 b2-b3）。
/// </summary>
internal static class AutoStart
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "zhizhi";

    /// <summary>当前是否已启用（值存在且指向当前 exe —— 换了 exe 路径视为未启用，勾选时会重写）。</summary>
    public static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(ValueName) is string v && v == ExePath();
        }
        catch
        {
            return false;   // 读不了 = 当没启用 —— 勾选时会重写，不崩
        }
    }

    /// <summary>勾选/取消。失败向上抛（托盘菜单点击处有 UI 反馈）。</summary>
    public static void SetEnabled(bool on)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (on) key.SetValue(ValueName, ExePath());
        else key.DeleteValue(ValueName, throwOnMissingValue: false);
    }

    private static string ExePath() =>
        Environment.ProcessPath ?? System.Reflection.Assembly.GetExecutingAssembly().Location;
}
