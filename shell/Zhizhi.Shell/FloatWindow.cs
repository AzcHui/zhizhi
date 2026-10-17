using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace Zhizhi.Shell;

/// <summary>
/// 只只的球（M4-b1 最小可跑壳）—— 三态信息架构的骨架版：
///   球   = 「它在」（常驻；M4-c 状态机制复用：底色三态 + 亲密度档位词）
///   气泡 = 「它刚说了句」（说话时冒出、约 4.5s 自动消失 —— 决策 #34 第 6 步 L2 在此闭环；
///          替代旧壳「覆盖式 20px 标签 + 24 字截断」—— 气泡不截断）
///   面板 = 悬停展开（数字 + 挪一挪 + 退出；「静一下/设置」等 b2）
/// ⭐ 硬约束（决策 #27 已定）：只打 WS_EX_NOACTIVATE（不抢焦点），**不打 TRANSPARENT**（球要可点）。
/// ⭐ 决策 #34 / #30：点球 = 戳一下（{"poked":1}）；戳的抖动是**球的视觉反应**（平移变换），
///    不是挪窗口 —— 天然不会与「挪一挪」打架（旧壳那个 P0 在新架构里结构性消失）。
/// ⭐ 决策 #31：挪一挪 = 离开式随机（方向随机 / 位移 ≈ 自身 0.6~1.0 倍 / clamp 工作区 /
///    允许回原位 / 落中央 1/3 重抽一次）+ 约 200ms 滑动过渡（别瞬移）。
/// </summary>
public sealed class FloatWindow : Window
{
    private const double BallSize = 64;

    private readonly KernelSidecar _kernel;
    private readonly DispatcherTimer _idleTimer;      // 每秒喂 idleMs
    private readonly DispatcherTimer _bubbleTimer;    // 气泡自动消失
    private readonly Ellipse _ball;
    private readonly TranslateTransform _ballShake;   // L1 抖动 = 球的视觉反应
    private readonly Border _bubble;
    private readonly TextBlock _bubbleText;
    private readonly Border _panel;
    private TextBlock _statusText = null!;   // 在 MakePanel()（构造函数内）里创建 —— 非只读
    private TextBlock _cpuText = null!;
    private TextBlock _memText = null!;
    private readonly Random _rng = new();

    private int _samples;             // 已看 N 轮
    private int? _trust;              // M7：内核报上来的亲密度
    private bool _panelOpen;
    private bool _movingAside;        // L4 躲开动画进行中（防重入；watchdog 兜底防卡死）

    public FloatWindow(KernelSidecar kernel)
    {
        _kernel = kernel;

        Title = "只只";
        Width = 320;
        Height = 250;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;         // 只有球（和展开的气泡/面板）参与命中
        Topmost = true;
        ShowActivated = false;                    // ⭐ 不抢焦点之一：出现时不激活
        ShowInTaskbar = false;
        ResizeMode = ResizeMode.NoResize;
        Deactivated += (_, _) => CollapsePanel();

        // ── 视觉树：Canvas 绝对定位（球右下角、气泡在球上方、面板在球左侧）──
        var canvas = new Canvas();

        _ballShake = new TranslateTransform();
        _ball = new Ellipse
        {
            Width = BallSize,
            Height = BallSize,
            Fill = MakeBallBrush(Colors.Teal),
            Cursor = Cursors.Hand,
            RenderTransform = _ballShake,
            ToolTip = "戳一下",
        };
        Canvas.SetRight(_ball, 18);
        Canvas.SetBottom(_ball, 14);
        _ball.MouseEnter += (_, _) => ExpandPanel();
        _ball.MouseLeftButtonUp += (_, _) => Poke();

        _bubble = new Border
        {
            Background = new SolidColorBrush(Color.FromRgb(0xFF, 0xFF, 0xFF)) { Opacity = 0.96 },
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(12, 8, 12, 8),
            MaxWidth = 250,
            Visibility = Visibility.Collapsed,
            Effect = null, // 阴影等加分项 b2 再说（DropShadowEffect 会让透明窗变重）
        };
        _bubbleText = new TextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            FontSize = 12.5,
            Foreground = new SolidColorBrush(Color.FromRgb(0x33, 0x33, 0x33)),
        };
        _bubble.Child = _bubbleText;
        // ⭐ P0-3（监工 2026-10-17）：气泡贴球**正上方**（不与面板同位），且 Z 序压在面板之上 ——
        //   「它刚说了句话」本就该盖过面板；此前气泡与面板几乎同位（Bottom 92 vs 90）且
        //   面板后加入在上层 → 鼠标在球上（点球前提）必然开着面板 → 气泡被完整盖住，一次都看不见。
        Canvas.SetRight(_bubble, 14);
        Canvas.SetBottom(_bubble, BallSize + 20);   // 球(bottom 14 + 64)顶在 78 → 气泡底 84，留 6px 间隙
        Panel.SetZIndex(_bubble, 10);               // 面板 Z 序默认 0 —— 气泡恒在其上
        _bubble.MouseEnter += (_, _) => ExpandPanel();   // 气泡上也算悬停（话没读完不收）

