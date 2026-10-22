using System.IO;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Zhizhi.Shell;

/// <summary>
/// 只只的家 · 窗口（M11-c，开工单 3.1／3.2）
///
/// ⭐ 核心纪律（三条，踩一条就前功尽弃）：
///   1. **打开才创建、关窗即 Dispose** —— 不打开家 = 只有一个球 + 一个 node 进程（不新增常驻资源）；
///      WebView2 单实例 80~150MB，常驻就违背「轻」的初衷。
///   2. **家崩不许带崩浮窗/内核** —— WebView2 初始化失败 → 弹一次提示，主程序照常跑。
///   3. **不硬拼 dataDir** —— 路径由内核 hello 通告（见 HomeBridge.DataDir）。
///
/// 加载方式（不能用 file://，ES module + fetch 会被 CORS 卡死）：
///   虚拟主机映射：SetVirtualHostNameToFolderMapping("zhizhi.home", distPath)
///   → Navigate("https://zhizhi.home/index.html")
/// </summary>
internal sealed class HomeWindow : Window
{
    /// <summary>虚拟主机名（前端资源都以它为根；相对路径 base:'./' 必需）。</summary>
    public const string VirtualHost = "zhizhi.home";

    /// <summary>dist 缺失时显示的兜底提示（不白屏）。</summary>
    private const string MissingDistHtml = """
        <!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
        <style>
          body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
               font-family:"Microsoft YaHei UI",system-ui,sans-serif;background:#fff;color:#555}
          .box{text-align:center;max-width:520px;padding:24px}
          h2{color:#1f8a7a;font-size:17px;margin:0 0 12px}
          code{background:#f2f2f2;padding:3px 8px;border-radius:4px;font-size:13px}
          p{line-height:1.9;font-size:13.5px}
        </style></head><body><div class="box">
        <h2>前端还没构建</h2>
        <p>只只的家需要先构建一次前端。请在仓库根目录执行：</p>
        <p><code>pnpm build:home</code></p>
        <p>构建完重新打开这个窗口就好。</p>
        </div></body></html>
        """;

    private readonly HomeBridge _bridge;
    private WebView2? _webView;

    /// <summary>验收钩子：前端每发一条命令都会调它（cmd + 原始 JSON）。--home-test 用它判 ②③。</summary>
    public Action<string, string>? WebMessageProbe { get; set; }

    /// <summary>dist 目录（apps/home/dist）—— 找不到返回 null。</summary>
    public static string? FindDistPath()
    {
        var repo = KernelSidecar.FindRepoRoot();
        if (repo is null) return null;
        var dist = Path.Combine(repo, "apps", "home", "dist");
        return File.Exists(Path.Combine(dist, "index.html")) ? dist : null;
    }

    /// <summary>
    /// WebView2 运行时版本（null = 没装）。启动检测用。
    /// ⚠️ ⚠️ **调用前必须先过 <see cref="WebView2Preflight"/> 的预检** ——
    ///   本方法体引用了 CoreWebView2Environment，托管 DLL 缺失时 **JIT 阶段就会抛
    ///   FileNotFoundException**（进不到我们自己的检查里）。详见 WebView2Preflight 的注释。
    /// </summary>
    public static string? GetRuntimeVersion()
    {
        try
        {
            var v = CoreWebView2Environment.GetAvailableBrowserVersionString();
            return string.IsNullOrEmpty(v) ? null : v;
        }
        catch
        {
            return null;
        }
    }

    public HomeWindow(HomeBridge bridge)
    {
        _bridge = bridge;

        Title = "只只的家";
        Width = 900;
        Height = 640;
        MinWidth = 760;
        MinHeight = 520;
        WindowStyle = WindowStyle.SingleBorderWindow;
        ResizeMode = ResizeMode.CanResize;
        ShowInTaskbar = true;      // 与浮窗相反 —— 家要能 Alt+Tab 切到、能关
        Topmost = false;           // 浮窗才置顶，两者别混
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = System.Windows.Media.Brushes.White;

        RestoreGeometry();

        Loaded += OnWindowLoaded;
    }

