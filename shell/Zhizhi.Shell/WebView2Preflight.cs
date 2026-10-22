using System.IO;

namespace Zhizhi.Shell;

/// <summary>
/// ⭐ WebView2 依赖预检（2026-10-22 P0 根治 · 第二层）。
///
/// ⚠️⚠️ **为什么必须单独成文件、且不碰任何 WebView2 类型**：
///   .NET 的 JIT 是**按方法**编译的 —— 只要方法体里出现了 `CoreWebView2Environment`
///   这类 WebView2 类型，**进入该方法的那一刻** CLR 就要解析 WebView2 程序集。
///   托管 DLL 缺失 → 直接抛 FileNotFoundException（"Could not load file or assembly
///   'Microsoft.Web.WebView2.Core'…系统找不到指定的文件"），
///   **压根到不了我们自己的检查逻辑**（实测踩过：把自检写在 HomeWindow 里，
///   调 GetRuntimeVersion() 就先炸了，检查代码是死代码）。
///   所以：自检必须放在**任何 WebView2 类型都不出现**的地方 —— 本文件只碰 System.IO。
///
/// ⚠️ 这个坑的来龙去脉（别再问「为什么缺 DLL」）：
///   · Microsoft.Web.WebView2 包的托管 DLL **不在 lib/**，而在 **lib_manual/**（非标准布局）；
///   · 靠包自己的 buildTransitive/*.targets 用 &lt;Reference&gt; 注入 —— 走 RAR（ResolveAssemblyReference）；
///   · RAR 有**增量缓存**（obj/…/Zhizhi.Shell.csproj.AssemblyReference.cache）；
///   · 缓存命中（如：先构建/publish 到别的目录，再增量构建回默认输出）→ RAR 不重新解析
///     → ReferenceCopyLocalPaths 为空 → **三个 Microsoft.Web.WebView2.*.dll 不被复制到输出目录**；
///   · 结果：验收跑的是干净产物（--home-test 全绿），用户双击 bin/Debug 的 exe 就报「找不到文件」。
///   · 第一层修法在 csproj（CopyToOutputDirectory=Always，绕开 RAR 增量判断）；
///     本类是第二层兜底 —— 万一产物还是缺（老包/半旧目录/换机器），至少给一句人话。
/// </summary>
internal static class WebView2Preflight
{
    /// <summary>必需的托管程序集（Core 是底座，Wpf 是本项目的宿主封装）。</summary>
    private static readonly string[] RequiredAssemblies =
    {
        "Microsoft.Web.WebView2.Core.dll",
        "Microsoft.Web.WebView2.Wpf.dll",
    };

    /// <summary>
    /// 查 WebView2 托管 DLL 是否齐备（只看 exe 同目录）。
    /// 缺失时返回缺失的文件名清单；齐备返回空列表。
    /// ⚠️ **只做文件存在性检查** —— 不加载、不反射、不碰 WebView2 任何类型。
    /// </summary>
    public static IReadOnlyList<string> FindMissingAssemblies()
    {
        var missing = new List<string>();
        try
        {
            var baseDir = AppContext.BaseDirectory;
            foreach (var name in RequiredAssemblies)
            {
                if (!File.Exists(Path.Combine(baseDir, name))) missing.Add(name);
            }
        }
        catch (Exception ex)
        {
            // 连查文件都失败（权限/路径怪）→ 当作缺，别让预检本身把外壳带崩
            missing.Add($"（检查失败：{ex.Message}）");
        }
        return missing;
    }

    /// <summary>
    /// 缺依赖时给用户看的一段人话（HTML；由 HomeWindow.ShowFallback 渲染）。
    /// ⚠️ 用普通字符串拼接（不用 raw string + 插值）—— 少一层转义地雷。
    /// </summary>
    public static string BuildMissingHintHtml(IReadOnlyList<string> missing)
    {
        var files = string.Join("、", missing);
        return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
            + "<style>"
            + "body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;"
            + "font-family:\"Microsoft YaHei UI\",system-ui,sans-serif;background:#fff;color:#555}"
            + ".box{text-align:center;max-width:560px;padding:24px}"
            + "h2{color:#c0392b;font-size:17px;margin:0 0 12px}"
            + "code{background:#f2f2f2;padding:3px 8px;border-radius:4px;font-size:13px}"
            + "p{line-height:1.9;font-size:13.5px}"
            + "</style></head><body><div class=\"box\">"
            + "<h2>外壳缺依赖，装不上浏览器内核</h2>"
            + "<p>少了这些文件：" + files + "。<br>这是构建产物不完整（不是只只本身坏了）。<br>"
            + "请在仓库根目录重新构建：<code>dotnet build shell/Zhizhi.Shell -c Debug</code></p>"
            + "</div></body></html>";
    }
}