        _panel = MakePanel();
        Canvas.SetRight(_panel, BallSize + 30);     // 面板移到球**左侧**（与气泡位置错开）
        Canvas.SetBottom(_panel, 14);
        _panel.Visibility = Visibility.Collapsed;
        _panel.MouseLeave += (_, _) => { if (!_ball.IsMouseOver) CollapsePanel(); };

        canvas.Children.Add(_bubble);
        canvas.Children.Add(_panel);
        canvas.Children.Add(_ball);
        Content = canvas;

        // 窗口本身也要悬停展开（球之外还有气泡/面板 —— 移动到它们上面不能收）
        MouseEnter += (_, _) => ExpandPanel();

        // ── 状态 ──
        _idleTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _idleTimer.Tick += (_, _) => FeedIdle();
        _bubbleTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(4.5) };
        _bubbleTimer.Tick += (_, _) => HideBubble();

        // 内核事件（回调不在 UI 线程 → 一律 BeginInvoke 切回）
        _kernel.SampleArrived += s => Dispatcher.BeginInvoke(() => OnSample(s));
        _kernel.Said += said => Dispatcher.BeginInvoke(() => OnSaid(said));
        _kernel.Log += msg => Dispatcher.BeginInvoke(() => AppendLog(msg));

        SourceInitialized += (_, _) => ApplyNoActivate();
        Loaded += (_, _) =>
        {
            MoveToCorner();          // 默认右下角（记住位置等设置文件 b2 再说）
            _idleTimer.Start();
        };
        Closing += (_, _) =>
        {
            _idleTimer.Stop();
            _bubbleTimer.Stop();
            _kernel.Stop();          // ⚠️ 关窗必须收内核 —— 不留孤儿 node
        };
    }

    // ───────────────────────── 不抢焦点（决策 #27 已定口径）─────────────────────────
    private void ApplyNoActivate()
    {
        var hwnd = new System.Windows.Interop.WindowInteropHelper(this).Handle;
        var ex = Win32.GetExStyle(hwnd);
        Win32.SetExStyle(hwnd, ex | Win32.WS_EX_NOACTIVATE | Win32.WS_EX_TOOLWINDOW);
        AppendLog($"EXSTYLE 已打 NOACTIVATE+TOOLWINDOW（原值 0x{ex:X}）");
    }

    // ───────────────────────── 内核事件 → 视觉 ─────────────────────────

    private void OnSample(Sample s)
    {
        _samples++;
        if (s.Trust is { } t) _trust = t;
        _cpuText.Text = s.Cpu is { } c ? $"{c:F1}%" : "—";
        _memText.Text = s.Mem is { } m ? $"{m:F1}%" : "—";
        if (_panelOpen) UpdateStatusLine();
        // 状态变化 → 球色（已定动效口径：动的是颜色，不是形状；b1 用直接换色，过渡 b2）
        _ball.Fill = MakeBallBrush(BallColor(s));
    }

    private void OnSaid(SaidLine said)
    {
        ShowBubble(said.Text);
        if (_panelOpen) UpdateStatusLine();
        // L4（决策 #34）：poked@ 前缀 = 它决定「躲开」—— 外壳只做动作，说话归内核
        if (said.EventId.StartsWith("poked@", StringComparison.Ordinal)) MoveAside();
    }

    // ───────────────────────── M4-c 状态机制（原样复用）─────────────────────────

    private static Color BallColor(Sample s)
    {
        if (s.Cpu is not { } cpu) return Colors.Gray;                       // 还没数据 = 假寐（灰）
        if (cpu >= 80) return Color.FromRgb(0xE0, 0x6C, 0x4A);              // 偏暖（忙）
        return Colors.Teal;                                                 // 平常
    }

    private static string TrustWord(int? trust) => trust switch
    {
        null => "",
        >= 80 => "亲近",
        >= 40 => "熟悉",
        >= 10 => "陌生",
        _ => "沉默",
    };

    private string BaseStateText => (_kernel.IsRunning, _cpuText.Text) switch
    {
        (false, _) => "内核停了",
        (_, "—") => "看着呢",
        _ => $"看着呢 —— CPU {_cpuText.Text}",
    };

    private void UpdateStatusLine()
    {
        var word = TrustWord(_trust);
        _statusText.Text = word.Length == 0 ? BaseStateText : $"{BaseStateText} · {word}";
    }

    // ───────────────────────── 气泡（L2）─────────────────────────

    private void ShowBubble(string text)
    {
        _bubbleText.Text = text;
        _bubble.Visibility = Visibility.Visible;
        _bubble.Opacity = 0;
        _bubble.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180)));
        _bubbleTimer.Stop();
        _bubbleTimer.Start();       // 4.5s 后自动消失 —— 绝不永久驻留
        AppendLog($"气泡显示：{text}");
    }

    private void HideBubble()
    {
        _bubbleTimer.Stop();
        var anim = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(220));
        anim.Completed += (_, _) => _bubble.Visibility = Visibility.Collapsed;
        _bubble.BeginAnimation(OpacityProperty, anim);
        AppendLog("气泡已隐");
    }

    /// <summary>渲染冒烟专用：展开面板（复现「鼠标在球上」现场）＋ 显示气泡 —— 验证气泡不被盖住。</summary>
    public void ShowTestBubble(string text)
    {
        ExpandPanel();
        ShowBubble(text);
    }

    /// <summary>渲染冒烟专用：气泡/面板的可见性与透明度实况（诊断「为什么截图里没有」）。</summary>
    public string DumpVisualState() =>
        $"bubble(V={_bubble.Visibility} O={_bubble.Opacity:F2} W={_bubble.ActualWidth:F0} H={_bubble.ActualHeight:F0}) " +
        $"panel(V={_panel.Visibility} O={_panel.Opacity:F2}) ballO={_ball.Opacity:F2}";

    // ───────────────────────── 悬停面板 ─────────────────────────

    private Border MakePanel()
    {
        _statusText = new TextBlock
        {
            FontSize = 11.5,
            Foreground = new SolidColorBrush(Color.FromRgb(0x55, 0x55, 0x55)),
            Text = "正在把内核叫起来…",
        };
        _cpuText = new TextBlock { FontSize = 13, FontWeight = FontWeights.SemiBold };
        _memText = new TextBlock { FontSize = 13, FontWeight = FontWeights.SemiBold };

        var metrics = new StackPanel { Orientation = Orientation.Horizontal };
        metrics.Children.Add(new TextBlock { Text = "CPU ", FontSize = 12, Foreground = Brushes.Gray, VerticalAlignment = VerticalAlignment.Center });
        metrics.Children.Add(_cpuText);
        metrics.Children.Add(new TextBlock { Text = "   MEM ", FontSize = 12, Foreground = Brushes.Gray, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 0, 0) });
        metrics.Children.Add(_memText);

        var moveBtn = new Button { Content = "挪一挪", Padding = new Thickness(10, 3, 10, 3), Cursor = Cursors.Hand };
        moveBtn.Click += (_, _) => MoveAside();
        var exitBtn = new Button { Content = "退出", Padding = new Thickness(10, 3, 10, 3), Margin = new Thickness(8, 0, 0, 0), Cursor = Cursors.Hand };
        exitBtn.Click += (_, _) => Close();

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 0) };
        buttons.Children.Add(moveBtn);
        buttons.Children.Add(exitBtn);

        var stack = new StackPanel { Margin = new Thickness(2) };
        stack.Children.Add(_statusText);
        stack.Children.Add(metrics);
        stack.Children.Add(buttons);

        return new Border
        {
            Background = new SolidColorBrush(Color.FromRgb(0xFF, 0xFF, 0xFF)) { Opacity = 0.97 },
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(12, 9, 12, 9),
            Child = stack,
        };
    }

    private void ExpandPanel()
    {
        if (_panelOpen) return;
        _panelOpen = true;
        UpdateStatusLine();
        _panel.Visibility = Visibility.Visible;
        _panel.Opacity = 0;
        _panel.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(140)));
    }

    private void CollapsePanel()
    {
        if (!_panelOpen) return;
        _panelOpen = false;
        _panel.Visibility = Visibility.Collapsed;
    }

    // ───────────────────────── 戳一下（决策 #30：点球 = 戳）─────────────────────────

    private void Poke()
    {
        ShakeBall();                                   // L1：点击必须有反馈（球的视觉反应，不挪窗口）
        _kernel.Feed("{\"poked\":1}");                 // 外壳只报事实，裁决归 rule-poke（决策 #34）
        AppendLog("球被戳了一下 → 已喂 {\"poked\":1}");
    }

    private void ShakeBall()
    {
        if (_ballShake.HasAnimatedProperties) return;  // 抖动中再点 = 忽略（防重入）
        var kf = new DoubleAnimationUsingKeyFrames
        {
            Duration = TimeSpan.FromMilliseconds(150),
            // ⭐ P0-1（监工 2026-10-17）：必须 Stop —— 默认 HoldEnd 会让时钟在动画结束后
            //   仍持有属性 → HasAnimatedProperties 永久 True → guard 把第二次点球永久拦死。
            FillBehavior = FillBehavior.Stop,
        };
        // 相对偏移（监工 P0 的教训在变换域里天然成立：动的是 RenderTransform，永远不覆盖位置）
        kf.KeyFrames.Add(new LinearDoubleKeyFrame(0, TimeSpan.Zero));
        kf.KeyFrames.Add(new LinearDoubleKeyFrame(-4, TimeSpan.FromMilliseconds(30)));
        kf.KeyFrames.Add(new LinearDoubleKeyFrame(4, TimeSpan.FromMilliseconds(60)));
        kf.KeyFrames.Add(new LinearDoubleKeyFrame(-3, TimeSpan.FromMilliseconds(90)));
        kf.KeyFrames.Add(new LinearDoubleKeyFrame(3, TimeSpan.FromMilliseconds(120)));
        kf.KeyFrames.Add(new LinearDoubleKeyFrame(0, TimeSpan.FromMilliseconds(150)));
        // 双保险：Stop 之外再显式摘除时钟（幂等）—— 确保 guard 一定会松开
        kf.Completed += (_, _) => _ballShake.BeginAnimation(TranslateTransform.XProperty, null);
        _ballShake.BeginAnimation(TranslateTransform.XProperty, kf);
    }

    // ───────────────────────── 挪一挪（决策 #31 离开式随机）─────────────────────────

    /// <summary>离开式随机换位（L4「它自己躲开」也走这里）＋ 约 200ms 滑动过渡。</summary>
    private void MoveAside()
    {
        if (_movingAside) return;                      // 滑动中再点 = 忽略（防重入）
        var wa = SystemParameters.WorkArea;
        var target = RollAsideTarget(wa);
        _movingAside = true;

        var animX = new DoubleAnimation(Left, target.X, TimeSpan.FromMilliseconds(200)) { FillBehavior = FillBehavior.Stop };
        var animY = new DoubleAnimation(Top, target.Y, TimeSpan.FromMilliseconds(200)) { FillBehavior = FillBehavior.Stop };
        animX.Completed += (_, _) =>
        {
            Left = target.X;
            Top = target.Y;
            _movingAside = false;
            AppendLog($"挪到 ({target.X:F0},{target.Y:F0})");
        };
        BeginAnimation(LeftProperty, animX);
        BeginAnimation(TopProperty, animY);

        // ⭐ 监工观察②：若动画被异常打断，Completed 不会来 → 标志位永久卡住 → 之后再也挪不动。
        //   「不设超时的例外必须反问：结束事件永远不来呢？」→ 400ms 兜底强制清（幂等）。
        var watchdog = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
        watchdog.Tick += (_, _) =>
        {
            watchdog.Stop();
            if (_movingAside)
            {
                _movingAside = false;
                AppendLog("[WRN] 挪一挪动画未按时完成（watchdog 强制解锁）");
            }
        };
        watchdog.Start();
    }

    /// <summary>离开式随机：方向随机、位移 ≈ 自身 0.6~1.0 倍、clamp 工作区、中央 1/3 重抽；
    /// ⭐ clamp 吃位移防护（自检布尔判定抓到，与旧壳同源）：窗贴角落时朝角落抽会被 clamp
    /// 全额吃掉 → 位移 0（违背「避免挪 1 像素」）→ 位移不足就重抽，最多 4 次。
    /// （决策 #31 ④「允许回原位」仍由多次点击的随机性保证 —— 单次点击必须真的挪。）</summary>
    private Point RollAsideTarget(Rect wa)
    {
        var minShift = Math.Max(32, Math.Max(Width, Height) * 0.3);
        for (var attempt = 0; ; attempt++)
        {
            var angle = _rng.NextDouble() * Math.PI * 2;
            var dist = (0.6 + _rng.NextDouble() * 0.4) * Math.Max(Width, Height);
            var dx = Math.Cos(angle) * dist;
            var dy = Math.Sin(angle) * dist;
            var x = Clamp(Left + dx, wa.Left, wa.Right - Width);
            var y = Clamp(Top + dy, wa.Top, wa.Bottom - Height);
            var shifted = Math.Abs(x - Left) + Math.Abs(y - Top) >= minShift;
            var inCenterThird = x > wa.Left + wa.Width / 3.0 && x < wa.Left + wa.Width * 2.0 / 3.0
                             && y > wa.Top + wa.Height / 3.0 && y < wa.Top + wa.Height * 2.0 / 3.0;
            if ((shifted && !inCenterThird) || attempt >= 3)        // 中央 1/3 重抽；位移不足也重抽
                return new Point(x, y);
        }
    }

    private static double Clamp(double v, double min, double max) =>
        max < min ? min : Math.Min(max, Math.Max(min, v));

    private void MoveToCorner()
    {
        var wa = SystemParameters.WorkArea;
        Left = wa.Right - Width - 24;
        Top = wa.Bottom - Height - 24;
    }

    // ───────────────────────── 反向通道喂食 ─────────────────────────

    private void FeedIdle()
    {
        var idle = Win32.GetIdleMs();
        if (idle is { } ms) _kernel.Feed($"{{\"idleMs\":{ms:F0}}}");
        // 拿不到 = 「不知道你闲不闲」—— 不喂、不猜（宁可不传也不传错）
    }

    // ───────────────────────── 日志（内存环形缓冲 + 落盘；日志窗 b2 再做）─────────
    private readonly List<string> _logs = new();
    private readonly object _logLock = new();

    private void AppendLog(string msg)
    {
        lock (_logLock)
        {
            _logs.Add($"[{DateTime.Now:HH:mm:ss}] {msg}");
            if (_logs.Count > 100) _logs.RemoveAt(0);
        }
        ShellLog.Write(msg);   // ⭐ 观察⑤：关键动作落盘（点球/挪一挪/气泡显隐/内核日志都走这里）
    }

    public string DumpLogs()
    {
        lock (_logLock) { return string.Join(Environment.NewLine, _logs); }
    }

    // ───────────────────────── 小工具 ─────────────────────────

    private static Brush MakeBallBrush(Color c) => new RadialGradientBrush
    {
        GradientStops =
        {
            new GradientStop(Lighten(c, 0.35), 0.0),
            new GradientStop(c, 0.75),
            new GradientStop(Lighten(c, -0.25), 1.0),
        },
    };

    private static Color Lighten(Color c, double amount) => Color.FromRgb(
        (byte)Clamp255(c.R + 255 * amount),
        (byte)Clamp255(c.G + 255 * amount),
        (byte)Clamp255(c.B + 255 * amount));

    private static double Clamp255(double v) => Math.Min(255, Math.Max(0, v));
}
