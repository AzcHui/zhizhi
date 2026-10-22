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
        if (args.Contains("--mood-test", StringComparer.OrdinalIgnoreCase))
            return RunMoodTest();
        if (args.Contains("--fg-test", StringComparer.OrdinalIgnoreCase))
            return RunFgTest();
        if (args.Contains("--home-test", StringComparer.OrdinalIgnoreCase))
            return RunHomeTest(args);

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

        // ⚠️ WebView2 托管 DLL 预检（2026-10-22 P0 根治第二层）：
        //   缺了的话「只只的家」开窗就报 .NET 的 FileNotFoundException（天书）。
        //   这里启动时就查一次，日志留痕；**不弹窗打断** —— 球照常跑，
        //   等用户真去开「家」时 HomeWindow 会给一句人话提示（那才是该打扰的时刻）。
        //   ⚠️ 用 WebView2Preflight（不碰任何 WebView2 类型）—— 本行所在的方法若引用了
        //   WebView2 类型，JIT 就会在进方法时先抛 FileNotFoundException，预检成死代码。
        var missingWv2 = WebView2Preflight.FindMissingAssemblies();
        if (missingWv2.Count > 0)
        {
            ShellLog.Write($"[WRN] 缺 WebView2 托管 DLL（只只的家会开不了）：{string.Join("、", missingWv2)}");
        }
        else
        {
            ShellLog.Write("[OK] WebView2 托管 DLL 齐备");
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

    // ───────────────────── 只只的家 · 自动验收（M11-c，开工单第五节 5.1）─────────────────────
    // 五条判据：
    //   ① WebView2 运行时在位（GetAvailableBrowserVersionString 非 null）
    //   ② 收到前端 ready（说明 dist 加载成功、bridge.ts 通了）
    //   ③ overview 回传后前端回显字段数 ≥ 5（说明桥是双向的，不是只发不收）
    //   ④ getHistory 返回条数 > 0（events.jsonl 存在时）—— 证明真的读到了盘
    //   ⑤ 截图里能看到四个页签（人眼复核一次）
    private static int RunHomeTest(string[] args)
    {
        AttachConsole(unchecked((uint)-1));
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { }

        Console.WriteLine("=== 只只 · 家（WebView2）自动验收 ===");
        var repo = KernelSidecar.FindRepoRoot();
        if (repo is null) { Console.WriteLine("  FAIL  没找到仓库根"); return 1; }
        ShellLog.FilePath = LogPath;
        ShellLog.Write("家的自动验收开始");

        var failures = 0;
        void Check(string name, bool ok, string detail = "")
        {
            Console.WriteLine($"  {(ok ? "OK " : "FAIL")}  {name}{(detail.Length > 0 ? $"  {detail}" : "")}");
            if (!ok) failures++;
        }

        // ⓪ WebView2 托管 DLL 预检（**必须在调 GetRuntimeVersion 之前** ——
        //    那个方法引用了 WebView2 类型，缺 DLL 时 JIT 阶段就抛 FileNotFoundException，
        //    下面的判据根本没机会跑。这里先查、给人话、直接退出。）
        var missingWv2 = WebView2Preflight.FindMissingAssemblies();
        Check("⓪ WebView2 托管 DLL 齐备", missingWv2.Count == 0,
            missingWv2.Count == 0 ? "" : $"（缺 {string.Join("、", missingWv2)} —— 构建产物不完整，重新 dotnet build）");
        if (missingWv2.Count > 0) return 1;

        // ① WebView2 运行时
        var runtime = HomeWindow.GetRuntimeVersion();
        Check("① WebView2 运行时在位", runtime is not null, runtime ?? "（没装 WebView2 Runtime）");
        if (runtime is null) return 1;

        // dist 存在？前端没构建就没法测（这本身是重要信息 —— 明确说出来，不含糊）
        var dist = HomeWindow.FindDistPath();
        Check("dist 已构建（apps/home/dist）", dist is not null, dist ?? "（没找到 —— 先跑 pnpm build:home）");
        if (dist is null) return 1;

        // 内核（要 hello 通告里的 dataDir —— 绝不自己硬拼）
        var kernel = new KernelSidecar();
        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        var floatWindow = new FloatWindow(kernel);
        HomeWindow? home = null;

        // ⚠️ 验收专用：`--home-test --data-dir=<路径>` 让内核用**独立数据目录**。
        //   用途：判据⑥「空状态」—— 真 events.jsonl 在跑着，不能改名（用户在用），
        //   所以隔离出一个空目录来验「第一天」长什么样。**生产路径永远不带这个参数。**
        var dataDirArg = Array.Find(args, a => a.StartsWith("--data-dir=", StringComparison.OrdinalIgnoreCase));
        var overrideDataDir = dataDirArg is null ? null : dataDirArg.Substring("--data-dir=".Length);
        // 隔离实例的截图加后缀 —— 别覆盖真截图（那是给人眼复核用的）
        var shotSuffix = overrideDataDir is null ? "" : "empty-";

        try
        {
            kernel.Start(repo, intervalMs: 1000, dataDir: overrideDataDir);
        }
        catch (Exception ex)
        {
            Check("内核启动", false, ex.Message);
            return 1;
        }

        // 等 hello（dataDir）
        var helloDeadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < helloDeadline && kernel.DataDir is null) Thread.Sleep(100);
        Check("内核 hello 通告 dataDir", kernel.DataDir is not null, kernel.DataDir ?? "（15s 内没收到 hello）");
        if (kernel.DataDir is null) { kernel.Stop(); return 1; }

        // 桥 + 家窗口
        var bridge = new HomeBridge(floatWindow, kernel);
        var readySeen = false;
        var ackFields = 0;
        var historyCount = 0;
        var echoPoolLines = -1;      // 前端回显：它真正解析到的句数（-1 = 还没回显）
        var echoPoolSections = -1;
        var echoPoolErr = "";

        home = new HomeWindow(bridge);
        // 监听前端消息：ready + overview 回显（③ 的判据靠这个）
        home.WebMessageProbe = (cmd, json) =>
        {
            if (cmd == "ready") readySeen = true;
            if (cmd == "echoPools")
            {
                // ⚠️ 判据④c：**前端自己解析到的句数**（不是外壳自称发过的）。
                //   上一轮的教训：外壳发的 JSON 字段名对不上（PascalCase），
                //   前端拿到 undefined → 页面永远转圈 —— 而**外壳这边一切正常**，
                //   所以「外壳侧自检」抓不到，必须让前端回吐它真正读到的数。
                //   教训（可推广）：**发送方的自证不算数，要接收方回执。**
                try
                {
                    using var d = System.Text.Json.JsonDocument.Parse(json);
                    if (d.RootElement.TryGetProperty("lines", out var l)
                        && l.ValueKind == System.Text.Json.JsonValueKind.Number
                        && l.TryGetInt32(out var n))
                    {
                        echoPoolLines = n;
                    }
                    if (d.RootElement.TryGetProperty("sections", out var sec)
                        && sec.ValueKind == System.Text.Json.JsonValueKind.Number
                        && sec.TryGetInt32(out var sn))
                    {
                        echoPoolSections = sn;
                    }
                    if (d.RootElement.TryGetProperty("error", out var er)
                        && er.ValueKind == System.Text.Json.JsonValueKind.String)
                    {
                        echoPoolErr = er.GetString() ?? "";
                    }
                }
                catch { /* 探针自己解析失败不影响主链 */ }
            }
            if (cmd == "echoOverview")
            {
                // ⚠️⚠️ 2026-10-22 修 9.2 假数字：**必须从 args 里真读 fields**，
                //   原来这里写死 `ackFields = 1` —— 判据从「字段数 ≥ 5」退化成「收到过就行」，
                //   而且日志打出的「字段数=1」是假的（前端明明回了 8，外壳直接丢弃写死 1）。
                //   教训（同一个坑第二次）：**要打印出来的数字，就得是它原样穿过来的那个数**。
                ackFields = 0;
                try
                {
                    using var d = System.Text.Json.JsonDocument.Parse(json);
                    if (d.RootElement.TryGetProperty("fields", out var f)
                        && f.ValueKind == System.Text.Json.JsonValueKind.Number
                        && f.TryGetInt32(out var n))
                    {
                        ackFields = n;
                    }
                }
                catch { /* 探针自己解析失败不影响主链 */ }
            }
        };

        home.Show();

        // ⭐ 必须用 DispatcherTimer 驱动等待 —— **不能用 Thread.Sleep**：
        //   WebView2 的消息/脚本回调走 UI 消息队列，同步等待时队列不泵 → 永远收不到 ready。
        //   （与 render-test 同款纪律：只有让 app.Run 的消息循环正常泵，回调才有机会来。）
        var phase = 0;
        var waitTicks = 0;
        string shotPath = "";
        Task<bool>? captureTask = null;
        Task? switchTask = null;
        var tabIndex = 0;
        var shotPaths = new List<string>();
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(50) };
        timer.Tick += (_, _) =>
        {
            waitTicks++;
            if (waitTicks > 700)   // 35 秒超时
            {
                timer.Stop();
                Check("② 收到前端 ready", readySeen, readySeen ? "" : "（35s 内没收到 —— dist 没加载成功或 bridge 没通）");
                Check("③ overview 回显（桥是双向的）", ackFields >= 5, ackFields >= 5 ? $"（真实字段数 {ackFields}）" : $"（字段数 {ackFields} < 5 —— 前端没回显或 overview 被丢字段）");
                Check("④c 前端真解析到台词了（回执句数 > 0）", echoPoolLines > 0,
                    echoPoolLines > 0 ? $"前端回显 {echoPoolSections} 段 / {echoPoolLines} 句"
                        : (echoPoolErr.Length > 0 ? $"前端报结构错：{echoPoolErr}" : "前端没回显（echoPools 缺失）"));
                Finish();
                return;
            }

            if (phase == 0)
            {
                // ⚠️ 等三样：ready + overview 回显 + **pools 回显**（前端真正解析到的句数）。
                //   少了第三个 → 判据④c 会在前端还没回显时跑 → 假红。
                if (!readySeen || ackFields < 5) return;
                if (echoPoolLines < 0 && waitTicks < 200) return;   // 最多再等 10s
                Console.WriteLine($"  握手完成：ready={readySeen}，overview 回显字段数={ackFields}，pools 回显 {echoPoolSections} 段/{echoPoolLines} 句");
                phase = 1;
                waitTicks = 0;
                return;
            }

            // phase 1：等前端渲染完（~1.5s）再截图
            if (phase == 1)
            {
                if (waitTicks < 30) return;

                Check("② 收到前端 ready", readySeen);
                Check("③ overview 回显（桥是双向的）", ackFields >= 5, ackFields >= 5 ? $"（真实字段数 {ackFields}）" : $"（字段数 {ackFields} < 5 —— 前端没回显或 overview 被丢字段）");

                // ④ getHistory 条数（真读盘）
                try
                {
                    var histJson = bridge.Handle("{\"cmd\":\"getHistory\",\"limit\":50}");
                    using var doc = System.Text.Json.JsonDocument.Parse(histJson[0]);
                    historyCount = doc.RootElement.GetProperty("data").GetProperty("items").GetArrayLength();
                }
                catch (Exception ex) { Console.WriteLine($"  （getHistory 解析失败：{ex.Message}）"); }
                Check("④ getHistory 读到盘", historyCount > 0, $"{historyCount} 条");

                // ④b ⭐ 台词池字段名判据（2026-10-22 P0 回归抓手）
                //   症状：用户报「台词池一直显示正在读台词池」。
                //   根因：BuildPools 从匿名类型改成了 record，而 .NET 的 JsonSerializer
                //         **默认保持属性名原样（PascalCase）** → 序列化成
                //         "Sections"/"Type"/"Lines"/"Text"/"Source"，
                //         前端读的是 data.sections / s.type / l.text（全小写）→ 全 undefined
                //         → state.pools 永远 null → 页面永远转圈。
                //   ⚠️ 这条判据**直接查桥返回的 JSON 字段名** —— 因为
                //      「前端有没有渲染出台词」截图能看出来，但**没人看截图**；
                //      「字段名对不对」是纯数字，必须有自动判据盯着。
                int poolSections = 0;
                int poolLines = 0;
                string poolShapeErr = "";
                try
                {
                    var poolJson = bridge.Handle("{\"cmd\":\"getPools\"}");
                    using var pdoc = System.Text.Json.JsonDocument.Parse(poolJson[0]);
                    var data = pdoc.RootElement.GetProperty("data");
                    // ⚠️ 这里刻意用**小写**属性名取 —— 取不到就说明序列化成了 PascalCase
                    if (!data.TryGetProperty("sections", out var sectionsEl))
                    {
                        var actual = string.Join(",", data.EnumerateObject().Select(p => p.Name));
                        poolShapeErr = $"data 里没有小写 sections，实际字段：{actual}";
                    }
                    else
                    {
                        foreach (var sec in sectionsEl.EnumerateArray())
                        {
                            if (!sec.TryGetProperty("type", out var ty) || !sec.TryGetProperty("lines", out var linesEl))
                            {
                                poolShapeErr = "section 缺小写 type/lines";
                                break;
                            }
                            poolSections++;
                            foreach (var ln in linesEl.EnumerateArray())
                            {
                                if (!ln.TryGetProperty("text", out _) || !ln.TryGetProperty("source", out _))
                                {
                                    poolShapeErr = "line 缺小写 text/source";
                                    break;
                                }
                                poolLines++;
                            }
                            if (poolShapeErr.Length > 0) break;
                        }
                    }
                }
                catch (Exception ex) { poolShapeErr = ex.Message; }
                Check("④b 台词池字段名是小写（前端能解析）",
                    poolShapeErr.Length == 0 && poolSections > 0 && poolLines > 0,
                    poolShapeErr.Length > 0 ? poolShapeErr : $"{poolSections} 段 / {poolLines} 句");

                // ④c ⭐ 前端回执判据：**前端自己解析到的句数** > 0。
                //   ⚠️ 这条比④b 更硬 —— ④b 查的是「外壳发的 JSON 对不对」，
                //   ④c 查的是「前端真拿到手了吗」（端到端）。
                //   上一轮 P0 回归时外壳侧一切正常、前端却永远转圈 ——
                //   只有「接收方回执」才抓得到。
                Check("④c 前端真解析到台词了（回执句数 > 0）",
                    echoPoolLines > 0,
                    echoPoolLines > 0 ? $"前端回显 {echoPoolSections} 段 / {echoPoolLines} 句"
                        : (echoPoolErr.Length > 0 ? $"前端报结构错：{echoPoolErr}" : "前端没回显（echoPools 缺失）"));

                // ⑤b 试听链路：previewLine → 球冒这句（**纯预览，不进记忆**）
                //   验法：先记 events.jsonl 的条数 → 调 previewLine → 再记一次 → 必须**没变**。
                var before = CountEventLines();
                var previewReplies = bridge.Handle("{\"cmd\":\"previewLine\",\"text\":\"这是一句试听测试\"}");
                var previewOk = previewReplies.Count > 0;
                Thread.Sleep(600);   // 等气泡入队（试听是 UI 动作，不走内核）
                var after = CountEventLines();
                Check("⑤b 试听走通（previewLine 有回包）", previewOk);
                Check("⑤c 试听不污染记忆（events.jsonl 条数不变）", before == after, $"{before} → {after}");

                // ⑤ 逐页截图（人眼复核四个页签都有内容）
                // ⚠️ **绝不能在 UI 线程同步等异步**（GetAwaiter().GetResult()）——
                //   CapturePreviewAsync 的续体要回到 UI 线程，同步等就是死锁（实测：程序直接卡死无输出）。
                //   正确做法：发起异步 → 下一拍再查结果。
                shotPath = Path.Combine(repo, "shell", shotSuffix + "zhi-shell.home.png");
                captureTask = home.CaptureToAsync(shotPath);
                phase = 2;
                waitTicks = 0;
                return;
            }

            // phase 2：等截图任务完成（不阻塞 UI 线程）→ 切到下一个页签
            if (phase == 2)
            {
                if (captureTask is null || !captureTask.IsCompleted) return;
                var captured = captureTask.Result;
                Check($"⑤ 截图 tab{tabIndex}（人眼复核）", captured, captured ? shotPath : "（CapturePreviewAsync 失败）");
                shotPaths.Add(shotPath);

                // 下一个页签（0=概览 1=台词池 2=消息历史 3=日志）
                tabIndex++;
                if (tabIndex < 4)
                {
                    shotPath = Path.Combine(repo, "shell", $"{shotSuffix}zhi-shell.home{tabIndex}.png");
                    switchTask = home.SwitchTabAsync(tabIndex);
                    phase = 3;
                    waitTicks = 0;
                    return;
                }
                timer.Stop();
                Finish();
            }

            // phase 3：切页签后等渲染（~0.6s）再截下一张
            if (phase == 3)
            {
                if (waitTicks < 12) return;
                captureTask = home.CaptureToAsync(shotPath);
                phase = 2;
                waitTicks = 0;
            }
        };

        // 读 events.jsonl 的条数（验试听不污染记忆）
        int CountEventLines()
        {
            try
            {
                var p = Path.Combine(kernel.DataDir ?? "", "memory", "events.jsonl");
                if (!File.Exists(p)) return 0;
                return File.ReadAllLines(p).Count(l => !string.IsNullOrWhiteSpace(l));
            }
            catch { return -1; }
        }

        void Finish()
        {
            try { home.Close(); } catch { }
            try { kernel.Stop(); } catch { }
            app.Shutdown();
            Console.WriteLine(failures == 0 ? "=== 家的自动验收：全部通过 ===" : $"=== 家的自动验收：{failures} 项失败 ===");
            Environment.Exit(failures == 0 ? 0 : 1);
        }

        timer.Start();
        app.Run();   // 消息循环跑起来（回调才有来处）
        return failures == 0 ? 0 : 1;
    }

    // ───────────────────── 情绪三态截图（M11-a 验收②：沉默/陌生/亲近 三张并排，肉眼分亮度）─────────────────────
    private static int RunMoodTest()
    {
        AttachConsole(unchecked((uint)-1));
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { }

        Console.WriteLine("=== 只只 · WPF 情绪三态截图（M11-a 验收②）===");
        var repo = KernelSidecar.FindRepoRoot();
        if (repo is null) { Console.WriteLine("  FAIL  没找到仓库根"); return 1; }
        ShellLog.FilePath = LogPath;
        ShellLog.Write("情绪三态截图开始");

        var kernel = new KernelSidecar();
        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        var window = new FloatWindow(kernel);
        var failures = 0;
        var samples = 0;
        kernel.SampleArrived += _ => System.Threading.Interlocked.Increment(ref samples);

        var cases = new (int Trust, string Name)[] { (5, "silent"), (20, "stranger"), (90, "close") };
        var caseIdx = -1;          // -1 = 等首采样
        var waitTicks = 0;
        const int settleTicks = 60;   // 每态等 3s：τ=600ms 平滑收敛（>5τ）＋ 说话脉冲回落 ＋ greeting 播完

        var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(50) };
        timer.Tick += (_, _) =>
        {
            waitTicks++;
            if (waitTicks > 600) { Console.WriteLine("  FAIL  等采样超时（30s）"); failures++; timer.Stop(); window.Close(); return; }

            if (caseIdx < 0)
            {
                if (System.Threading.Volatile.Read(ref samples) < 1) return;
                caseIdx = 0;
                waitTicks = 0;
                window.MoodTestOverride(cases[caseIdx].Trust);
                Console.WriteLine($"  [{cases[0].Name}] 注入 trust={cases[0].Trust}");
                return;
            }
            if (waitTicks < settleTicks) return;

            try
            {
                var (trust, name) = cases[caseIdx];
                Console.WriteLine($"  [{name}] trust={trust} moodAlpha={window.MoodAlphaForTest:F3}");
                var w = (int)window.ActualWidth;
                var h = (int)window.ActualHeight;
                var rtb = new RenderTargetBitmap(w, h, 96, 96, PixelFormats.Pbgra32);
                rtb.Render(window);
                var enc = new PngBitmapEncoder();
                enc.Frames.Add(BitmapFrame.Create(rtb));
                var shot = Path.Combine(repo, "shell", $"zhi-shell.mood-{name}.png");
                using var fs = File.Create(shot);
                enc.Save(fs);
                Console.WriteLine($"  截图已存：{shot}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"  FAIL  截图失败：{ex.Message}");
                failures++;
            }
            caseIdx++;
            if (caseIdx >= cases.Length) { timer.Stop(); window.Close(); return; }
            window.MoodTestOverride(cases[caseIdx].Trust);
            Console.WriteLine($"  [{cases[caseIdx].Name}] 注入 trust={cases[caseIdx].Trust}");
            waitTicks = 0;
        };

        window.Loaded += (_, _) => timer.Start();

        try { kernel.Start(repo, intervalMs: 300); }
        catch (Exception ex) { Console.WriteLine($"  FAIL  sidecar 启动：{ex.Message}"); return 1; }

        try { app.Run(window); }
        catch (Exception ex) { Console.WriteLine($"  FAIL  消息循环：{ex.Message}"); return 1; }
        finally { kernel.Stop(); }

        Console.WriteLine(failures == 0 ? "=== 情绪三态截图：通过（三张 mood-*.png 并排肉眼比亮度）===" : $"=== 情绪三态截图：{failures} 项失败 ===");
        return failures == 0 ? 0 : 1;
    }

    // ───────────────────── 前台分类自测（二·AB 验收①⑧：合成输入 → 期望类别，不碰真窗口）─────────────────────
    private static int RunFgTest()
    {
        Console.WriteLine("=== 只只 · 前台分类自测（--fg-test，合成用例）===");
        // (进程名, 全屏?, 期望类别, 说明) —— ≥12 组，覆盖六条判据与全部易错点
        (string? Name, bool Full, string Want, string Note)[] cases =
        {
            ("wemeeting",        false, "meeting",    "会议白名单①（小写）"),
            ("WeMeetApp",        false, "meeting",    "会议白名单②（大小写不敏感）"),
            ("ms-teams",         false, "meeting",    "会议白名单③"),
            ("Zoom",             false, "meeting",    "会议白名单④"),
            ("DingTalk",         false, "meeting",    "会议白名单⑤"),
            ("Feishu",           false, "meeting",    "会议白名单⑥"),
            ("Code",             false, "code",       "IDE 白名单①（VS Code）"),
            ("devenv",           false, "code",       "IDE 白名单②（Visual Studio）"),
            ("WindowsTerminal",  false, "code",       "IDE 白名单③（终端）"),
            ("chrome",           false, "browser",    "浏览器白名单①"),
            ("msedge",           false, "browser",    "浏览器白名单②"),
            ("explorer",         false, "unknown",    "桌面/任务栏 → unknown"),
            ("WorkBuddy",        false, "unknown",    "非白名单进程 → unknown"),
            (null,               false, "unknown",    "取不到进程名（系统进程/已退出）→ unknown 不抛"),
            ("somegame",         true,  "fullscreen", "未知进程全屏 → fullscreen（游戏/全屏视频统一判据）"),
            ("Code",             true,  "code",       "⭐ 易错点2/⑧：IDE 全屏仍是 code（进程名命中就不看全屏）"),
            ("chrome",           true,  "fullscreen", "⭐ P3：浏览器真全屏 → fullscreen（在看内容，该闭嘴）"),
            ("chrome",           false, "browser",    "浏览器非全屏 → browser（查资料，说话）"),
        };
        var fails = 0;
        foreach (var c in cases)
        {
            var got = Win32.Classify(c.Name, c.Full);
            var ok = got == c.Want;
            if (!ok) fails++;
            Console.WriteLine($"  {(ok ? "OK " : "FAIL")}  {(c.Name ?? "(null)"),-18} full={c.Full,-5} → {got,-11} 期望 {c.Want,-11} {c.Note}");
        }
        // 验收②补充：真前台实测（打印类别名，**绝不打印标题** —— 没有标题可打）
        var live = Win32.ForegroundClass();
        Console.WriteLine($"  ── 真前台：当前窗口分类 = {live}（meeting/fullscreen 会压闲聊；code/browser/unknown 不影响）──");

        // 二·AC P1 性能验收：60 次取样，单次平均 < 1ms（删掉 pid 缓存后的代价必须可忽略）
        var sw = System.Diagnostics.Stopwatch.StartNew();
        for (var i = 0; i < 60; i++) _ = Win32.ForegroundClass();
        sw.Stop();
        var avgMs = sw.Elapsed.TotalMilliseconds / 60.0;
        var perfOk = avgMs < 1.0;
        if (!perfOk) fails++;
        Console.WriteLine($"  {(perfOk ? "OK " : "FAIL")}  ForegroundClass() 60 次取样：平均 {avgMs:F3} ms/次（判据 < 1ms）");

        Console.WriteLine(fails == 0 ? "=== 前台分类自测：通过 ===" : $"=== 前台分类自测：{fails} 项失败 ===");
        return fails == 0 ? 0 : 1;
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
                // 二·AC P2：注入固定「前台 code」—— 面板上的前台读数要在这张截图里看得见
                window.FgTestOverride("code");
                // 二·AC 复验补记③ ＋ 监工 A1：几何断言必须在**真实最坏**状态行下跑 ——
                //   真实最坏 = 「看着呢 —— CPU 100.0% · 前台 meeting · 亲近」（三位数 CPU ＋ 最宽枚举 ＋ 信任词）。
                //   ⚠️ 注入后**锁定**（StatusTestOverride 内置）：不锁的话 300ms 一条的 OnSample
                //      → UpdateStatusLine 会把它覆盖回普通行，断言就测了个假的（A1 假绿根因）。
                window.StatusTestOverride("看着呢 —— CPU 100.0% · 前台 meeting · 亲近");
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

                    // 二·AC 复验补记③：**几何裁剪断言**（防复发的关键，不是可选项）——
                    //   截图判不出裁剪：被窗裁掉的内容在截图里根本不存在（只能看到右半句）。
                    //   所以必须用数字判：面板宽 ≤ 当前锚可用宽、左右顶缘都在窗内。
                    var clip = window.PanelClipViolation();
                    if (clip is null)
                        Console.WriteLine("  OK    面板完整落在窗口内（几何断言，最宽状态行下）");
                    else
                    {
                        Console.WriteLine($"  FAIL  面板被窗裁：{clip}");
                        failures++;
                    }

                    // ⚠️ 2026-10-22 修 bug 的**回归判据**：第三按钮的**文案必须与行为一致**。
                    //   起因：用户报「面板显示退出，点击却是打开窗口」——
                    //   根因是文案在 MakePanel() 时算（那时 _trayOk 还是 false），
                    //   而点击行为读的是点击那一刻的 _trayOk（已 true）→ 说的和做的不是一回事。
                    //   这类缺陷**截图看不出来**（按钮就那么几个字），必须用数字判。
                    var btnOk = window.HomeOrExitUiConsistent();
                    if (btnOk.ok)
                        Console.WriteLine($"  OK    第三按钮文案与行为一致（{btnOk.detail}）");
                    else
                    {
                        Console.WriteLine($"  FAIL  第三按钮文案与行为不一致：{btnOk.detail}");
                        failures++;
                    }

                    // 恢复成真实状态行再截图（截图是给人看的证据，别让注入的最坏行混淆视线）
                    window.StatusTestUnlock();
                    phase = 3;
                    waitTicks = 0;
                    return;
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"  FAIL  几何断言阶段出错：{ex.Message}");
                    failures++;
                    phase = 3;
                    waitTicks = 0;
                    return;
                }
            }

            // phase 3：恢复普通状态行后等 4 tick（布局稳定）再截图 —— 截图是给人看的证据
            if (phase == 3)
            {
                if (waitTicks < 4) return;
                try
                {
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