    /// <summary>恢复上次的位置尺寸（shell.json）；没有/越界 → 居中 + 默认尺寸。</summary>
    private void RestoreGeometry()
    {
        var saved = ShellSettings.TryLoad();
        if (saved?.HomeWidth is { } w && saved.HomeHeight is { } h
            && double.IsFinite(w) && double.IsFinite(h) && w >= 400 && h >= 300)
        {
            Width = w;
            Height = h;
        }
        if (saved?.HomeLeft is { } l && saved.HomeTop is { } t
            && double.IsFinite(l) && double.IsFinite(t))
        {
            // 越界（换分辨率/拔副屏）→ 回落居中，别把窗口开在看不见的地方
            var wa = SystemParameters.WorkArea;
            if (new Rect(l, t, Width, Height).IntersectsWith(wa))
            {
                Left = l;
                Top = t;
                WindowStartupLocation = WindowStartupLocation.Manual;
            }
        }
    }

    /// <summary>关窗时把位置尺寸存回 shell.json（与球的存档同一份文件，合并写）。</summary>
    private void SaveGeometry()
    {
        try
        {
            var old = ShellSettings.TryLoad();
            new ShellSettings
            {
                BallLeft = old?.BallLeft,
                BallTop = old?.BallTop,
                MuteUntil = old?.MuteUntil ?? 0,
                HomeLeft = double.IsFinite(Left) ? Left : null,
                HomeTop = double.IsFinite(Top) ? Top : null,
                HomeWidth = double.IsFinite(Width) ? Width : null,
                HomeHeight = double.IsFinite(Height) ? Height : null,
            }.TrySave();
        }
        catch (Exception ex)
        {
            ShellLog.Write($"[WRN] 存家的位置尺寸失败：{ex.Message}");
        }
    }

    /// <summary>
    /// 窗口显示后初始化 WebView2。
    /// ⚠️ 用 **Loaded 事件**而不是 OnContentRendered —— 后者在 Content 为 null 时**根本不触发**
    ///   （而 WebView2 控件是在 InitWebViewAsync 里才创建的 → 鸡生蛋）。踩过这个坑。
    ///   （OnLoaded 也不是 virtual，WPF 没有这个重写点 —— 用事件。）
    /// </summary>
    private bool _initStarted;

    private void OnWindowLoaded(object sender, RoutedEventArgs e)
    {
        if (_initStarted) return;   // Loaded 可能触发多次
        _initStarted = true;
        _ = InitAsync();
    }

    private async Task InitAsync()
    {
        try
        {
            await InitWebViewAsync();
        }
        catch (Exception ex)
        {
            // 纪律②：家崩不许带崩浮窗/内核 —— 这里只提示，不往上抛
            ShellLog.Write($"[ERR] 只只的家初始化失败：{ex.Message}");
            ShowFallback($"初始化失败：{ex.Message}");
        }
    }

    private async Task InitWebViewAsync()
    {
        var dist = FindDistPath();
        if (dist is null)
        {
            // 纪律：不白屏 —— 给一句人话
            ShowFallback(MissingDistHtml);
            ShellLog.Write("[WRN] 只只的家：apps/home/dist 不存在，显示未构建提示");
            return;
        }

        // ⚠️ 前置自检：**必须在碰任何 WebView2 类型之前**（含 GetRuntimeVersion —— 它内部
        //   引用 CoreWebView2Environment，托管 DLL 缺失时 JIT 阶段就抛，压根到不了这里）。
        //   不做这一步的话，用户看到的是 .NET 的
        //   「Could not load file or assembly 'Microsoft.Web.WebView2.Core'…系统找不到指定的文件」
        //   —— 那是天书，而且用户会以为是「程序坏了」而不是「构建没带全依赖」。
        var missing = WebView2Preflight.FindMissingAssemblies();
        if (missing.Count > 0)
        {
            ShowFallback(WebView2Preflight.BuildMissingHintHtml(missing));
            ShellLog.Write($"[ERR] 只只的家：缺 WebView2 托管 DLL —— {string.Join("、", missing)}（构建产物不完整）");
            return;
        }

        var runtime = GetRuntimeVersion();
        if (runtime is null)
        {
            ShowFallback("<h2>没装 WebView2 运行时</h2><p>请到微软官网安装 Evergreen Runtime：<br><code>https://developer.microsoft.com/microsoft-edge/webview2/</code></p>");
            ShellLog.Write("[ERR] 只只的家：WebView2 运行时缺失");
            return;
        }

        // ⚠️ 用户数据目录必须显式指定 —— 默认会写进 exe 同目录（Zhizhi.Shell.exe.WebView2\），污染代码目录
        var userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "zhizhi", "webview2");
        Directory.CreateDirectory(userData);

