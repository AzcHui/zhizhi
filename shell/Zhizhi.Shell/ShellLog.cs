using System.IO;

namespace Zhizhi.Shell;

/// <summary>
/// 外壳落盘日志（观察⑤：关键动作必须有据可查 —— 此前 Poke() 只写内存，
/// 「到底执行没执行」事后无据，排查全靠反推）。
/// ⚠️ 写失败绝不抛 —— 日志是辅助，不能让它带崩外壳。
/// </summary>
internal static class ShellLog
{
    /// <summary>由 Program 在入口处赋值；为 null = 尚未初始化（只进内存缓冲）。</summary>
    public static string? FilePath { get; set; }

    private static readonly object Lock = new();

    public static void Write(string msg)
    {
        var path = FilePath;
        if (path is null) return;
        try
        {
            lock (Lock)
            {
                File.AppendAllText(path, $"[{DateTime.Now:HH:mm:ss}] {msg}{Environment.NewLine}");
            }
        }
        catch
        {
            // 盘写不动（占用/权限）就放弃 —— 不影响外壳运行
        }
    }
}
