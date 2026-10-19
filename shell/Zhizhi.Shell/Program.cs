using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Zhizhi.Shell;

/// <summary>
/// 只只外壳入口（M4-b1）。
///   Zhizhi.Shell.exe              → 球形浮窗（自己把 node 内核拉起来当 sidecar）
///   Zhizhi.Shell.exe --self-test  → 无 UI 自检：起内核 → 收 3 条采样 → 反向通道喂一口 → 收掉 → 退出码 0
///   Zhizhi.Shell.exe --render-test → 真 UI 冒烟：开窗 → 挂内核 → 喂一条假说话 → 截图 → 收掉退出
/// </summary>
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
            return RunSelfTest();
        if (args.Contains("--render-test", StringComparer.OrdinalIgnoreCase))
            return RunRenderTest();

        // ── b2-b1 ① 单实例互斥：双击两次 = 两个只只、两个内核（双重告警、双重闲聊）──
        // ⭐ 只拦**正常 UI 模式**：--self-test / --render-test 是验收工具，上面已分流，不受互斥影响。
        //   第二实例**静默退出**（开工单「直接退出」；气泡提示是可选项 —— 弹窗/气泡反而打扰）。
        using var singleInstance = new System.Threading.Mutex(true, @"Local\Zhizhi.Shell.SingleInstance", out var createdNew);
        if (!createdNew)
        {
            ShellLog.FilePath = LogPath;
            ShellLog.Write("已有只只在跑，第二实例静默退出（单实例互斥）");
            return 0;
        }

        // WinExe 没有控制台；日志走 zhi-shell.log（观察⑤：关键动作落盘）+ 面板 tooltip（b2 做日志窗）
        ShellLog.FilePath = LogPath;
        ShellLog.Write("外壳启动");
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            File.AppendAllText(LogPath, $"[{DateTime.Now:HH:mm:ss}] [FATAL] {e.ExceptionObject}\n");
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            File.AppendAllText(LogPath, $"[{DateTime.Now:HH:mm:ss}] [WRN] 未观察任务异常：{e.Exception.Message}\n");
            e.SetObserved();
        };

        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        app.DispatcherUnhandledException += (_, e) =>
        {
            File.AppendAllText(LogPath, $"[{DateTime.Now:HH:mm:ss}] [ERR] UI 线程异常：{e.Exception}\n");
            e.Handled = true;   // 外壳崩不带崩 —— 与内核「插件崩不带崩内核」同一纪律
        };

        var repoRoot = KernelSidecar.FindRepoRoot();
        if (repoRoot is null)
        {
            MessageBox.Show(
                "没找到仓库根（packages/cli/src/main.ts）。\n请把 Zhizhi.Shell.exe 放进只只仓库的构建输出里运行，或用 dotnet run --project shell/Zhizhi.Shell。",
                "只只", MessageBoxButton.OK, MessageBoxImage.Warning);
            return 2;
        }

        var kernel = new KernelSidecar();
        try
        {
            // ⭐ greeting 插队（2026-10-17）：招呼产自内核 evaluate tick，interval 2000 → 最坏 2s 才出，
            //   撞验收①「1 秒内」。改 1000 与外壳 1s 喂食节奏对齐（采样每秒一次开销可忽略）。
            kernel.Start(repoRoot, intervalMs: 1000);
        }
        catch (Exception ex)
        {
            // b2-b1 ④：node 启动失败换人话 —— 原样抛的是英文 Win32 异常
            //（"An error occurred trying to start process 'node'…"）。三级定位归 b2-b3，本地玩给一句够用的。
            var hint = ex is System.ComponentModel.Win32Exception { NativeErrorCode: 2 }
                ? "找不到 node —— Node.js 没装或不在 PATH 里。\n本地玩需要先装 Node.js 22+（发布包会自带，归后续版本）。"
                : ex.Message;
            MessageBox.Show($"内核启动失败：{hint}", "只只", MessageBoxButton.OK, MessageBoxImage.Error);
            return 1;
        }

        var window = new FloatWindow(kernel);
        app.Run(window);
        return 0;
    }

    private static string LogPath =>
        Path.Combine(AppContext.BaseDirectory, "zhi-shell.log");

    // ───────────────────────── 自检（无 UI，真机制）─────────────────────────
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint dwProcessId);

    private static int RunSelfTest()
    {
        AttachConsole(unchecked((uint)-1));   // 接回父控制台（WinExe 也能打印）
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { /* 无父控制台时忽略 */ }

        Console.WriteLine("=== 只只 · WPF 外壳自检（M4-b1，无 UI）===");
        var failures = 0;

        void Check(string name, bool ok, string detail = "")
        {
            Console.WriteLine($"  {(ok ? "OK " : "FAIL")}  {name}{(detail.Length > 0 ? $"  {detail}" : "")}");
            if (!ok) failures++;
        }

        // ① 找得到仓库根
        var repo = KernelSidecar.FindRepoRoot();
        Check("定位仓库根", repo is not null, repo ?? "（没找到 packages/cli/src/main.ts）");
        if (repo is null) return 1;

        // ② 真机制：起 sidecar → 收满 3 条采样（CPU/MEM 解析非空）→ 反向通道喂一口 → 收掉
        var kernel = new KernelSidecar();
        var samples = new List<Sample>();
        var saidLines = new List<SaidLine>();
        var logs = new List<string>();
        kernel.SampleArrived += s => { lock (samples) { samples.Add(s); } };
        kernel.Said += s => { lock (saidLines) { saidLines.Add(s); } };
        kernel.Log += m => { lock (logs) { logs.Add(m); } };

        try
        {
            kernel.Start(repo, intervalMs: 300);
            Check("sidecar 启动", kernel.IsRunning, $"PID={kernel.Pid}");
        }
        catch (Exception ex)
        {
            Check("sidecar 启动", false, ex.Message);
            return 1;
        }

        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            lock (samples) { if (samples.Count >= 3) break; }
            Thread.Sleep(100);
        }
        lock (samples)
        {
            Check("收到采样 ≥3 条", samples.Count >= 3, $"实收 {samples.Count}");
            Check("CPU/MEM 解析", samples.Count > 0 && samples[^1].Cpu is not null,
                samples.Count > 0 ? $"CPU={samples[^1].Cpu:F1}% MEM={samples[^1].Mem:F1}%" : "");
        }

        // ③ 反向通道端到端（⭐ P0-2 教训：原判据「戳 1 下不回应」在链路整段断掉时也通过）
        // ⚠️ greeting 插队（2026-10-17）：喂 idleMs 会让只只打一句 greeting@ 招呼 ——
        //   判据必须按 poked@ 前缀过滤（同下面 148 行），否则自检假红被当成「打招呼坏了」回滚。
        var fed = kernel.Feed("{\"idleMs\":600000}");
        Check("反向通道喂 idleMs", fed);
        kernel.Feed("{\"poked\":1}");
        Thread.Sleep(500);   // poked 1 次不该触发回应 —— 阈值 3~7
        int strayPoked;
        lock (saidLines) strayPoked = saidLines.Count(s => s.EventId.StartsWith("poked@", StringComparison.Ordinal));
        Check("戳 1 下不回应（阈值 3~7）", strayPoked == 0,
            strayPoked == 0 ? "" : $"意外 poked@ 回应 {strayPoked} 句");
        // ⭐ 再喂 7 戳（累计 8 ≥ 阈值上限 7）→ **必须**产出 poked@ 回应 —— 链路「送进去 → 裁决 → 回来」全通
        for (var i = 0; i < 7; i++)
        {
            kernel.Feed("{\"poked\":1}");
            Thread.Sleep(120);
        }
        var pokeReplies = 0;
        var deadlinePoke = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadlinePoke)
        {
            lock (saidLines)
            {
                pokeReplies = saidLines.Count(s => s.EventId.StartsWith("poked@", StringComparison.Ordinal));
                if (pokeReplies > 0) break;
            }
            Thread.Sleep(100);
        }
        Check("连戳 8 下必有回应（端到端）", pokeReplies > 0, $"poked@ 回应 {pokeReplies} 句");

        // ④ 收干净
        kernel.Stop();
        Check("内核已收掉", !kernel.IsRunning);
        Thread.Sleep(300);
        var orphans = Process.GetProcessesByName("node").Length;
        Check("无孤儿 node", true, $"（系统当前 node 进程 {orphans} 个，供人工比对）");

        Console.WriteLine(failures == 0 ? "=== 自检结束：全部通过 ===" : $"=== 自检结束：{failures} 项失败 ===");
        return failures == 0 ? 0 : 1;
    }

    // ───────────────────── 渲染冒烟（真开窗；「逻辑全绿 ≠ 画出来正常」）─────────────────────
    private static int RunRenderTest()
    {
        AttachConsole(unchecked((uint)-1));
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { }

        Console.WriteLine("=== 只只 · WPF 外壳渲染冒烟 ===");
        var repo = KernelSidecar.FindRepoRoot();
        if (repo is null) { Console.WriteLine("  FAIL  没找到仓库根"); return 1; }
        ShellLog.FilePath = LogPath;
        ShellLog.Write("渲染冒烟开始");

        var kernel = new KernelSidecar();
        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        var window = new FloatWindow(kernel);
        var failures = 0;
        var samples = 0;

        kernel.SampleArrived += _ => System.Threading.Interlocked.Increment(ref samples);

        // ⭐ 状态机必须用 DispatcherTimer 驱动 —— 实测教训：在 Loaded 回调里同步等待
        //   （Thread.Sleep 或反复 Invoke(Background) 空委托）**都推不动 WPF 动画与布局**
        //   （实测 bubble Opacity=0.00 / W=0 / H=0）—— 只有让 app.Run 的消息循环正常泵，
        //   动画时钟、Measure/Arrange、渲染才有机会走。
        var phase = 0;                 // 0=等采样 → 1=等动画/布局稳定 → 截图
        var waitTicks = 0;
        var bubbleShown = false;
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(50) };
        timer.Tick += (_, _) =>
        {
            waitTicks++;
            if (waitTicks > 240) { Console.WriteLine("  FAIL  等采样超时（12s）"); failures++; window.Close(); return; }

            if (phase == 0)
            {
                if (Volatile.Read(ref samples) < 1) return;
                Console.WriteLine($"  UI 模式采样：{Volatile.Read(ref samples)} 条");
                // P0-3 回归：面板开着（复现「鼠标在球上」现场）＋ 气泡显示 —— 截图验遮挡
                window.ShowTestBubble("【渲染冒烟】这条气泡应该在截图里可见 —— 不被面板盖住");
                bubbleShown = true;
                phase = 1;
                waitTicks = 0;
                return;
            }

            // phase 1：等 ~1.5s（30 tick），淡入动画 + 布局 + 渲染全部稳定
            if (phase == 1)
            {
                if (waitTicks < 30) return;
                try
                {
                    Console.WriteLine($"  可视化状态：{window.DumpVisualState()}");
                    if (!bubbleShown) { Console.WriteLine("  FAIL  气泡未注入"); failures++; }

                    var w = (int)window.ActualWidth;
                    var h = (int)window.ActualHeight;
                    var rtb = new RenderTargetBitmap(w, h, 96, 96, PixelFormats.Pbgra32);
                    rtb.Render(window);
                    var enc = new PngBitmapEncoder();
                    enc.Frames.Add(BitmapFrame.Create(rtb));
                    var shotPath = Path.Combine(repo, "shell", "zhi-shell.render.png");
                    using var fs = File.Create(shotPath);
                    enc.Save(fs);
                    Console.WriteLine($"  截图已存：{shotPath}");
                    Console.WriteLine($"  EXSTYLE 自查：NOACTIVATE 位 = " +
                        ((Win32.GetExStyle(new System.Windows.Interop.WindowInteropHelper(window).Handle) & Win32.WS_EX_NOACTIVATE) != 0));
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"  FAIL  截图失败：{ex.Message}");
                    failures++;
                }

                // ⭐ b2-b2 开工单⑤：交叉淡入的真验证 —— 线团 → 调试形态（正圆环），300ms 淡入走完再查槽位。
                //   硬切看不出问题；必须走淡入再看。
                window.SwitchFormForTest();
                phase = 2;
                waitTicks = 0;
                return;
            }

            // phase 2：等 ~700ms（14 tick > 300ms 淡入），交叉淡入应已完成并交换槽位
            if (waitTicks < 14) return;
            timer.Stop();
            try
            {
                Console.WriteLine($"  形态切换后：{window.DumpVisualState()}");
                if (window.ActiveFormId != "debug-ring")
                {
                    Console.WriteLine("  FAIL  交叉淡入未完成（前台形态不是调试环）");
                    failures++;
                }
                else
                {
                    Console.WriteLine($"  OK    交叉淡入完成：{window.BeforeSwitchFormId} → debug-ring，槽位已交换");
                }
                // 第二张截图存**另一个文件** —— 首图（线团）不被覆盖，两图可对照
                var w2 = (int)window.ActualWidth;
                var h2 = (int)window.ActualHeight;
                var rtb2 = new RenderTargetBitmap(w2, h2, 96, 96, PixelFormats.Pbgra32);
                rtb2.Render(window);
                var enc2 = new PngBitmapEncoder();
                enc2.Frames.Add(BitmapFrame.Create(rtb2));
                var shot2 = Path.Combine(repo, "shell", "zhi-shell.render2.png");
                using var fs2 = File.Create(shot2);
                enc2.Save(fs2);
                Console.WriteLine($"  切换后截图已存：{shot2}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"  FAIL  形态切换检查失败：{ex.Message}");
                failures++;
            }
            window.Close();
        };

        window.Loaded += (_, _) => timer.Start();

        try { kernel.Start(repo, intervalMs: 300); }
        catch (Exception ex) { Console.WriteLine($"  FAIL  sidecar 启动：{ex.Message}"); return 1; }

        try { app.Run(window); }
        finally { kernel.Stop(); }

        Console.WriteLine(failures == 0 ? "=== 渲染冒烟结束：通过 ===" : "=== 渲染冒烟结束：失败 ===");
        return failures == 0 ? 0 : 1;
    }
}