        var env = await CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder: userData,
            options: null);

        _webView = new WebView2 { DefaultBackgroundColor = System.Drawing.Color.White };
        Content = _webView;
        await _webView.EnsureCoreWebView2Async(env);

        // 目录映射成虚拟主机（file:// 走不通，必须虚拟主机）
        // ⚠️ 资源访问级别用 **Allow** —— DenyCors 会让 postMessage 的目标源判定失败
        //   （回包抛 "Value does not fall within the expected range"）。虚拟主机是**本机**映射，
        //   不开监听端口、不对外暴露，没有安全面变大问题。
        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            VirtualHost, dist, CoreWebView2HostResourceAccessKind.Allow);

        // 桥：前端 postMessage 进来 → HomeBridge 分发；回包走 PostWebMessageAsJson
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        _webView.CoreWebView2.NavigationCompleted += (_, args) =>
        {
            ShellLog.Write($"[家] 导航完成：成功={args.IsSuccess} 状态={args.WebErrorStatus}");
        };
        _webView.CoreWebView2.ProcessFailed += (_, e) =>
        {
            ShellLog.Write($"[ERR] 只只的家 WebView2 进程崩了：{e.ProcessFailedKind}（退出码 {e.ExitCode}）");
        };

        // 取证：把前端 console 转发到外壳日志（这个 WebView2 版本没有 ConsoleMessageReceived 事件，
        //   所以用注入脚本的方式捕获 —— 装一次 debug 用，别删：它是「前端到底跑没跑」的唯一证据）
        try
        {
            const string probe = @"
(function () {
  const orig = console.log;
  console.log = function () {
    try {
      const parts = Array.prototype.map.call(arguments, function (a) {
        return typeof a === 'string' ? a : JSON.stringify(a);
      });
      window.chrome.webview.postMessage({ cmd: '__console', text: parts.join(' ') });
    } catch (e) { }
    return orig.apply(console, arguments);
  };
})();
";
            await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(probe);
        }
        catch (Exception ex)
        {
            ShellLog.Write($"[WRN] 注入 console 捕获器失败：{ex.Message}");
        }

        _webView.CoreWebView2.Navigate($"https://{VirtualHost}/index.html");
        ShellLog.Write($"只只的家已打开（WebView2 运行时 {runtime}，dist={dist}）");
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            // ⚠️ **前端必须发 JSON 字符串** —— WebView2 的 TryGetWebMessageAsString
            //   收到**对象**时会抛 "Value does not fall within the expected range"（且不说明原因）。
            //   所以前端 postMessage 传 JSON.stringify(...) 的结果（见 bridge.ts 的 send()）。
            string json;
            try
            {
                json = e.TryGetWebMessageAsString();
            }
            catch (Exception ex)
            {
                ShellLog.Write($"[ERR] 只只的家收消息失败（前端传了非字符串？）：{ex.Message}");
                return;
            }
            if (string.IsNullOrEmpty(json)) return;
            // 验收钩子（生产环境为 null，不产生开销）
            try
            {
                using var probeDoc = System.Text.Json.JsonDocument.Parse(json);
                var probeCmd = probeDoc.RootElement.TryGetProperty("cmd", out var pc) ? pc.GetString() ?? "" : "";
                if (probeCmd != "__console") ShellLog.Write($"[家] 收到前端消息：{probeCmd}");
                else
                {
                    var consoleText = probeDoc.RootElement.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "";
                    ShellLog.Write($"[家·前端] {consoleText}");
                }
                WebMessageProbe?.Invoke(probeCmd, json);
            }
            catch { /* 探针自己解析失败不影响主链 */ }
            // ⚠️ 一条命令可能回多条（ready → overview + pools + history）—— 逐条发
            // ⚠️ **必须 Post 到 Dispatcher 队列**（不能在 WebMessageReceived 事件栈里同步回包）——
            //   同步回包在虚拟主机源下会抛 "Value does not fall within the expected range"（实测踩过）。
            var replies = _bridge.Handle(json);
            if (replies.Count == 0) return;
            Dispatcher.BeginInvoke(new Action(() =>
            {
                foreach (var reply in replies)
                {
                    try
                    {
                        _webView?.CoreWebView2.PostWebMessageAsString(reply);
                    }
                    catch (Exception ex)
                    {
                        ShellLog.Write($"[ERR] 回包给前端失败：{ex.Message}");
                    }
                }
            }));
        }
        catch (Exception ex)
        {
            ShellLog.Write($"[ERR] 只只的家消息处理出错：{ex.Message}");
        }
    }

    /// <summary>验收用：截图（WebView2 的 CapturePreviewAsync —— 比 WPF RenderTargetBitmap 靠谱，
    /// 因为 WebView2 是「合成」内容，不在 WPF 的视觉树里，RenderTargetBitmap 拍不到）。
    /// ⚠️ API 是 async（CoreWebView2.CapturePreviewAsync(format, stream)）。</summary>
    public async Task<bool> CaptureToAsync(string path)
    {
        var wv = _webView;
        if (wv?.CoreWebView2 is null) return false;
        try
        {
            using var ms = new MemoryStream();
            await wv.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
            var bytes = ms.ToArray();
            if (bytes.Length == 0) return false;
            File.WriteAllBytes(path, bytes);
            return true;
        }
        catch (Exception ex)
        {
            ShellLog.Write($"[WRN] 截图失败：{ex.Message}");
            return false;
        }
    }

    /// <summary>验收用：让前端切到某个页签（点击 tab）—— 用来逐页截图复核。</summary>
    public async Task SwitchTabAsync(int index)
    {
        var wv = _webView;
        if (wv?.CoreWebView2 is null) return;
        try
        {
            await wv.CoreWebView2.ExecuteScriptAsync(
                $"document.querySelectorAll('.tab')[{index}] && document.querySelectorAll('.tab')[{index}].click()");
        }
        catch (Exception ex)
        {
            ShellLog.Write($"[WARN] 切页签失败：{ex.Message}");
        }
    }

    /// <summary>验收用：WebView2 是否已经初始化好。</summary>
    public bool IsWebViewReady => _webView?.CoreWebView2 is not null;

    /// <summary>验收用：页面标题（用来确认 dist 真的加载了）。</summary>
    public string PageTitle => _webView?.CoreWebView2?.DocumentTitle ?? "";

    /// <summary>把一条 JSON 消息推给前端（外壳 → 前端方向）。</summary>
    public void PostMessage(string json)
    {
        var wv = _webView;
        if (wv is null) return;
        wv.CoreWebView2.PostWebMessageAsJson(json);
    }

    /// <summary>兜底：dist 没构建 / 运行时缺失 / 初始化失败时显示一段提示（**不白屏**）。
    /// ⚠️ 用纯 WPF 控件（TextBlock）而不是 WebBrowser —— WPF 没有 DocumentText（那是 WinForms 的）。</summary>
    private void ShowFallback(string html)
    {
        try
        {
            var title = "只只的家";
            var body = html;
            // 从提示 HTML 里抠出可读文字（我们自己的兜底内容，格式固定 —— 不引正则库）
            var idx = html.IndexOf('>');
            if (idx > 0 && html.Contains("</h2>"))
            {
                var h2 = html.Substring(html.IndexOf("<h2>") + 4, html.IndexOf("</h2>") - html.IndexOf("<h2>") - 4);
                var pStart = html.IndexOf("<p>");
                var pEnd = html.IndexOf("</p>");
                if (pStart >= 0 && pEnd > pStart)
                {
                    var pText = html.Substring(pStart + 3, pEnd - pStart - 3);
                    pText = pText.Replace("<br>", "\n").Replace("<code>", "「").Replace("</code>", "」");
                    body = pText;
                }
                title = h2;
            }

            var panel = new StackPanel { Margin = new Thickness(40) };
            panel.Children.Add(new TextBlock
            {
                Text = title,
                FontSize = 17,
                FontWeight = FontWeights.SemiBold,
                Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x1F, 0x8A, 0x7A)),
                Margin = new Thickness(0, 0, 0, 12),
            });
            panel.Children.Add(new TextBlock
            {
                Text = body,
                FontSize = 13.5,
                TextWrapping = TextWrapping.Wrap,
                Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x55, 0x55, 0x55)),
            });
            Content = new Border { Background = System.Windows.Media.Brushes.White, Child = panel };
        }
        catch (Exception ex)
        {
            // 连兜底 UI 都建不出来 → 退到一句系统提示
            ShellLog.Write($"[ERR] 只只的家兜底界面失败：{ex.Message}");
            MessageBox.Show("只只的家打不开（WebView2 组件异常）。", "只只", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        // 纪律①：关窗即 Dispose —— 内存还回系统（msedgewebview2.exe 进程消失）
        try
        {
            if (_webView is not null)
            {
                _webView.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
                _webView.Dispose();
                _webView = null;
            }
        }
        catch (Exception ex)
        {
            ShellLog.Write($"[WRN] 释放 WebView2 时出错：{ex.Message}");
        }
        SaveGeometry();
        ShellLog.Write("只只的家已关闭（WebView2 已释放）");
        base.OnClosed(e);
    }
}
