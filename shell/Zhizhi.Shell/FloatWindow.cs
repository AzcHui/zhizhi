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
    private const double BallSize = 76;   // b2-b2：64→76 —— ±5~12px 的形变才看得出来（clamp/位置/存档全是相对计算，改一处即安全）

    // ══════════ b2-b2 第一版 · 形态库 ＋ 陀螺仪（照抄开工单 2026-10-19 14:12 B 版）—— 调手感只改这一块 ══════════
    // ⛔ 禁忌 a：环不自转 —— 环上取点 a 不加时间（绕自己法线转看不见，坑 1）；
    // ⛔ 禁忌 b：三个环倾角必须两两不同（同倾角 = 对全局旋转响应相同 = 看起来是死的）。
    // 可见的运动只有两个来源：全局 rotY（三环共用）＋ 各环独立的进动（倾角慢漂移）。

    /// <summary>三环参数表（倾角基准 X/Y/Z · 半径比 · 线宽 · 亮度 · 进动 pf/pp · 亮点 spin/head）—— 全部照抄，倾角与 pf 别动。</summary>
    private sealed record GyroRing(double Tx0, double Ty0, double Tz0, double Radius, double Width, double Lum, double Pf, double Pp, double DotSpin, double DotHead);
    private static readonly GyroRing[] GyroRings =
    {
        new(1.20,  0.00,  0.00, 1.00, 2.2, 1.00, 0.31, 0.0,  0.55, 0.0),   // 环①
        new(-0.55, 0.75,  0.30, 0.72, 1.9, 0.74, 0.24, 2.3, -0.36, 2.1),   // 环②（亮点反向）
        new(0.35, -0.90,  1.10, 0.47, 1.6, 0.52, 0.19, 4.4,  0.22, 4.2),   // 环③
    };

    private const double GyroRadius = BallSize * 0.335;   // 基准半径 25.5 —— 三环分别再乘 1.00/0.72/0.47
    private const double GyroRotX = -0.22;                // 全局视角俯仰（固定）
    private const double GyroVySpeed = 0.17;              // 全局 rotY 速度（B 版定案；≈37s 一圈）—— 环的可见运动全靠这个
    private const double GyroFc = 5.2;                    // 透视焦距（相对 R）：s = Fc/(Fc+z)
    private const int GyroDepthBands = 6;                 // 深度分 6 档合并（坑 3：别逐段 stroke——三环×96 段 ≈290 段）
    // （开工单的深度映射 s∈[0.86,1.14] 已按复验观察 2 改为「各环本帧实际 s 范围归一化」—— 小半径环动态范围不再缩水）

    // ══════════ intensity 接线 · 二·R 定案（2026-10-19 15:35 用户拍板）══════════
    // 用户实测推翻 ×1.5 二档方案：「速度没有任何变化」（CPU 40~79 全在悬崖下）＋「×1 和 ×3 肉眼难辨」
    // → 连续倍率 ×1→×5 ＋ 固定 30fps（越忙越提帧是在抢机器算力：60fps 单核 16.6% vs 30fps 8.3%）
    private const double GyroSpeedGain = 4.0;             // 倍率上限：gain = 1 + 4·intensity → ×1.00 ~ ×5.00
    private const int FrameFps = 30;                      // 帧率固定（废 15/60 双档 —— 单核占用稳定 ≈8%，不随负载抖）
    private const double IntensityTauRise = 0.6;          // intensity 平滑：上升 τ（快 —— 忙起来立刻有感觉）
    private const double IntensityTauFall = 3.0;          //   下降 τ（慢 —— 「电脑忙完还喘一会儿」的余温感）。⭐ 兼任**抗抖动的唯一防线**：
                                                          //   内核 CPU 采样是 300ms 一采（监工 16:00 重大更正：非 5s 均值），窗口噪声极大
                                                          //   （现场实测相邻采样 83→65→84→32→85 一跳 50pp）—— 全靠 τ 低通吃掉，τ 调小 = 放大抽搐
    private const int GyroPointsPerRing = 96;             // 每环 96 点
    private const double GyroPrecessX = 0.13, GyroPrecessY = 0.17, GyroPrecessZ = 0.10;   // 进动幅度（照抄）
    // ⭐ 三环 pf 互质（0.31/0.24/0.19）→ 三环相对姿态永不重新对齐；同 pf 会同步点头 = 又变回"一个东西"

    private const double HaloWidthFactor = 2.6;            // 光晕宽 = 线宽 × 2.6
    private const double HaloOpacity = 0.22;               // 光晕：同色低透明（"发光"而非"描边"，深浅壁纸都自然）

    private static readonly TimeSpan AlertHoldAfterSaid = TimeSpan.FromSeconds(10);  // 告警级台词后的保持期（保留 —— 内存/磁盘告警时 CPU 可能很低，但「有事发生」球该兴奋）

    // 颜色：线条只有一个主色 ＋ 同色光晕（不再需要渐变/色停）—— HSL 逼近管线沿用，色相 180→16 递减
    private const double ColorApproachPerFrame = 0.05;     // 每帧向目标色逼近 5%（约 0.6s 走完）
    private const double HueCalm = 180, HueAlert = 16;
    private const double SatCalm = 1.00, SatAlert = 0.71;    // #008080 → #E06C4A
    private const double LumCalm = 0.25, LumAlert = 0.58;
    private const double GrayLum = 0.50;                             // 无数据 = 灰（饱和度归零）
    private const double ColorDeadZoneLow = 40;                      // 色相死区（开工单⑥）：t = clamp01((cpu−40)/50)
    private const double ColorDeadZoneSpan = 50;

    private const double FormFadeMs = 300;                 // 交叉淡入时长（开工单⑤：硬切会像"闪屏"）

    // ── 二·Y 气泡呈现层参数（开工单定案，别自己调）──
    private const int BubbleQueueCapacity = 8;             // 队列容量；溢出丢「最旧 info」，没有 info 才丢最旧
    private const double BubbleTtlSeconds = 30;            // TTL（从入队时刻算）：超时丢弃＋记账，不补播
    private const double BubbleTypingMs = 55;              // 打字节奏（用户定 55）；英文/数字整词吐出
    private const double BubbleGapMs = 400;                // 条间留白（淡出 180 ＋ 静止 220）
    private const double BubbleFadeMs = 180;               // 淡入/淡出时长
    private const int BubbleMaxLines = 8;                  // 行数上限；超出 ScrollViewer 自动跟随

    private const double DragThreshold = 4;   // 位移 < 4px 松手 = 戳，≥ 4px = 拖（与系统 MinimumHorizontalDragDistance 同量级）
    // 球在窗口 Canvas 里的边距（单一事实源 —— Canvas 定位与 clamp 都用它们）
    private const double BallRightMargin = 18;    // 球右缘距窗右（X 右锚）
    private const double BallLeftMargin = 18;     // 球左缘距窗左（X 左锚，翻转后）
    private const double BallBottomMargin = 14;   // 球下缘距窗下（Y 底锚）
    private const double BallTopMargin = 14;      // 球上缘距窗顶（Y 顶锚，翻转后）

    private readonly KernelSidecar _kernel;
    private readonly DispatcherTimer _idleTimer;      // 每秒喂 idleMs
    private readonly DispatcherTimer _bubbleTimer;    // 二·Y：气泡状态机唯一时钟（原 4.5s 固定消失定时器已退役）
    private readonly System.Windows.Controls.Canvas _ballHost;  // 球的容器（抖动变换挂它身上；内部=视觉层+命中层）
    private readonly System.Windows.Shapes.Rectangle _hitArea;  // ⭐ 命中层：矩形 84×84（圆的四角天然不命中——监工打点实测）
    private readonly TranslateTransform _ballShake;   // L1 抖动 = 球的视觉反应
    private readonly Border _bubble;
    private readonly TextBlock _bubbleText;
    private ScrollViewer _bubbleScroll = null!;       // 二·Y ⑤：气泡内套滚动（8 行上限 + 自动跟随）
    private readonly Border _panel;

    // ── 二·Y 气泡队列状态（单一定时器状态机：Idle → Typing → Holding → Gap → Idle）──
    // Deadline 语义（二·Y 复验 P1，方案 A）：TTL 是「宽度」不是绝对时长 ——
    // 入队时 Deadline = now + 30s + 前方所有条目的预估播放时长，出队时比它。
    // 「你前面还有 N 条要播，播完再给你 30 秒宽限」—— 容量 8 才真正成立（绝对 30s 下
    // 40 字的消息实际只能播 4 条，60 字 3 条，「容量 8」是假的）。
    private sealed record BubbleItem(string Text, string Severity, string EventId, DateTime EnqueuedAt, DateTime Deadline);
    private enum BubblePhase { Idle, Typing, Holding, Gap }
    private readonly List<BubbleItem> _bubbleQueue = new();   // 待播队列（容量 BubbleQueueCapacity）
    private BubbleItem? _bubbleCurrent;                        // 正在播的（critical 打断时按规则回队/丢弃）
    private string _bubbleFullText = "";                       // 当前条的完整文本
    private int _bubbleCharIndex;                              // 已打出的字符数
    private BubblePhase _bubblePhase = BubblePhase.Idle;
    private DateTime _bubblePhaseUntil;                        // Holding/Gap 的截止时刻
    private double _bubbleLastTextHeight = -1;                 // 自动跟随：ActualHeight 变了才 ScrollToEnd
    private TextBlock _statusText = null!;   // 在 MakePanel()（构造函数内）里创建 —— 非只读
    private TextBlock _cpuText = null!;
    private TextBlock _memText = null!;
    private readonly Random _rng = new();

    // ── b2-b2 形态库运行时状态 ──
    private readonly System.Diagnostics.Stopwatch _fluidClock = System.Diagnostics.Stopwatch.StartNew();
    private DispatcherTimer _fluidTimer = null!;      // 形态驱动（Interval 恒 30fps —— 二·R ③：帧率不随负载变，情绪只剩速度与颜色）
    private System.Windows.Media.SolidColorBrush _mainBrush = null!;  // 主色（持有**未 Freeze** 实例，每帧只改 Color）
    private double _curIntensity, _targetIntensity;               // 情绪强度 0~1（连续跟随 CPU ＋ 告警保持，二·R ①）
    private double _lastFluidT;                       // 上一帧 FluidTick 时刻（时间基平滑的 dt 基准）
    private int _lastIntensityLevel = -1;             // 已记日志的档位序号（跨档才记，不刷屏）
    private DateTime _lastTargetLog = DateTime.MinValue;  // target 轨迹日志的节流（5 秒一条）
    private bool _lastAlertState;                     // 告警保持期上次状态（翻转才记日志）
    private double _curHue = HueCalm, _curSat = SatCalm, _curLum = LumCalm;   // 当前色（HSL，向目标逼近 5%/帧）
    private double? _lastCpu;                          // 最近采样 CPU —— 驱动颜色连续插值 + 档位
    private DateTime _alertHoldUntil = DateTime.MinValue;              // 告警级台词后的保持期

    // ── 形态注册表 ＋ 双槽交叉淡入（开工单④⑤）──
    private readonly IBallForm[] _forms = { new GyroForm(), new DebugRingForm() };
    private readonly System.Windows.Controls.Canvas?[] _slotHosts = new System.Windows.Controls.Canvas?[2];  // 每槽一个容器 —— 交叉淡入淡容器，槽内线的粗细浓淡是各 Path 自己的基值
    private readonly System.Windows.Shapes.Path[]?[] _slotStrokes = new System.Windows.Shapes.Path[2][];  // 外层槽可整体置 null（停更）；内层元素建槽后全非 null
    private readonly System.Windows.Shapes.Path[]?[] _slotHalos = new System.Windows.Shapes.Path[2][];
    private readonly IBallForm?[] _slotForm = new IBallForm?[2];   // 各槽当前挂的形态（null = 空槽不更新）
    private int _frontSlot;        // 正在展示的槽位
    private bool _fading;          // 交叉淡入进行中（切换防重入）

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
        Width = 330;   // b2-b2：320→330 —— BallSize 76 后 X 左锚分支的面板挂球右 [124,330] 才放得下（206 DIP）
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
        _mainBrush = new System.Windows.Media.SolidColorBrush(HslToColor(HueCalm, SatCalm, LumCalm));
        _ballHost = new System.Windows.Controls.Canvas
        {
            Width = BallSize,
            Height = BallSize,
            RenderTransform = _ballShake,   // 戳的抖动 = 整个球容器一起抖
        };
        // 双槽（开工单⑤）：每槽一个容器（交叉淡入淡容器 Opacity），槽内 = 每根线一层（光晕+描边）。
        // 槽 0 = 前台（常态线团），槽 1 = 备用（交叉淡入时接新形态）。
        for (var slot = 0; slot < 2; slot++)
        {
            _slotHosts[slot] = new System.Windows.Controls.Canvas
            {
                IsHitTestVisible = false,     // ⭐ 开工单③：视觉层只负责画，不接收鼠标
                Opacity = slot == 0 ? 1 : 0,
            };
            _ballHost.Children.Add(_slotHosts[slot]!);
        }
        _slotForm[0] = ResolveForm(FormIdForState());
        PopulateSlot(0, _slotForm[0]!.Build(0, 0));
        // ⭐ 命中区独立（开工单③）：改成只有描边之后命中只剩 2.2px 线本身 → 点不到。
        //   命中层不可见但可命中 —— ⚠️ Fill 必须给 Brushes.Transparent，给 null 不参与命中。
        //   b2-b2 复验（监工 2026-10-19）：Ellipse 的**四角天然不命中**（打点实测 (10,10)/(70,70) 都在圆外）
        //   → 线团视觉只占中间 79%，用户移到"看着像球、实际在圆外"就感觉空白无效。
        //   改**矩形**且比视觉大一圈（76→84，各边多 4）—— 细线的点击目标该比视觉宽容。
        _hitArea = new System.Windows.Shapes.Rectangle
        {
            Width = BallSize + 8,
            Height = BallSize + 8,
            Fill = Brushes.Transparent,
            Cursor = Cursors.Hand,
            ToolTip = "戳一下",
        };
        Canvas.SetLeft(_hitArea, -4);       // 84 在 76 容器里居中：各边出 4
        Canvas.SetTop(_hitArea, -4);
        _ballHost.Children.Add(_hitArea);   // 命中层最后加 = 顶层（在两个槽容器之上）
        Canvas.SetRight(_ballHost, BallRightMargin);
        Canvas.SetBottom(_ballHost, BallBottomMargin);
        // ⭐ 6 个鼠标事件 + CaptureMouse/ReleaseMouseCapture 全部从 _ball 平移到 _hitArea（开工单③）。
        //   悬停 + 拖动 + 戳三合一：按下捕获鼠标 → 位移 ≥4px = 拖（拖起来顺带收面板）；位移 <4px 松手 = 戳。
        //   MouseLeave 走 300ms 宽限收起 —— 球↔面板往返不闪断，往别处移走就收。
        _hitArea.MouseEnter += (_, _) => { _panelCloseTimer.Stop(); ExpandPanel(); };
        _hitArea.MouseLeave += (_, _) => StartPanelCloseGrace();
        _hitArea.MouseLeftButtonDown += OnBallDragStart;
        _hitArea.MouseMove += OnBallDragMove;
        _hitArea.MouseLeftButtonUp += OnBallDragEnd;
        _hitArea.LostMouseCapture += (_, _) => EndDrag();        // 捕获被系统抢走也走同一收尾（观察③）

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
        _bubble.Child = _bubbleScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = _bubbleText,
        };
        // 二·Y ④：8 行上限按公式换算（行高 = FontSize×1.36），不写死像素 —— 以后改字号不错位
        _bubble.MaxHeight = _bubbleText.FontSize * 1.36 * BubbleMaxLines + _bubble.Padding.Top + _bubble.Padding.Bottom;
        // ⭐ P0-3（监工 2026-10-17）：气泡贴球**正上方**（不与面板同位），且 Z 序压在面板之上 ——
        //   「它刚说了句话」本就该盖过面板；此前气泡与面板几乎同位（Bottom 92 vs 90）且
        //   面板后加入在上层 → 鼠标在球上（点球前提）必然开着面板 → 气泡被完整盖住，一次都看不见。
        Canvas.SetRight(_bubble, 14);
        Canvas.SetBottom(_bubble, BallSize + 20);   // 球(bottom 14 + 64)顶在 78 → 气泡底 84，留 6px 间隙
        Panel.SetZIndex(_bubble, 10);               // 面板 Z 序默认 0 —— 气泡恒在其上
        _bubble.MouseEnter += (_, _) =>
        {
            _panelCloseTimer.Stop();
            FlushTyping();                          // 二·Y「不拦路」：悬停立即吐完全文
            ExpandPanel();
        };   // 气泡上也算悬停（话没读完不收）
        _bubble.MouseLeave += (_, _) => StartPanelCloseGrace();

        _panel = MakePanel();
        Canvas.SetRight(_panel, BallSize + 30);     // 面板移到球**左侧**（与气泡位置错开）
        Canvas.SetBottom(_panel, 14);
        _panel.Visibility = Visibility.Collapsed;
        _panel.MouseEnter += (_, _) => _panelCloseTimer.Stop();
        _panel.MouseLeave += (_, _) => StartPanelCloseGrace();

        canvas.Children.Add(_bubble);
        canvas.Children.Add(_panel);
        canvas.Children.Add(_ballHost);
        Content = canvas;

        // 窗口本身也要悬停展开（球之外还有气泡/面板 —— 移动到它们上面不能收）
        MouseEnter += (_, _) => ExpandPanel();

        // ── 状态 ──
        _idleTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _idleTimer.Tick += (_, _) => FeedIdle();
        _bubbleTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(BubbleTypingMs) };
        _bubbleTimer.Tick += (_, _) => BubbleTick();   // 二·Y：状态机唯一时钟（55ms 一拍，Holding/Gap 查截止时刻）
        _fluidTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1000.0 / FrameFps) };   // 二·R ③：帧率恒 30 —— 不再随负载调
        _fluidTimer.Tick += (_, _) => FluidTick();

        // 面板宽限收起（2026-10-17 修复）：球/面板/气泡任一 MouseLeave → 300ms 后收；
        // 宽限期内摸回来（球↔面板之间的 30px 空隙、面板→球等路径）→ Tick 一查还悬停着 → 取消。
        // 旧逻辑只挂「面板离开才收」+「失焦收」，而 NOACTIVATE 窗口永不激活 → 失焦是死路 →
        // 从球上直接移走面板永远不收（用户实测确认）。
        _panelCloseTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(300) };
        _panelCloseTimer.Tick += (_, _) =>
        {
            _panelCloseTimer.Stop();
            if (!_hitArea.IsMouseOver && !_panel.IsMouseOver && !_bubble.IsMouseOver) CollapsePanel();
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
            _fluidTimer.Start();     // b2-b2：流体形变开跑（隐藏时停 = 帧率 0，省电）
            FeedIdle();              // greeting 插队：立即喂第一帧 context —— 打招呼零延迟（否则要等 1s）
        };
        Closing += (_, _) =>
        {
            _idleTimer.Stop();
            _bubbleTimer.Stop();
            _fluidTimer.Stop();      // b2-b2：流体停
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
        // b2-b2：颜色不再换画刷 —— CPU 存起来，由 FluidTick 每帧 HSL 连续插值（形状档位也由它驱动）
        _lastCpu = s.Cpu;
        UpdateFluidTarget();
    }

    private void OnSaid(SaidLine said)
    {
        EnqueueBubble(said);        // 二·Y：排队 → 逐字打出 → 按字数停留 → 淡出（不再来一条覆盖一条）
        if (_panelOpen) UpdateStatusLine();
        // L4（决策 #34）：poked@ 前缀 = 它决定「躲开」—— 外壳只做动作，说话归内核
        if (said.EventId.StartsWith("poked@", StringComparison.Ordinal)) MoveAside();
        // b2-b2：告警级台词 → 告警档保持一段时间（活跃期结束后平滑回落，FluidTick 逼近）
        if (said.Level is "warn" or "critical")
        {
            _alertHoldUntil = DateTime.Now + AlertHoldAfterSaid;
            UpdateFluidTarget();
        }
    }

    // ───────────────────────── b2-b2 形态库驱动 + 颜色连续插值 ─────────────────────────

    private static double Clamp01(double v) => Math.Min(1, Math.Max(0, v));

    /// <summary>情绪目标（二·R ①）：**连续跟随 CPU** —— ≤50 → 0（日常不打扰），50→95 线性爬到 1，95+ 封顶；
    /// 告警台词保持期内**强制 1**（取 max —— 内存/磁盘告警时 CPU 可能很低，但「有事发生」球该兴奋，坑 3）。
    /// 帧率已恒 30fps（二·R ③），不再动态调 Interval —— 越忙越提帧是在抢机器的算力。</summary>
    private void UpdateFluidTarget()
    {
        _targetIntensity = Math.Max(CpuT(_lastCpu ?? 0), _alertHoldUntil > DateTime.Now ? 1 : 0);
        var alert = _alertHoldUntil > DateTime.Now;
        if (alert != _lastAlertState)   // 二·R ⑤：档位此前完全不可观测 —— alert 翻转记一条
        {
            _lastAlertState = alert;
            AppendLog($"[形态] 告警保持期{(alert ? "开始" : "结束")}（cpu={(_lastCpu is { } c ? $"{c:F0}%" : "--")}）");
        }

        // 监工复验观察 A（彻底做法）：跨档日志只记"当前值"的瞬间穿越，真实轨迹（0↔0.78 摆动）看不到 ——
        //   再记一条"目标值"（本方法每次 CPU 采样都调 —— 内核 **300ms 一采**（监工 16:00 重大更正：非 5s/1s）；
        //   节流 5 秒一条防刷屏），轨迹就完整了。
        if ((DateTime.Now - _lastTargetLog).TotalSeconds >= 5)
        {
            _lastTargetLog = DateTime.Now;
            AppendLog($"[形态] cpu={(_lastCpu is { } c ? $"{c:F0}%" : "--")} target={_targetIntensity:F2}（当前 {_curIntensity:F2}）");
        }
    }

    /// <summary>CPU → 强度曲线（二·R ①，照抄开工单）：≤50 → 0；50→95 线性爬到 1；95+ 封顶。</summary>
    private static double CpuT(double cpu) => Math.Clamp((cpu - 50.0) / 45.0, 0, 1);

    /// <summary>形态驱动（每帧）：intensity 按**时间基**平滑逼近（二·R ②）→ 各「还看得见」的槽重建 geometry → 主色 HSL 逼近 5%（带死区）。</summary>
    private void FluidTick()
    {
        var t = _fluidClock.Elapsed.TotalSeconds;
        // ⭐ 平滑改时间基（二·R ②）：「每帧 10%」与 dt 脱钩，帧率一变行为就变 —— 用 1−exp(−dt/τ)。
        //   上升 τ=0.6s（忙起来立刻有感觉）、下降 τ=3s（「电脑忙完还喘一会儿」的余温，不许"啪"一下停）。
        var dt = Math.Clamp(t - _lastFluidT, 0, 0.1);
        _lastFluidT = t;
        var tau = _targetIntensity > _curIntensity ? IntensityTauRise : IntensityTauFall;
        _curIntensity += (_targetIntensity - _curIntensity) * (1 - Math.Exp(-dt / tau));

        // 二·R ⑤：intensity 跨档记一条（可观测 —— 这次"速度没变"就是靠读源码才推断出来的）。
        //   ⭐ 监工复验观察 A 修正：原先 Math.Floor(i×2) 两档 —— intensity 指数渐近**永远 < 1.0**，
        //   Floor(1.0×2)=2 那档永远到不了 → 满档（×5）永远记不到，日志看起来"卡在 0.50"。
        //   改 Round(i×4) 五档（0/1/2/3/4），≥0.875 即可记到满档。
        var level = (int)Math.Round(_curIntensity * 4);
        if (level != _lastIntensityLevel)
        {
            _lastIntensityLevel = level;
            AppendLog($"[形态] cpu={(_lastCpu is { } c ? $"{c:F0}%" : "--")} intensity={_curIntensity:F2} gain=×{1 + GyroSpeedGain * _curIntensity:F2}");
        }

        // 颜色：连续跟随 CPU（HSL 空间插值，色相 180→16 递减），带死区 t = clamp01((cpu−40)/50)；无数据 = 灰
        var ct = _lastCpu is { } cv ? Clamp01((cv - ColorDeadZoneLow) / ColorDeadZoneSpan) : double.NaN;
        var tgtH = double.IsNaN(ct) ? _curHue : HueCalm + (HueAlert - HueCalm) * ct;
        var tgtS = double.IsNaN(ct) ? 0 : SatCalm + (SatAlert - SatCalm) * ct;
        var tgtL = double.IsNaN(ct) ? GrayLum : LumCalm + (LumAlert - LumCalm) * ct;
        _curHue += (tgtH - _curHue) * ColorApproachPerFrame;
        _curSat += (tgtS - _curSat) * ColorApproachPerFrame;
        _curLum += (tgtL - _curLum) * ColorApproachPerFrame;
        _mainBrush.Color = HslToColor(_curHue, _curSat, Clamp01(_curLum));   // 光晕同色 —— 发光感来自低透明光晕层

        // 形状：交叉淡入期间两槽都在动，各槽跟着自己的形态逐层重建（Freeze 后提交渲染）
        for (var slot = 0; slot < 2; slot++)
        {
            var form = _slotForm[slot];
            if (form is null || _slotHosts[slot]!.Opacity <= 0.01) continue;   // 空槽/已淡出 = 停更（省帧）
            var layers = form.Build(t, _curIntensity);
            // 防御：层数对不上（形态切换/未来形态层不固定）→ 重建槽，绝不越界
            if (_slotStrokes[slot] is null || _slotStrokes[slot]!.Length != layers.Length)
            {
                PopulateSlot(slot, layers);
                continue;
            }
            var strokes = _slotStrokes[slot]!;   // 守卫后非 null —— 局部变量消 CS8602
            var halos = _slotHalos[slot]!;
            for (var i = 0; i < layers.Length; i++)
            {
                strokes[i].Data = layers[i].Geo;
                halos[i].Data = layers[i].Geo;
            }
        }
    }

    // ───────────────────────── 形态注册表（开工单④：形态只产 geometry，不碰颜色/命中/交互）─────────

    /// <summary>状态 → 形态映射（本版写死常态陀螺仪；波动环与按状态查表归第二版）。</summary>
    private string FormIdForState() => "gyro";

    private IBallForm ResolveForm(string id) => _forms.First(f => f.Id == id);

    /// <summary>一层线：几何＋线宽＋浓度（0~1）。一个形态可返回多层（线团 3 层／调试环 1 层）——
    /// ⭐ 分层是监工 2026-10-19 的要求：同色不同粗细浓淡，76px 下才读得出"丝线缠绕"而不是"一团"。</summary>
    private sealed record BallLayer(Geometry Geo, double Width, double Alpha);

    /// <summary>一个球形态：只负责「给时间 t 和情绪强度，产出若干层线」。不碰颜色、命中、交互。</summary>
    private interface IBallForm
    {
        string Id { get; }

        /// <param name="intensity">0~1 情绪强度（平静→0，告警→1）</param>
        BallLayer[] Build(double t, double intensity);
    }

    /// <summary>陀螺仪（常态形态，B 版定案）：三个异倾角的环共用一个全局旋转，各环独立进动。
    /// ⛔ 环不自转（绕自己法线转看不见——坑 1）；三环倾角两两不同 = "各转各的"的全部来源。
    /// 性能：每环 96 点按深度分 6 档合并成一条 StreamGeometry（坑 3：290 段逐段 stroke 会掉帧）。
    ///   ⚠️ 合并按「环 × 档」分组（3×6=18 条）而非跨环 6 条 —— 三环 base 线宽/亮度各不相同，跨环合并会失真。</summary>
    private sealed class GyroForm : IBallForm
    {
        public string Id => "gyro";

        // ── intensity 接线（二·R 定案 ×1→×5 连续倍率）—— 累积相位，绝不用 t·f(intensity) ──
        //   t·f(intensity) 在 intensity 变化时会重参数化整个时间轴（sin 的参数瞬间跳）；
        //   累积相位 φ += ω·gain·dt 随 intensity 平滑变化连续推进，无跳变。
        //   ⚠️ dt 必须夹紧上限（二·R ④）：隐藏球时 _fluidTimer 停但 _fluidClock 继续走 ——
        //   不夹紧则显示回来时一次性补上全部空档（隐藏 30s → 相位跳 292°；10min → 跳 16 圈）；
        //   夹紧 0.1s → 相位最多前进 0.1s 的量 = 无瞬移（验收⑥）。
        private double _lastT;
        private double _vyPhase;                                // 全局 rotY 累积相位
        private readonly double[] _procPhase = new double[3];   // 每环进动累积相位（sin(ph·c + pp) 的 c 是开工单的 1/0.80/1.30）
        private readonly double[] _dotPhase = new double[3];    // 每环亮点累积相位
        private readonly double[] _sBuf = new double[GyroPointsPerRing + 1];   // 深度归一化缓冲（字段复用——监工 14:50 观察：每帧 new ≈140KB/s GC 压力）

        public BallLayer[] Build(double t, double intensity)
        {
            var dt = Math.Clamp(t - _lastT, 0, 0.1);   // ⭐ 夹紧上限（二·R ④）—— 首帧/同帧二调/长期暂停都最多补 0.1s
            _lastT = t;
            var gain = 1 + GyroSpeedGain * intensity;   // 情绪增益（二·R）：×1.00 ~ ×5.00 连续
            _vyPhase += GyroVySpeed * gain * dt;
            var vy = _vyPhase;
            var layers = new List<BallLayer>();
            for (var k = 0; k < GyroRings.Length; k++)
            {
                var ring = GyroRings[k];
                // 进动：三个独立的慢漂移（顺序固定 X → Y → Z，不能换）；相位累积 → intensity 平滑加速
                _procPhase[k] += ring.Pf * gain * dt;
                var ph = _procPhase[k];
                var tx = ring.Tx0 + GyroPrecessX * Math.Sin(ph + ring.Pp);
                var ty = ring.Ty0 + GyroPrecessY * Math.Sin(ph * 0.80 + ring.Pp * 1.7);
                var tz = ring.Tz0 + GyroPrecessZ * Math.Sin(ph * 1.30 + ring.Pp * 0.6);

                // 环上取点（⛔ a 不加时间）→ 投影 → 按深度分档
                var pts = new Point[GyroPointsPerRing + 1];   // +1 = 回到起点（闭合段也参与分档连线）
                var ss = _sBuf;                               // 复用缓冲（零分配）
                for (var i = 0; i <= GyroPointsPerRing; i++)
                {
                    var a = 2 * Math.PI * i / GyroPointsPerRing;
                    pts[i] = Project(ring.Radius * Math.Cos(a), ring.Radius * Math.Sin(a), 0, tx, ty, tz, vy, out var s);
                    ss[i] = s;
                }

                // ⭐ 复验观察 2 修复（监工 2026-10-19 14:30）：深度改按**各环本帧实际 s 范围**归一化 ——
                //   原全局固定 s∈[0.86,1.14] 下，小半径环的 s 范围天然窄（环③ dz 只有 [0.17,0.70]），
                //   alpha 动态范围掉到 2.5 倍（环① 是 6.3 倍）→ 最里面的环看着偏虚。
                //   归一化后三环都吃满 [0,1]：姿态连续变化 → s 范围连续变化 → 深度映射连续，无跳变。
                var sMin = ss.Min();
                var sSpan = Math.Max(1e-6, ss.Max() - sMin);
                var bands = new List<int>[GyroDepthBands];
                for (var i = 0; i <= GyroPointsPerRing; i++)
                {
                    var dz = Clamp01((ss[i] - sMin) / sSpan);
                    var band = Math.Min(GyroDepthBands - 1, (int)(dz * GyroDepthBands));
                    (bands[band] ??= new List<int>()).Add(i);
                }
                for (var b = 0; b < GyroDepthBands; b++)
                {
                    // ⭐ 空档也要占位（补空 geometry）—— 层数恒 3×6+3=21：深度档占用随姿态变化，
                    //   若按「有货才出层」，FluidTick 里 Path 数组会越界（首帧建槽数 ≠ 后续帧层数）
                    var idxs = bands[b];
                    var dzMid = (b + 0.5) / GyroDepthBands;   // 档中值（6 档在 2px 下看不出跳变；3 档才会"带状"）
                    layers.Add(new BallLayer(
                        idxs is { Count: > 0 } ? BuildPolylineGeometry(idxs, pts) : EmptyGeometry(),
                        ring.Width * (0.45 + 0.65 * dzMid),           // 线宽 = base·(0.45 + 0.65·dz) —— 背面细
                        Clamp01(ring.Lum * (0.16 + 0.84 * dzMid))));  // 浓度 = base·(0.16 + 0.84·dz) —— 背面暗
                }

                // 环上亮点（每环 1 个；②③ spin 反向 —— 点在环上转是看得见的，与"环自转"两码事）
                _dotPhase[k] += ring.DotSpin * gain * dt;   // 亮点速度同样吃情绪增益（②③反向不变）
                var ha = ring.DotHead + _dotPhase[k];
                var dp = Project(ring.Radius * Math.Cos(ha), ring.Radius * Math.Sin(ha), 0, tx, ty, tz, vy, out var dotS);
                var dotDz = Clamp01((dotS - sMin) / sSpan);   // 亮点深度跟本环归一化口径
                layers.Add(new BallLayer(
                    BuildDotGeometry(dp),                             // 零长度线段＋圆头笔帽 = 点（坑 2，不用改类型）
                    ring.Width * (0.45 + 0.65 * dotDz),
                    1.0));                                            // "亮点"字面义 = 全亮（参数表没给点样式；复验观察 3 维持不分深度）
            }
            return layers.ToArray();
        }

        /// <summary>环上一点 → 屏幕坐标：环倾角（X→Y→Z）→ 全局视角（rotX 固定 ＋ rotY(t)）→ 透视。
        /// 输出透视系数 s（深度归一化由调用方按各环本帧实际范围做 —— 复验观察 2）。</summary>
        private static Point Project(double x, double y, double z, double tx, double ty, double tz, double vy, out double s)
        {
            RotX(ref x, ref y, ref z, tx);
            RotY(ref x, ref y, ref z, ty);
            RotZ(ref x, ref y, ref z, tz);
            RotX(ref x, ref y, ref z, GyroRotX);
            RotY(ref x, ref y, ref z, vy);
            s = GyroFc / (GyroFc + z);
            return new Point(BallSize / 2.0 + x * GyroRadius * s, BallSize / 2.0 + y * GyroRadius * s);
        }

        private static void RotX(ref double x, ref double y, ref double z, double a)
        {
            var c = Math.Cos(a); var s = Math.Sin(a);
            (y, z) = (y * c - z * s, y * s + z * c);
        }
        private static void RotY(ref double x, ref double y, ref double z, double a)
        {
            var c = Math.Cos(a); var s = Math.Sin(a);
            (x, z) = (x * c + z * s, -x * s + z * c);
        }
        private static void RotZ(ref double x, ref double y, ref double z, double a)
        {
            var c = Math.Cos(a); var s = Math.Sin(a);
            (x, y) = (x * c - y * s, x * s + y * c);
        }

        /// <summary>同档点集 → 一条 geometry：**连续**的点连成 figure（跨档断开处另起 figure，绝不跨档连线）；
        /// 孤立点补 0.01 线段（圆头笔帽画点的前提）。</summary>
        private static StreamGeometry BuildPolylineGeometry(List<int> idxs, Point[] pts)
        {
            var geo = new StreamGeometry();
            using (var ctx = geo.Open())
            {
                var prev = -2;
                foreach (var i in idxs)
                {
                    if (i != prev + 1) ctx.BeginFigure(pts[i], false, false);   // ⚠️ 描边：不填充、不闭合
                    else ctx.LineTo(pts[i], true, false);
                    if (prev == -2 || i != prev + 1)
                    {
                        // 新 figure 的第一个点：若是孤立点（下一点不同档），补 0.01 线段让它可见
                        var nextSameBand = idxs.Contains(i + 1);
                        if (!nextSameBand) ctx.LineTo(new Point(pts[i].X + 0.01, pts[i].Y), true, false);
                    }
                    prev = i;
                }
            }
            geo.Freeze();
            return geo;
        }

        private static StreamGeometry BuildDotGeometry(Point p)
        {
            var geo = new StreamGeometry();
            using (var ctx = geo.Open())
            {
                ctx.BeginFigure(p, false, false);
                ctx.LineTo(new Point(p.X + 0.01, p.Y), true, false);   // 零长度线段＋圆头 = 点
            }
            geo.Freeze();
            return geo;
        }

        /// <summary>空 geometry（无 figure）—— 深度空档占位用：层总数恒定，FluidTick 的 Path 数组才不会越界。</summary>
        private static StreamGeometry EmptyGeometry()
        {
            var geo = new StreamGeometry();
            using (geo.Open()) { }   // 开了不画 = 空
            geo.Freeze();
            return geo;
        }
    }

    /// <summary>调试形态：正圆环 —— 唯一用途是让交叉淡入框架被真实验证
    /// （开工单⑤：只有线团一个形态时，切换逻辑永远跑不到，等于没验证）。</summary>
    private sealed class DebugRingForm : IBallForm
    {
        public string Id => "debug-ring";
        private Geometry? _cached;   // 静态圆，算一次就够

        public BallLayer[] Build(double t, double intensity)
        {
            if (_cached is null)
            {
                var c = BallSize / 2.0;
                var r = BallSize * 0.35;
                var geo = new System.Windows.Media.StreamGeometry();
                using (var ctx = geo.Open())
                {
                    var p0 = new Point(c + r, c);
                    ctx.BeginFigure(p0, false, false);
                    for (var i = 1; i <= GyroPointsPerRing; i++)
                    {
                        var a = 2 * Math.PI * i / GyroPointsPerRing;
                        ctx.LineTo(new Point(c + r * Math.Cos(a), c + r * Math.Sin(a)), true, false);
                    }
                }
                geo.Freeze();
                _cached = geo;
            }
            return new[] { new BallLayer(_cached, 2.2, 1.0) };
        }
    }

    /// <summary>把形态的各层落到槽容器里（层结构随形态不同：线团 3 层／调试环 1 层）。
    /// 槽内逐层：光晕垫底、描边在上；线宽/浓度是各 Path 自己的基值（同色分层），容器 Opacity 只管淡入淡出。</summary>
    private void PopulateSlot(int slot, BallLayer[] layers)
    {
        var host = _slotHosts[slot]!;
        host.Children.Clear();
        var strokes = new System.Windows.Shapes.Path[layers.Length];   // 局部建满再挂 —— 消 CS8602
        var halos = new System.Windows.Shapes.Path[layers.Length];
        for (var i = 0; i < layers.Length; i++)
        {
            var layer = layers[i];
            var halo = new System.Windows.Shapes.Path
            {
                Data = layer.Geo,
                Stroke = _mainBrush,
                StrokeThickness = layer.Width * HaloWidthFactor,
                StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round,
                Opacity = HaloOpacity * layer.Alpha,   // 光晕浓度跟线走（分层后逐层不同）
            };
            var stroke = new System.Windows.Shapes.Path
            {
                Data = layer.Geo,
                Stroke = _mainBrush,
                StrokeThickness = layer.Width,
                StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round,
                Opacity = layer.Alpha,
            };
            halos[i] = halo;
            strokes[i] = stroke;
            host.Children.Add(halo);
            host.Children.Add(stroke);
        }
        _slotStrokes[slot] = strokes;
        _slotHalos[slot] = halos;
    }

    /// <summary>切形态（交叉淡入，开工单⑤）：新形态载入背槽 → 300ms 淡入淡出 → 交换槽位、旧槽停更。
    /// ⭐ 淡的是**槽容器** —— 槽内每根线的粗细/浓度是各 Path 自己的基值，动画不碰它们。
    /// ⚠️ 动画 FillBehavior.Stop + Completed 显式落定（抖动/挪一挪同款双保险 —— 默认 HoldEnd 会锁住 Opacity）。</summary>
    private void SwitchForm(string id)
    {
        if (_fading) return;
        var next = ResolveForm(id);
        if (next.Id == _slotForm[_frontSlot]?.Id) return;   // 就是它，不切
        var back = 1 - _frontSlot;
        _slotForm[back] = next;
        PopulateSlot(back, next.Build(_fluidClock.Elapsed.TotalSeconds, _curIntensity));
        _fading = true;
        AppendLog($"形态切换：{_slotForm[_frontSlot]?.Id} → {next.Id}（{FormFadeMs:F0}ms 交叉淡入）");

        var dur = TimeSpan.FromMilliseconds(FormFadeMs);
        var fadeIn = new DoubleAnimation(0, 1, dur) { FillBehavior = FillBehavior.Stop };
        var fadeOut = new DoubleAnimation(1, 0, dur) { FillBehavior = FillBehavior.Stop };
        var done = 0;
        void Finish()
        {
            if (++done < 2) return;   // 两条动画全走完才收尾
            _slotHosts[_frontSlot]!.Opacity = 0;
            _slotForm[_frontSlot] = null;    // 旧槽停更（FluidTick 跳过 null/透明槽）
            _slotStrokes[_frontSlot] = null;
            _slotHalos[_frontSlot] = null;
            _frontSlot = back;
            _slotHosts[_frontSlot]!.Opacity = 1;
            _fading = false;
            AppendLog($"形态切换完成：当前 {_slotForm[_frontSlot]!.Id}");
        }
        fadeIn.Completed += (_, _) => Finish();
        fadeOut.Completed += (_, _) => Finish();
        _slotHosts[back]!.BeginAnimation(OpacityProperty, fadeIn);
        _slotHosts[_frontSlot]!.BeginAnimation(OpacityProperty, fadeOut);
    }

    /// <summary>渲染冒烟专用：切到调试形态 —— 交叉淡入框架的机器侧验证入口（开工单⑤）。</summary>
    public void SwitchFormForTest()
    {
        BeforeSwitchFormId = ActiveFormId;   // 冒烟日志用（切之前的形态 id，别再硬编码形态名）
        SwitchForm("debug-ring");
    }

    /// <summary>渲染冒烟专用：切之前的形态 Id。</summary>
    public string BeforeSwitchFormId { get; private set; } = "?";

    /// <summary>当前展示的形态 Id（冒烟自查用）。</summary>
    public string ActiveFormId => _slotForm[_frontSlot]?.Id ?? "?";

    /// <summary>HSL → RGB（色相 0~360，S/L 0~1）—— 颜色插值只走 HSL，别碰 RGB Lerp。</summary>
    private static Color HslToColor(double h, double s, double l)
    {
        h = ((h % 360) + 360) % 360;
        var c = (1 - Math.Abs(2 * Clamp01(l) - 1)) * Clamp01(s);
        var x = c * (1 - Math.Abs(h / 60 % 2 - 1));
        var m = Clamp01(l) - c / 2;
        double r, g, b;
        switch ((int)(h / 60))
        {
            case 1: r = x; g = c; b = 0; break;
            case 2: r = 0; g = c; b = x; break;
            case 3: r = 0; g = x; b = c; break;
            case 4: r = x; g = 0; b = c; break;
            case 5: r = c; g = 0; b = x; break;
            default: r = c; g = x; b = 0; break;   // 0~60°
        }
        return Color.FromRgb((byte)Math.Round((r + m) * 255), (byte)Math.Round((g + m) * 255), (byte)Math.Round((b + m) * 255));
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

    // ───────────────────────── 气泡（L2）· 二·Y：队列 ＋ 打字机 ＋ 8 行上限 ─────────────────────────

    /// <summary>入队：warn/critical 插队首（在全部 info 之前，同级保持 FIFO）；info 排队尾。
    /// 容量满丢「最旧 info」（没有 info 才丢最旧）；critical 打断正在播的（被打断者回队首完整重播）。</summary>
    private void EnqueueBubble(SaidLine said)
    {
        var severity = string.IsNullOrEmpty(said.Level) ? "info" : said.Level;
        // 静音中：info 直接丢（解除后不补播 —— 与沉默机制同源）；warn/critical 照常（告警不受静音压制）
        if (IsMuted && severity == "info")
        {
            AppendLog($"[气泡] 静音中丢弃 info：{said.Text}");
            return;
        }
        var item = new BubbleItem(said.Text, severity, said.EventId, DateTime.Now, DateTime.Now);

        if (_bubbleQueue.Count >= BubbleQueueCapacity)
        {
            var idxInfo = _bubbleQueue.FindIndex(m => m.Severity == "info");
            var dropIdx = idxInfo >= 0 ? idxInfo : 0;
            var dropped = _bubbleQueue[dropIdx];
            _bubbleQueue.RemoveAt(dropIdx);
            AppendLog($"[气泡] 丢弃（溢出）{dropped.Severity}：{dropped.Text}");
        }

        InsertBySeverity(item);
        AppendLog($"[气泡] 入队（{severity}）队={_bubbleQueue.Count} 宽限 {(item.Deadline - DateTime.Now).TotalSeconds:F0}s：{item.Text}");

        // critical 打断正在播的（Typing/Holding）—— 安全告警晚 10 秒就没意义。
        // 被打断者：info/warn 回队（排在这条 critical 之后完整重播）；critical 不回队 ——
        // 二·Y 复验 P3：两条告警撞车，残句＋重播 = 同一句说两遍开头，且旧告警重播时可能已过时
        if (severity == "critical" && _bubbleCurrent is { } cur && _bubblePhase is BubblePhase.Typing or BubblePhase.Holding)
        {
            _bubbleCurrent = null;
            _bubblePhase = BubblePhase.Idle;
            if (cur.Severity == "critical")
            {
                AppendLog($"[气泡] critical 打断 critical：丢弃残句（避免同一句说两遍开头）：{cur.Text}");
            }
            else
            {
                InsertBySeverity(cur);
                AppendLog($"[气泡] 被打断回队（critical 之后完整重播）：{cur.Text}");
            }
        }

        if (_bubblePhase == BubblePhase.Idle) TryPlayNext();
    }

    /// <summary>单条预估播放时长（二·Y 复验 P1）：打字（55ms/字上界）＋ 停留 ＋ 条间留白 —— 与监工核算表同口径。</summary>
    private static double EstimatePlayMs(BubbleItem m)
    {
        var len = Math.Max(1, m.Text.Length);
        return BubbleTypingMs * len + Math.Max(2500, 2000 + 90.0 * len) + BubbleGapMs;
    }

    /// <summary>按分级规则插入队列（warn/critical 排全部 info 之前、同级 FIFO；info 队尾），
    /// 并按「宽度 TTL」记 Deadline（now + 30s ＋ 前方所有条目的预估播放时长）；
    /// 插入使其后方条目的等待变长 → 后方 Deadline 统一后移。</summary>
    private void InsertBySeverity(BubbleItem item)
    {
        var idx = item.Severity is "warn" or "critical"
            ? _bubbleQueue.FindIndex(m => m.Severity == "info")
            : -1;                                          // info：队尾
        var insertAt = idx >= 0 ? idx : _bubbleQueue.Count;
        var aheadMs = 0.0;
        for (var i = 0; i < insertAt; i++) aheadMs += EstimatePlayMs(_bubbleQueue[i]);
        item = item with { Deadline = DateTime.Now.AddMilliseconds(BubbleTtlSeconds * 1000 + aheadMs) };
        if (idx >= 0) _bubbleQueue.Insert(idx, item); else _bubbleQueue.Add(item);
        for (var i = insertAt + 1; i < _bubbleQueue.Count; i++)
            _bubbleQueue[i] = _bubbleQueue[i] with { Deadline = _bubbleQueue[i].Deadline.AddMilliseconds(EstimatePlayMs(item)) };
    }

    /// <summary>出队播下一条；宽限（Deadline）超时的沿途丢弃（记账，不补播）。队列空 → 归 Idle 不驻留。</summary>
    private void TryPlayNext()
    {
        while (_bubbleQueue.Count > 0)
        {
            var head = _bubbleQueue[0];
            _bubbleQueue.RemoveAt(0);
            if (DateTime.Now <= head.Deadline)
            {
                // 二·Y 复验 P2：critical 整句出现（不打字）—— 安全告警一个字一个字蹦是负价值
                StartBubble(head, head.Severity == "critical");
                return;
            }
            AppendLog($"[气泡] 丢弃（宽限超时）：{head.Text}");
        }
        _bubblePhase = BubblePhase.Idle;
        _bubbleCurrent = null;
        _bubbleTimer.Stop();
    }

    private void StartBubble(BubbleItem item, bool instant = false)
    {
        _bubbleCurrent = item;
        _bubbleFullText = item.Text;
        _bubbleCharIndex = 0;
        _bubbleLastTextHeight = -1;
        UpdateOverlayPlacement();   // b2-a 复验观察2：气泡同样自适应（球贴上缘 → 翻转后挂球下方）
        _bubbleText.Text = instant ? _bubbleFullText : "";
        _bubbleScroll.ScrollToHome();
        _bubble.Visibility = Visibility.Visible;
        _bubble.Opacity = 0;
        _bubble.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(BubbleFadeMs)));
        _bubblePhase = BubblePhase.Typing;
        _bubbleTimer.Stop();
        _bubbleTimer.Start();
        AppendLog($"[气泡] 出队 队={_bubbleQueue.Count}（{item.Severity}）：{item.Text}");
        if (instant) CompleteTyping();   // 「不拦路」路径：跳过打字直接进停留
    }

    /// <summary>状态机唯一时钟（55ms 一拍）：Typing 逐段追加；Holding/Gap 查截止时刻。</summary>
    private void BubbleTick()
    {
        switch (_bubblePhase)
        {
            case BubblePhase.Typing:
                _bubbleText.Text += NextSegment();
                if (_bubbleCharIndex >= _bubbleFullText.Length) { CompleteTyping(); break; }
                // 自动跟随：行数（高度）变了才滚 —— 不逐字滚（逐字滚会每字重排）
                if (Math.Abs(_bubbleText.ActualHeight - _bubbleLastTextHeight) > 0.5)
                {
                    _bubbleLastTextHeight = _bubbleText.ActualHeight;
                    _bubbleScroll.ScrollToEnd();
                }
                break;

            case BubblePhase.Holding:
                if (DateTime.Now < _bubblePhaseUntil) return;
                _bubblePhase = BubblePhase.Gap;
                _bubblePhaseUntil = DateTime.Now.AddMilliseconds(BubbleGapMs);
                FadeOutBubble();
                break;

            case BubblePhase.Gap:
                if (DateTime.Now < _bubblePhaseUntil) return;
                _bubblePhase = BubblePhase.Idle;
                TryPlayNext();
                break;
        }
    }

    /// <summary>打字收尾 → 进入停留：停留时长 = max(2.5s, 2.0s + 0.09s/字)，从最后一个字显示完起算。</summary>
    private void CompleteTyping()
    {
        _bubbleText.Text = _bubbleFullText;
        _bubbleCharIndex = _bubbleFullText.Length;
        if (Math.Abs(_bubbleText.ActualHeight - _bubbleLastTextHeight) > 0.5)
        {
            _bubbleLastTextHeight = _bubbleText.ActualHeight;
            _bubbleScroll.ScrollToEnd();
        }
        var holdMs = Math.Max(2500, 2000 + 90.0 * _bubbleFullText.Length);
        _bubblePhase = BubblePhase.Holding;
        _bubblePhaseUntil = DateTime.Now.AddMilliseconds(holdMs);
        AppendLog($"[气泡] 打字完，停留 {holdMs / 1000.0:F1}s");
    }

    /// <summary>取下一段要显示的文本：英文/数字连续段整段吐（`Microsoft Windows` 不许出现 `Microsof`），中文逐字。</summary>
    private string NextSegment()
    {
        if (_bubbleCharIndex >= _bubbleFullText.Length) return "";
        if (IsWordChar(_bubbleFullText[_bubbleCharIndex]))
        {
            var j = _bubbleCharIndex;
            while (j < _bubbleFullText.Length && IsWordChar(_bubbleFullText[j])) j++;
            var seg = _bubbleFullText[_bubbleCharIndex..j];
            _bubbleCharIndex = j;
            return seg;
        }
        return _bubbleFullText[_bubbleCharIndex++].ToString();
    }

    private static bool IsWordChar(char c) =>
        char.IsAsciiLetterOrDigit(c) || c is '_' or '.' or '\\' or '-';

    /// <summary>二·Y「不拦路」单一入口：拖动 / 面板展开 / 气泡悬停三处都调 —— 打字中的立即吐完全文（动画不许挡操作）。</summary>
    private void FlushTyping()
    {
        if (_bubblePhase == BubblePhase.Typing) CompleteTyping();
    }

    /// <summary>二·Y 静音联动：立即淡出 ＋ 清空队列（解除后不补播 —— 静音期间只记账）。</summary>
    private void SuppressBubbleForMute()
    {
        var n = _bubbleQueue.Count;
        _bubbleQueue.Clear();
        _bubbleCurrent = null;
        _bubbleTimer.Stop();
        _bubblePhase = BubblePhase.Idle;
        if (_bubble.Visibility == Visibility.Visible) FadeOutBubble();
        if (n > 0) AppendLog($"[气泡] 静音：清空队列 {n} 条，解除后不补播");
    }

    private void FadeOutBubble()
    {
        var anim = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(220));
        anim.Completed += (_, _) =>
        {
            // 守卫：淡出动画完成时若已切入下一条（Typing），不能把新气泡藏掉
            if (_bubblePhase is BubblePhase.Gap or BubblePhase.Idle) _bubble.Visibility = Visibility.Collapsed;
        };
        _bubble.BeginAnimation(OpacityProperty, anim);
    }

    /// <summary>渲染冒烟专用：展开面板（复现「鼠标在球上」现场）＋ 显示气泡 —— 验证气泡不被盖住。
    /// 二·Y：走队列后用 Flush 立即吐完全文 —— 截图要确定性（不测打字机）。</summary>
    public void ShowTestBubble(string text)
    {
        ExpandPanel();
        EnqueueBubble(new SaidLine("render-test@", "info", text));
        FlushTyping();
    }

    /// <summary>渲染冒烟专用：气泡/面板的可见性与透明度实况（诊断「为什么截图里没有」）。</summary>
    public string DumpVisualState() =>
        $"bubble(V={_bubble.Visibility} O={_bubble.Opacity:F2} W={_bubble.ActualWidth:F0} H={_bubble.ActualHeight:F0}) " +
        $"panel(V={_panel.Visibility} O={_panel.Opacity:F2}) form={ActiveFormId} " +
        $"slotO(F={_slotHosts[_frontSlot]!.Opacity:F2} B={_slotHosts[1 - _frontSlot]!.Opacity:F2}) ballO={_ballHost.Opacity:F2}";

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
        FlushTyping();              // 二·Y「不拦路」：面板展开立即吐完打字中的气泡
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
        FlushTyping();                 // 二·Y「不拦路」：拖动立即吐完打字中的气泡
        _dragStartScreen = ScreenDip(e);
        _dragStartBall = new Point(BallScreenLeft, BallScreenTop);   // 记球不记窗 —— 窗口锚可翻转，球才是稳定参照
        _dragging = true;
        _dragMoved = false;
        _panelCloseTimer.Stop();       // 观察②：拖动期间面板别闪
        _hitArea.CaptureMouse();       // 捕获后 Move/Up 全路由给命中层，鼠标滑出球也不丢事件
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
        if (Mouse.Captured == _hitArea) _hitArea.ReleaseMouseCapture();
        if (!_dragMoved)
        {
            Poke();                            // 原地单击 = 戳（位移没过阈值）
            if (_hitArea.IsMouseOver) ExpandPanel();   // 点完球面板就该在（悬停球 = 面板开 的不变式）
            return;
        }
        AppendLog($"拖动结束 → ({Left:F0},{Top:F0})");
        SaveSettings();   // ⭐ b2-a ①：拖动结束时写一次位置（写盘点只有这里和关窗，绝不在 MouseMove 里写）
        if (_hitArea.IsMouseOver) ExpandPanel();       // 拖完鼠标还在球上 → 面板立刻回来，不用移出再移回
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
            if (needFlipY) { Canvas.SetBottom(_ballHost, double.NaN); Canvas.SetTop(_ballHost, BallTopMargin); }
            else { Canvas.SetTop(_ballHost, double.NaN); Canvas.SetBottom(_ballHost, BallBottomMargin); }
            AppendLog($"覆盖物方向 Y：{(needFlipY ? "翻转（球贴窗顶 → 气泡/面板挂球下方）" : "常规（球贴窗底）")}");
        }

        // ── X 锚翻转（幂等，与 Y 同构）：球贴窗左、窗口向右延伸 → 面板挂球右侧 ──
        if (needFlipX != _ballLeftAnchored)
        {
            _ballLeftAnchored = needFlipX;
            if (needFlipX) { Canvas.SetRight(_ballHost, double.NaN); Canvas.SetLeft(_ballHost, BallLeftMargin); }
            else { Canvas.SetLeft(_ballHost, double.NaN); Canvas.SetRight(_ballHost, BallRightMargin); }
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

    /// <summary>回右下角（托盘「回到右下角」/ 启动默认位）。
    /// ⭐ b2-b1 复验（2026-10-19）：必须写**球的屏幕目标位置**再经 ClampForBall 反推窗口 ——
    ///   旧版直接写窗口坐标（Top = wa.Bottom − Height − 24），隐含假设「球贴窗底」锚；
    ///   若当前是翻转锚（球贴窗顶），球会停在差 158 DIP（两锚偏移差）的地方 —— 位移是真的、
    ///   贴边是假的。与拖动路径共用同一套换算，X/Y 两轴一并修正。</summary>
    private void MoveToCorner()
    {
        var wa = SystemParameters.WorkArea;
        var targetBallLeft = wa.Right - 24 - BallSize;    // 球右缘距屏右 24
        var targetBallTop = wa.Bottom - 24 - BallSize;    // 球下缘距屏底 24
        var win = ClampForBall(wa, targetBallLeft, targetBallTop);   // 按**当前锚**反推窗口
        Left = win.Left;
        Top = win.Top;
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
            SuppressBubbleForMute();   // 二·Y：立即淡出 ＋ 清空队列（解除后不补播）
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
        // 观察2（监工 2026-10-19）：托盘是「球拖丢后唯一找回后路」，创建成败必须落盘可查
        try
        {
            InitTrayCore();
            AppendLog("托盘已创建（五项菜单 + 双击显隐）");
        }
        catch (Exception ex)
        {
            AppendLog($"[WRN] 托盘创建失败：{ex.Message}");
        }
    }

    private void InitTrayCore()
    {
        _trayShowItem = new System.Windows.Forms.ToolStripMenuItem("隐藏球");
        _trayShowItem.Click += (_, _) => ToggleBallVisible();

        _trayMuteItem = new System.Windows.Forms.ToolStripMenuItem("静一下");
        _trayMuteItem.Click += (_, _) => ToggleMute();

        var homeItem = new System.Windows.Forms.ToolStripMenuItem("回到右下角");
        homeItem.Click += (_, _) =>
        {
            if (_ballHidden) ToggleBallVisible();   // 观察4：球隐藏时点它 = 顺带显示，别让用户以为失灵
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

    /// <summary>显示/隐藏球（托盘菜单 + 双击共用）。
    /// ⭐ 观察3（监工 2026-10-19）：隐藏只藏窗 —— 内核照常跑。旧版 _idleTimer 照喂 →
    ///   内核照常闲聊 → 气泡改在隐藏窗里，**recordSpoken 照样记账 = 台词被偷吃**。
    ///   修法 = 隐藏时**停喂 context**：内核「没外壳喂 = 闲聊自动静默」（硬约束③语义），
    ///   台词不再被消耗；戳与告警不受影响（它们不走闲聊分流）。显示时立即恢复喂食。</summary>
    private void ToggleBallVisible()
    {
        _ballHidden = !_ballHidden;
        if (_ballHidden)
        {
            Hide();
            _idleTimer.Stop();
            _fluidTimer.Stop();   // b2-b2：帧率 0（完全停）—— 省电，也省形变计算
        }
        else
        {
            Show();
            _idleTimer.Start();
            _fluidTimer.Start();
            FeedIdle();   // 立即恢复喂食 —— 静音真值 / idleMs 同步刷新
        }
        if (_trayShowItem is { } item) item.Text = _ballHidden ? "显示球" : "隐藏球";
        AppendLog(_ballHidden ? "托盘：球已隐藏（闲聊暂停）" : "托盘：球已显示（闲聊恢复）");
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
    // （旧 MakeBallBrush/Lighten/Clamp255 已被 b2-b2 的 HSL 管线取代；流体几何已被形态库取代 —— 形态类在「形态注册表」节）
}
