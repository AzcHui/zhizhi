using System.IO;
using System.Text.Json;

namespace Zhizhi.Shell;

/// <summary>
/// 外壳自己的设置（<c>%APPDATA%\zhizhi\shell.json</c>）—— 位置记忆 ＋ 静音状态。
/// b2-a 口径（决策见进度报表开工单）：
///   - 存用户目录，**不放代码目录** —— 换目录/升级不丢，也不需要管理员权限；
///   - **只在拖动结束与关窗时写**，绝不在 MouseMove 里写（旧壳踩过：点着玩 = 高频写盘）；
///   - 读坏了 / 不存在 = 返回 null，调用方回落默认位置 —— 外壳绝不因设置文件崩。
/// </summary>
internal sealed class ShellSettings
{
    /// <summary>球的屏幕位置（b2-a 复验起改存球 —— 窗口锚可垂直翻转，窗口坐标不是稳定参照）。
    /// nullable：null = 旧版档案（无此字段）→ 调用方回落默认位置。</summary>
    public double? BallLeft { get; set; }
    public double? BallTop { get; set; }

    /// <summary>静音截止时刻（epoch ms）；0 = 未静音。重启后仍然静音、到点自然失效。</summary>
    public long MuteUntil { get; set; }

    /// <summary>唯一事实源 —— FloatWindow 不许自己再拼一遍（b2-a 复验小项2：只改一处）。</summary>
    internal static string DefaultPath =>
        System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "zhizhi", "shell.json");

    /// <summary>读设置；文件不存在 / 损坏 / 字段缺失 → null（调用方回落默认）。绝不抛。</summary>
    public static ShellSettings? TryLoad(string? path = null)
    {
        var p = path ?? DefaultPath;
        try
        {
            if (!File.Exists(p)) return null;
            return JsonSerializer.Deserialize<ShellSettings>(File.ReadAllText(p));
        }
        catch (Exception e)
        {
            ShellLog.Write($"[WRN] 读设置失败（回落默认）：{e.Message}");
            return null;
        }
    }

    /// <summary>落盘；目录不存在就建。失败只记日志 —— 写不进去不该崩壳。</summary>
    public void TrySave(string? path = null)
    {
        var p = path ?? DefaultPath;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            File.WriteAllText(p, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception e)
        {
            ShellLog.Write($"[WRN] 写设置失败：{e.Message}");
        }
    }
}
