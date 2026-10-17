using System.IO;
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
    private const double DragThreshold = 4;   // 位移 < 4px 松手 = 戳，≥ 4px = 拖（与系统 MinimumHorizontalDragDistance 同量级）
    // 球在窗口 Canvas 里的边距（单一事实源 —— Canvas 定位与 clamp 都用它们）
    private const double BallRightMargin = 18;    // 球右缘距窗右（X 右锚）
    private const double BallLeftMargin = 18;     // 球左缘距窗左（X 左锚，翻转后）
    private const double BallBottomMargin = 14;   // 球下缘距窗下（Y 底锚）
    private const double BallTopMargin = 14;      // 球上缘距窗顶（Y 顶锚，翻转后）

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
    private bool _dragging;           // 拖动进行中（球上按下并捕获鼠标后）
    private bool _dragMoved;          // 位移是否超阈值 —— 决定松手算「拖」还是「戳」
    private Point _dragStartScreen;   // 按下瞬间：鼠标屏幕 DIP 坐标（⭐ 屏幕坐标不随窗口移动 —— 唯一稳的基准）
    private Point _dragStartBall;     // 按下瞬间：球的屏幕位置（拖动改记球 —— 窗口锚可翻转，球才是稳定参照）
    private DispatcherTimer _panelCloseTimer = null!;           // 面板宽限收起（300ms 内摸回来就取消）

    // ── b2-a（开工单 ①②）──
    private long? _muteUntil;                          // 静音截止 epoch ms；null = 未静音
    private const long MuteDurationMs = 60 * 60 * 1000; // 「静一下」= 1 小时（决策 #30；必须有明确结束）
    private Button _muteBtn = null!;                   // 面板「静一下 / 恢复」按钮

    // ── b2-b1（托盘）──
    private System.Windows.Forms.NotifyIcon? _tray;
    private System.Windows.Forms.ToolStripMenuItem? _trayShowItem;   // 显示/隐藏球（文案随状态）
    private System.Windows.Forms.ToolStripMenuItem? _trayMuteItem;   // 静一下/恢复（文案同步面板）
    private bool _ballHidden;

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
        Canvas.SetRight(_ball, BallRightMargin);
        Canvas.SetBottom(_ball, BallBottomMargin);
        // ⭐ 悬停 + 拖动 + 戳三合一（2026-10-17 修复：拖动是旧壳有、WPF 移植时漏掉的）：
        //   按下捕获鼠标 → 位移 ≥4px = 拖（拖起来顺带收面板）；位移 <4px 松手 = 戳。
        //   MouseLeave 走 300ms 宽限收起 —— 球↔面板往返不闪断，往别处移走就收。
        _ball.MouseEnter += (_, _) => { _panelCloseTimer.Stop(); ExpandPanel(); };
        _ball.MouseLeave += (_, _) => StartPanelCloseGrace();
        _ball.MouseLeftButtonDown += OnBallDragStart;
        _ball.MouseMove += OnBallDragMove;
        _ball.MouseLeftButtonUp += OnBallDragEnd;
        _ball.LostMouseCapture += (_, _) => EndDrag();           // 捕获被系统抢走也走同一收尾（观察③）

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
        _bubble.MouseEnter += (_, _) => { _panelCloseTimer.Stop(); ExpandPanel(); };   // 气泡上也算悬停（话没读完不收）
        _bubble.MouseLeave += (_, _) => StartPanelCloseGrace();

        _panel = MakePanel();
        Canvas.SetRight(_panel, BallSize + 30);     // 面板移到球**左侧**（与气泡位置错开）
        Canvas.SetBottom(_panel, 14);
        _panel.Visibility = Visibility.Collapsed;
        _panel.MouseEnter += (_, _) => _panelCloseTimer.Stop();
        _panel.MouseLeave += (_, _) => StartPanelCloseGrace();

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

        // 面板宽限收起（2026-10-17 修复）：球/面板/气泡任一 MouseLeave → 300ms 后收；
        // 宽限期内摸回来（球↔面板之间的 30px 空隙、面板→球等路径）→ Tick 一查还悬停着 → 取消。
        // 旧逻辑只挂「面板离开才收」+「失焦收」，而 NOACTIVATE 窗口永不激活 → 失焦是死路 →
        // 从球上直接移走面板永远不收（用户实测确认）。
        _panelCloseTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(300) };
        _panelCloseTimer.Tick += (_, _) =>
        {
            _panelCloseTimer.Stop();
            if (!_ball.IsMouseOver && !_panel.IsMouseOver && !_bubble.IsMouseOver) CollapsePanel();
        };

        // 内核事件（回调不在 UI 线程 → 一律 BeginInvoke 切回）
        _kernel.SampleArrived += s => Dispatcher.BeginInvoke(() => OnSample(s));
        _kernel.Said += said => Dispatcher.BeginInvoke(() => OnSaid(said));
        _kernel.Log += msg => Dispatcher.BeginInvoke(() => AppendLog(msg));

        InitTray();   // b2-b1 ②：托盘图标（五项菜单 + 双击显隐）—— 「回到右下角」是球被拖丢的唯一找回后路

        SourceInitialized += (_, _) => ApplyNoActivate();
        Loaded += (_, _) =>
        {
            LoadSettingsOrCorner();  // b2-a ①：读 shell.json 恢复位置（越界回落右下角），没有才默认角落
            _idleTimer.Start();
            FeedIdle();              // greeting 插队：立即喂第一帧 context —— 打招呼零延迟（否则要等 1s）
        };
        Closing += (_, _) =>
        {
            _idleTimer.Stop();
            _bubbleTimer.Stop();
            SaveSettings();          // ⭐ b2-a ①②：关窗写位置 + 静音（写盘点只有拖动结束与此处）
            if (_tray is { } tray)   // ⭐ 不收托盘 = 残留幽灵图标（要鼠标划过才消失）
            {
                tray.Visible = false;
                tray.Dispose();
                _tray = null;
            }
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
        var baseText = BaseStateText;
        // b2-a 复验观察1：静音只在**常态**下占位 —— 「内核停了」是 M4-c 核心契约，
        // 优先级更高，绝不能被「静音中 · 剩 N 分」盖住（静音期间内核崩了必须看得见）。
        if (IsMuted && _kernel.IsRunning)
        {
            var mins = Math.Max(0, (int)Math.Ceiling((_muteUntil!.Value - EpochNow()) / 60000.0));
            baseText = $"静音中 · 剩 {mins} 分";
        }
        _statusText.Text = word.Length == 0 ? baseText : $"{baseText} · {word}";
    }

    // ───────────────────────── 气泡（L2）─────────────────────────

    private void ShowBubble(string text)
    {
        UpdateOverlayPlacement();   // b2-a 复验观察2：气泡同样自适应（球贴上缘 → 翻转后挂球下方）
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
        // b2-a ②「静一下」（决策 #30 面板三按钮补齐）：点 = 静音 1 小时；静音中变「恢复」，点 = 立刻取消
        _muteBtn = new Button { Content = "静一下", Padding = new Thickness(10, 3, 10, 3), Margin = new Thickness(8, 0, 0, 0), Cursor = Cursors.Hand };
        _muteBtn.Click += (_, _) => ToggleMute();
        var exitBtn = new Button { Content = "退出", Padding = new Thickness(10, 3, 10, 3), Margin = new Thickness(8, 0, 0, 0), Cursor = Cursors.Hand };
        exitBtn.Click += (_, _) => Close();

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 0) };
        buttons.Children.Add(moveBtn);
        buttons.Children.Add(_muteBtn);
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
        UpdateOverlayPlacement();   // b2-a 复验观察2：先按当前球位自适应方向（幂等）—— 面板绝不整块出屏
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

    /// <summary>启动面板宽限收起：300ms 内摸回球/面板/气泡就取消，否则收。
    /// ⭐ 观察②（监工 2026-10-17）：拖动中鼠标会甩离球（快速甩动必触发）——此时不起宽限，
    ///   否则面板收了又被 MouseEnter 拉开 = 拖动途中面板闪烁。</summary>
    private void StartPanelCloseGrace()
    {
        if (_dragging) return;
        _panelCloseTimer.Stop();
        _panelCloseTimer.Start();
    }

    // ───────────────────────── 拖动（M4-b1 补课：旧壳有、WPF 移植时漏了）─────────────────────────
    // 口径：按下捕获鼠标 → 位移 ≥ 4px = 拖（收面板 + 移窗）；位移 < 4px 松手 = 戳。
    // ⭐ 基准必须是「屏幕 DIP 坐标」（监工 P0 · 2026-10-17，两轮返工的教训）：
    //   GetPosition 是相对窗口的 —— 参考系随窗口一起动，上一帧存的任何**相对**基准
    //   （无论是绝对式的起点还是增量式的 _dragLastMouse）在窗口一动后就作废：
    //   绝对式 → 原地振荡（闪烁）；增量式 → 稳态速度只有鼠标一半（不跟手）。
    //   屏幕坐标 = GetPosition + (Left, Top)，窗口怎么移它恒定不变（监工实测自证），
    //   与旧壳 Move-Drag 的 WinForms 屏幕坐标同构。⚠️ 必须在本帧移动窗口**之前**取。
    // clamp（监工观察①）：球 Topmost 且无任务栏图标，拖出屏幕 = 只能杀进程 → 每帧 clamp 工作区。

    /// <summary>鼠标的屏幕 DIP 坐标（WindowStyle=None 下外框=内容区左上，公式成立；将来加边框须改 PointToScreen+DPI）。</summary>
    private Point ScreenDip(MouseEventArgs e)
    {
        var p = e.GetPosition(this);
        return new Point(p.X + Left, p.Y + Top);   // ⚠️ 必须在移动窗口之前调用（用移动前的 Left/Top）
    }

    private void OnBallDragStart(object sender, MouseButtonEventArgs e)
    {
        if (_movingAside) return;      // Left/Top 正被「挪一挪」动画持有 —— 不抢（防打架）
        _dragStartScreen = ScreenDip(e);
        _dragStartBall = new Point(BallScreenLeft, BallScreenTop);   // 记球不记窗 —— 窗口锚可翻转，球才是稳定参照
        _dragging = true;
        _dragMoved = false;
        _panelCloseTimer.Stop();       // 观察②：拖动期间面板别闪
        _ball.CaptureMouse();          // 捕获后 Move/Up 全路由给球，鼠标滑出球也不丢事件
    }

    private void OnBallDragMove(object sender, MouseEventArgs e)
    {
        if (!_dragging) return;
        var s = ScreenDip(e);          // ⚠️ 先取屏幕坐标，再动窗口 —— 顺序反了基准就不配套
        if (!_dragMoved &&
            Math.Abs(s.X - _dragStartScreen.X) < DragThreshold &&
            Math.Abs(s.Y - _dragStartScreen.Y) < DragThreshold) return;
        _dragMoved = true;
        if (_panelOpen) CollapsePanel();   // 都拖起来了，面板没存在意义
        // ⭐ 观察4（b2-a ③）：clamp **以球为准** —— 球整体留在工作区内，窗口透明部分可出屏；
        //   拖动过程不做方向自适应（面板已收起），松手 ExpandPanel 时统一重排。
        var win = ClampForBall(SystemParameters.WorkArea, _dragStartBall.X + (s.X - _dragStartScreen.X), _dragStartBall.Y + (s.Y - _dragStartScreen.Y));
        Left = win.Left;
        Top = win.Top;
    }

    private void OnBallDragEnd(object sender, MouseButtonEventArgs e) => EndDrag();

    /// <summary>拖动收尾（松手 / LostMouseCapture 共用，幂等）。
    /// ⭐ 必须**显式** ReleaseMouseCapture —— WPF 的 CaptureMouse 是显式捕获，松手**不会**自动释放
    ///   （自动释放的只是 WPF 内部隐式捕获；显式捕获须手动 Release / 被别处抢走 / 窗口失活，
    ///   而本窗 NOACTIVATE 永不失活 → 不释放 = 捕获被球永久攥住：所有鼠标事件只路由给球，
    ///   悬停球无 MouseEnter、悬停面板收不到事件 → 面板再也出不来，2026-10-17 用户实测踩坑）。
    ///   重入安全：先把 _dragging 置 false 再 Release —— LostMouseCapture 再进 EndDrag 时
    ///   幂等守卫直接拦住（监工观察③担心的重入是这么避的，不是靠不释放）。</summary>
    private void EndDrag()
    {
        if (!_dragging) return;
        _dragging = false;
        if (Mouse.Captured == _ball) _ball.ReleaseMouseCapture();
        if (!_dragMoved)
        {
            Poke();                            // 原地单击 = 戳（位移没过阈值）
            if (_ball.IsMouseOver) ExpandPanel();   // 点完球面板就该在（悬停球 = 面板开 的不变式）
            return;
        }
        AppendLog($"拖动结束 → ({Left:F0},{Top:F0})");
        SaveSettings();   // ⭐ b2-a ①：拖动结束时写一次位置（写盘点只有这里和关窗，绝不在 MouseMove 里写）
        if (_ball.IsMouseOver) ExpandPanel();       // 拖完鼠标还在球上 → 面板立刻回来，不用移出再移回
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

    /// <summary>离开式随机换位（L4「它自己躲开」也走这里）＋ 约 200ms 滑动过渡。
    /// b2-a 复验：改滚**球**的目标位置（锚可翻转，窗口坐标不是稳定参照），完成后重排覆盖物方向。</summary>
    private void MoveAside()
    {
        if (_movingAside) return;                      // 滑动中再点 = 忽略（防重入）
        var wa = SystemParameters.WorkArea;
        var ballTarget = RollAsideTarget(wa);          // 球的期望屏幕位置（已 clamp 工作区）
        var winTarget = ClampForBall(wa, ballTarget.X, ballTarget.Y);
        _movingAside = true;

        var animX = new DoubleAnimation(Left, winTarget.Left, TimeSpan.FromMilliseconds(200)) { FillBehavior = FillBehavior.Stop };
        var animY = new DoubleAnimation(Top, winTarget.Top, TimeSpan.FromMilliseconds(200)) { FillBehavior = FillBehavior.Stop };
        animX.Completed += (_, _) =>
        {
            Left = winTarget.Left;
            Top = winTarget.Top;
            _movingAside = false;
            UpdateOverlayPlacement();                  // 挪完球位变了 → 面板/气泡方向跟着重排（面板开着时尤其要紧）
            AppendLog($"挪到 球=({BallScreenLeft:F0},{BallScreenTop:F0})");
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

    /// <summary>离开式随机：方向随机、位移 ≈ 窗口 0.6~1.0 倍、**球** clamp 工作区、中央 1/3 重抽；
    /// ⭐ clamp 吃位移防护（自检布尔判定抓到，与旧壳同源）：贴边时朝角落抽会被 clamp
    /// 全额吃掉 → 位移 0（违背「避免挪 1 像素」）→ 位移不足就重抽，最多 4 次。
    /// （决策 #31 ④「允许回原位」仍由多次点击的随机性保证 —— 单次点击必须真的挪。）
    /// 返回**球的期望屏幕位置**（b2-a 复验：锚可翻转，滚球不滚窗）。</summary>
    private Point RollAsideTarget(Rect wa)
    {
        var ballLeft = BallScreenLeft;
        var ballTop = BallScreenTop;
        var minShift = Math.Max(32, Math.Max(Width, Height) * 0.3);
        for (var attempt = 0; ; attempt++)
        {
            var angle = _rng.NextDouble() * Math.PI * 2;
            var dist = (0.6 + _rng.NextDouble() * 0.4) * Math.Max(Width, Height);
            var dx = Math.Cos(angle) * dist;
            var dy = Math.Sin(angle) * dist;
            var x = Clamp(ballLeft + dx, wa.Left, wa.Right - BallSize);
            var y = Clamp(ballTop + dy, wa.Top, wa.Bottom - BallSize);
            var shifted = Math.Abs(x - ballLeft) + Math.Abs(y - ballTop) >= minShift;
            var inCenterThird = x > wa.Left + wa.Width / 3.0 && x < wa.Left + wa.Width * 2.0 / 3.0
                             && y > wa.Top + wa.Height / 3.0 && y < wa.Top + wa.Height * 2.0 / 3.0;
            if ((shifted && !inCenterThird) || attempt >= 3)        // 中央 1/3 重抽；位移不足也重抽
                return new Point(x, y);
        }
    }

    private static double Clamp(double v, double min, double max) =>
        max < min ? min : Math.Min(max, Math.Max(min, v));

    /// <summary>把**球的期望屏幕位置** clamp 进工作区（球必须整体可见 —— 验收④），再按当前
    /// Y 锚反推窗口位置（窗口透明部分可出屏）。拖动 / 挪一挪 / shell.json 校验共用 —— 口径必须一致。
    /// ⭐ 输入输出都是「球进、窗出」：锚可垂直翻转（UpdateOverlayPlacement），窗口坐标不是稳定参照。</summary>
    private (double Left, double Top) ClampForBall(Rect wa, double ballLeft, double ballTop)
    {
        var bl = Clamp(ballLeft, wa.Left, wa.Right - BallSize);
        var bt = Clamp(ballTop, wa.Top, wa.Bottom - BallSize);
        return (
            _ballLeftAnchored ? bl - BallLeftMargin : bl - (Width - BallRightMargin - BallSize),
            _ballTopAnchored ? bt - BallTopMargin : bt - (Height - BallBottomMargin - BallSize));
    }

    // ───────────────────────── 覆盖物方向自适应（b2-a 复验观察2）─────────────────────────
    // clamp 以球为准后窗口可出屏 → 面板（贴球左）与气泡（贴球上）可能整块出屏、退出按钮点不到。
    // 口径（监工）：**不做 clamp 留余量**（与验收④「球能拖到最边」直接冲突），做方向自适应：
    //   气泡：球贴上缘放不下 → **窗口垂直翻转**（球改贴窗顶、窗口向下延伸），气泡改到球下方；
    //   面板：球左侧放不下 → 改挂球的上方（翻转后为下方）、左缘与球对齐（不再向左伸）。
    // ⭐ 翻转前后球的屏幕位置不变 —— 挪的只是窗口的透明部分。几何事实：窗口 320×250、球贴右下，
    //   球上方有 172 DIP、左方有 238 DIP，而球下方只有 14 DIP → 「气泡改下方」必须靠翻转才有空间。

    private bool _ballTopAnchored;   // false=球贴窗底（默认，窗口向上伸）；true=球贴窗顶（翻转，窗口向下伸）
    private bool _ballLeftAnchored;  // false=球贴窗右（默认，窗口向左伸）；true=球贴窗左（翻转，窗口向右伸）

    private double BallScreenLeft => _ballLeftAnchored ? Left + BallLeftMargin : Left + Width - BallRightMargin - BallSize;
    private double BallScreenTop => _ballTopAnchored ? Top + BallTopMargin : Top + Height - BallBottomMargin - BallSize;

    /// <summary>按当前球位重排面板/气泡方向（幂等）。展开面板、冒气泡、挪一挪完成、启动恢复时调用。
    /// ⭐ X、Y 两轴同构翻转：**防的是窗口边界，不是屏幕边界**（监工 2026-10-17 下午：
    ///   面板真实 206 DIP，球右锚时窗内球左侧只有 238-面板宽……球贴左缘改「向右伸展」会被
    ///   窗口右缘裁掉 124 —— 窗口才 320 宽，Math.Min 防屏幕毫无用处）。翻转前后球屏幕位置不变。</summary>
    private void UpdateOverlayPlacement()
    {
        var wa = SystemParameters.WorkArea;
        var ballLeft = BallScreenLeft;
        var ballTop = BallScreenTop;
        var panelW = _panel.ActualWidth > 0 ? _panel.ActualWidth : 210;    // 首次展开前无实测值（实测 206，宁大勿小）
        var panelH = _panel.ActualHeight > 0 ? _panel.ActualHeight : 80;
        var bubbleH = _bubble.ActualHeight > 0 ? _bubble.ActualHeight : 60;

        var panelFitsLeft = ballLeft - 30 - panelW >= wa.Left;   // 球左侧的**屏内**空间够面板
        var needFlipY = ballTop - 20 - bubbleH < wa.Top                       // 气泡上方放不下
                     || (!panelFitsLeft && ballTop - 8 - panelH < wa.Top);
        var needFlipX = !panelFitsLeft;                          // 球贴左 → 球改贴窗左、面板挂球右侧

        // ── Y 锚翻转（幂等）：锚与窗口位置一起换，球屏幕位置不动 ──
        if (needFlipY != _ballTopAnchored)
        {
            _ballTopAnchored = needFlipY;
            if (needFlipY) { Canvas.SetBottom(_ball, double.NaN); Canvas.SetTop(_ball, BallTopMargin); }
            else { Canvas.SetTop(_ball, double.NaN); Canvas.SetBottom(_ball, BallBottomMargin); }
            AppendLog($"覆盖物方向 Y：{(needFlipY ? "翻转（球贴窗顶 → 气泡/面板挂球下方）" : "常规（球贴窗底）")}");
        }

        // ── X 锚翻转（幂等，与 Y 同构）：球贴窗左、窗口向右延伸 → 面板挂球右侧 ──
        if (needFlipX != _ballLeftAnchored)
        {
            _ballLeftAnchored = needFlipX;
            if (needFlipX) { Canvas.SetRight(_ball, double.NaN); Canvas.SetLeft(_ball, BallLeftMargin); }
            else { Canvas.SetLeft(_ball, double.NaN); Canvas.SetRight(_ball, BallRightMargin); }
            AppendLog($"覆盖物方向 X：{(needFlipX ? "翻转（球贴窗左 → 面板挂球右侧）" : "常规（球贴窗右 → 面板球左）")}");
        }

        Left = _ballLeftAnchored ? ballLeft - BallLeftMargin : ballLeft - (Width - BallRightMargin - BallSize);
        Top = _ballTopAnchored ? ballTop - BallTopMargin : ballTop - (Height - BallBottomMargin - BallSize);

        // ── 气泡：贴球上方，X 随球锚（右锚偏右 / 左锚偏左）──
        if (_ballLeftAnchored) { Canvas.SetRight(_bubble, double.NaN); Canvas.SetLeft(_bubble, BallLeftMargin); }
        else { Canvas.SetLeft(_bubble, double.NaN); Canvas.SetRight(_bubble, 14); }
        if (_ballTopAnchored) { Canvas.SetBottom(_bubble, double.NaN); Canvas.SetTop(_bubble, BallTopMargin + BallSize + 6); }
        else { Canvas.SetTop(_bubble, double.NaN); Canvas.SetBottom(_bubble, BallSize + 20); }

        // ── 面板：X = 球左（右锚）／球右（左锚，窗内 [112,318] 实测放得下）；Y = 底对齐／顶对齐 ──
        if (_ballLeftAnchored)
        {
            Canvas.SetRight(_panel, double.NaN);
            Canvas.SetLeft(_panel, BallLeftMargin + BallSize + 30);
        }
        else
        {
            Canvas.SetLeft(_panel, double.NaN);
            Canvas.SetRight(_panel, BallSize + 30);
        }
        if (_ballTopAnchored) { Canvas.SetBottom(_panel, double.NaN); Canvas.SetTop(_panel, BallTopMargin); }
        else { Canvas.SetTop(_panel, double.NaN); Canvas.SetBottom(_panel, 14); }
    }

    private void MoveToCorner()
    {
        var wa = SystemParameters.WorkArea;
        Left = wa.Right - Width - 24;
        Top = wa.Bottom - Height - 24;
    }

    // ───────────────────────── 反向通道喂食 ─────────────────────────

    private void FeedIdle()
    {
        UpdateMuteUi();   // 1Hz：倒计时刷新 + 到点自然解除（按钮/状态跟着翻回来）
        var idle = Win32.GetIdleMs();
        if (idle is { } ms)
        {
            // b2-a ②：muteUntil 随 idleMs 一起喂。**每秒都喂真值**（0 = 未静音）——
            // 内核按「每喂必真值」处理，点「恢复」后旧的未来时刻不能留在内核里。
            var mute = IsMuted ? _muteUntil!.Value : 0;
            _kernel.Feed($"{{\"idleMs\":{ms:F0},\"muteUntil\":{mute}}}");
        }
        // 拿不到 = 「不知道你闲不闲」—— 不喂、不猜（宁可不传也不传错）
    }

    // ───────────────────────── b2-a ②「静一下」（决策 #30；只压它自己开口，不压你戳它）───

    private static long EpochNow() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>静音是否生效（到点自动失效 —— 「必须有明确结束」）。</summary>
    private bool IsMuted => _muteUntil is { } m && m > EpochNow();

    private void ToggleMute()
    {
        if (IsMuted)
        {
            _muteUntil = null;
            AppendLog("静音已恢复（立刻能说）");
        }
        else
        {
            _muteUntil = EpochNow() + MuteDurationMs;
            AppendLog("静音 1 小时（chitchat 停；戳与告警不受影响）");
        }
        UpdateMuteUi();
    }

    /// <summary>按钮文案「静一下 ↔ 恢复」+ 状态区倒计时。1Hz 由 FeedIdle 驱动。
    /// b2-a 复验小项1：值没变不赋值 —— 1Hz 无条件赋 Content 会每次触发属性变更＋重排。</summary>
    private void UpdateMuteUi()
    {
        var content = IsMuted ? "恢复" : "静一下";
        if (!Equals(_muteBtn.Content, content)) _muteBtn.Content = content;
        if (_trayMuteItem is { } trayItem && trayItem.Text != content) trayItem.Text = content;   // 托盘文案同步
        if (_panelOpen) UpdateStatusLine();
    }

    // ───────────────────────── b2-b1 ② 托盘图标（NotifyIcon 来自 WinForms，全限定名）─────────
    // 菜单五项：显示/隐藏球 ／ 静一下（复用 ToggleMute）／ 回到右下角 ／ 开机自启（勾选）／ 退出。
    // 「回到右下角」是球被拖丢后唯一的找回后路；双击托盘 = 显示/隐藏。图标程序生成（圆点），不卡素材。

    private void InitTray()
    {
        _trayShowItem = new System.Windows.Forms.ToolStripMenuItem("隐藏球");
        _trayShowItem.Click += (_, _) => ToggleBallVisible();

        _trayMuteItem = new System.Windows.Forms.ToolStripMenuItem("静一下");
        _trayMuteItem.Click += (_, _) => ToggleMute();

        var homeItem = new System.Windows.Forms.ToolStripMenuItem("回到右下角");
        homeItem.Click += (_, _) =>
        {
            MoveToCorner();
            UpdateOverlayPlacement();
            SaveSettings();   // 位置变了就落盘（口径与拖动结束一致）
            AppendLog("托盘：回到右下角");
        };

        var autoStartItem = new System.Windows.Forms.ToolStripMenuItem("开机自启")
        {
            CheckOnClick = true,
            Checked = AutoStart.IsEnabled(),   // 默认关 —— 自启是侵入性的，用户勾了才写
        };
        autoStartItem.Click += (_, _) =>
        {
            try
            {
                AutoStart.SetEnabled(autoStartItem.Checked);
                AppendLog($"托盘：开机自启 {(autoStartItem.Checked ? "开" : "关")}");
            }
            catch (Exception ex)
            {
                autoStartItem.Checked = !autoStartItem.Checked;   // 写失败回滚勾选，别让 UI 与实际脱节
                AppendLog($"[WRN] 开机自启写入失败：{ex.Message}");
            }
        };

        var exitItem = new System.Windows.Forms.ToolStripMenuItem("退出");
        exitItem.Click += (_, _) => Close();

        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.AddRange(new System.Windows.Forms.ToolStripItem[]
        {
            _trayShowItem, _trayMuteItem, homeItem, autoStartItem, new System.Windows.Forms.ToolStripSeparator(), exitItem,
        });

        _tray = new System.Windows.Forms.NotifyIcon
        {
            Icon = MakeTrayIcon(),
            Text = "只只 —— 系统生命体征助手",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _tray.DoubleClick += (_, _) => ToggleBallVisible();
    }

    /// <summary>程序生成托盘图标：32×32 青绿圆点（径向感两层圆），不依赖素材文件。</summary>
    private static System.Drawing.Icon MakeTrayIcon()
    {
        using var bmp = new System.Drawing.Bitmap(32, 32);
        using (var g = System.Drawing.Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using var body = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(0x1F, 0x8A, 0x7A));   // 深青绿
            using var glow = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(0x6F, 0xD8, 0xC0));   // 高光
            g.FillEllipse(body, 2, 2, 28, 28);
            g.FillEllipse(glow, 9, 8, 10, 10);
        }
        return System.Drawing.Icon.FromHandle(bmp.GetHicon());   // 句柄随进程回收 —— 应用生命周期托盘常驻，不另释放
    }

    /// <summary>显示/隐藏球（托盘菜单 + 双击共用）。内核照常跑 —— 隐藏只是把球收起来。</summary>
    private void ToggleBallVisible()
    {
        _ballHidden = !_ballHidden;
        if (_ballHidden) Hide(); else Show();
        if (_trayShowItem is { } item) item.Text = _ballHidden ? "显示球" : "隐藏球";
        AppendLog(_ballHidden ? "托盘：球已隐藏" : "托盘：球已显示");
    }

    // ───────────────────────── b2-a ①位置记忆（%APPDATA%\zhizhi\shell.json）─────────
    // 口径（开工单）：**只在拖动结束与关窗时写**，绝不在 MouseMove 里写（旧壳踩过高频写盘）；
    // 读：启动时恢复；越界（改分辨率/拔副屏）→ clamp 回球可见范围，球完全出屏才回落右下角。

    private void LoadSettingsOrCorner()
    {
        var saved = ShellSettings.TryLoad();
        var wa = SystemParameters.WorkArea;
        // 档案存的是**球**的屏幕位置（锚可翻转，窗口坐标不是稳定参照）；null/越界 → 回落右下角
        if (saved?.BallLeft is { } bl && saved.BallTop is { } bt
            && double.IsFinite(bl) && double.IsFinite(bt)
            && new Rect(bl, bt, BallSize, BallSize).IntersectsWith(wa))
        {
            var win = ClampForBall(wa, bl, bt);   // 部分出屏 → 拉回球可见范围
            Left = win.Left;
            Top = win.Top;
            UpdateOverlayPlacement();             // 恢复完立即定锚（球贴上缘 → 翻转）
            AppendLog($"启动位置 球=({BallScreenLeft:F0},{BallScreenTop:F0})（来自 shell.json）");
        }
        else
        {
            MoveToCorner();
            UpdateOverlayPlacement();
            AppendLog(saved is null || saved.BallLeft is null || saved.BallTop is null
                ? "启动位置：默认右下角（无设置文件或旧格式档案）"
                : "启动位置：默认右下角（存档越界，球已不在屏内）");
        }

        // b2-a ②：重启后仍然静音、到点自然失效（「必须有明确结束」在重启后仍成立）
        if (saved is { MuteUntil: > 0 }) _muteUntil = saved.MuteUntil;
        UpdateMuteUi();
    }

    private void SaveSettings()
    {
        // 没定位好（NaN）就别写 —— 宁可不传也不传错
        if (!double.IsFinite(Left) || !double.IsFinite(Top)) return;
        new ShellSettings { BallLeft = BallScreenLeft, BallTop = BallScreenTop, MuteUntil = _muteUntil ?? 0 }.TrySave();
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
