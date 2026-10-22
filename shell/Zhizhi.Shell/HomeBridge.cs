using System.IO;
using System.Text.Json;

namespace Zhizhi.Shell;

/// <summary>
/// 只只的家 · 桥（M11-c，开工单 3.3）
///
/// ⭐ 纪律：
///   - **只搬数据，不含业务逻辑**（业务在内核/外壳侧）；
///   - **不新增采集** —— overview 全部来自 FloatWindow 已有的内存字段（同一采样源）；
///   - **dataDir 只认内核 hello 通告的路径**，绝不自己硬拼（打包后会变成 %LOCALAPPDATA%）。
/// </summary>
internal sealed class HomeBridge
{
    private readonly FloatWindow _float;
    private readonly KernelSidecar _kernel;

    /// <summary>日志实时推流开关（前端 subscribeLogs 切）。</summary>
    private bool _logLive;

    /// <summary>内核 stderr 环形缓冲最近 N 行（供 getLogs 用）。</summary>
    private const int KernelLogRing = 200;

    public HomeBridge(FloatWindow floatWindow, KernelSidecar kernel)
    {
        _float = floatWindow;
        _kernel = kernel;
    }

    /// <summary>内核通告的真实 dataDir（hello 行）—— null = 还没收到。</summary>
    public string? DataDir => _kernel.DataDir;

    /// <summary>
    /// 处理前端一条消息（JSON 文本）→ 返回要回给前端的 JSON 消息**列表**（0~3 条）。
    /// ⚠️ 一条命令可能回多条（ready 一次给 overview + pools + history）—— 所以是列表不是单条。
    /// ⚠️ **永不抛** —— 家崩不许带崩浮窗。
    /// </summary>
    public IReadOnlyList<string> Handle(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (!root.TryGetProperty("cmd", out var cmdEl)) return Array.Empty<string>();
            var cmd = cmdEl.GetString() ?? "";

            switch (cmd)
            {
                case "ready":
                    // 首屏：一次给全（overview + pools + history + digest）—— 四条独立消息
                    return new[]
                    {
                        JsonSerializer.Serialize(new { type = "overview", data = BuildOverview() }),
                        JsonSerializer.Serialize(new { type = "pools", data = BuildPools() }),
                        JsonSerializer.Serialize(new { type = "history", data = BuildHistory(200, 0, null) }),
                        JsonSerializer.Serialize(new { type = "digest", data = BuildDigest() }),
                    };

                case "getOverview":
                    return new[] { JsonSerializer.Serialize(new { type = "overview", data = BuildOverview() }) };

                case "getHistory":
                {
                    var limit = GetInt(root, "limit", 200);
                    var offset = GetInt(root, "offset", 0);
                    string? type = root.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
                    return new[] { JsonSerializer.Serialize(new { type = "history", data = BuildHistory(limit, offset, type) }) };
                }

                case "getPools":
                    return new[] { JsonSerializer.Serialize(new { type = "pools", data = BuildPools() }) };

                case "getDigest":
                    // ⭐ 9.4：首页摘要（今天/昨天/它注意到你/说过多少句）。
                    //   只在打开家 / 点刷新时算一次 —— **不做定时轮询**（低频界面，别学面板 1Hz）。
                    return new[] { JsonSerializer.Serialize(new { type = "digest", data = BuildDigest() }) };

                case "getLogs":
                {
                    var limit = GetInt(root, "limit", 300);
                    return new[] { JsonSerializer.Serialize(new { type = "logs", data = BuildLogs(limit) }) };
                }

                case "subscribeLogs":
                {
                    _logLive = root.TryGetProperty("on", out var on) && on.ValueKind == JsonValueKind.True;
                    return Array.Empty<string>();   // 无需回包
                }

                case "previewLine":
                {
                    var text = root.TryGetProperty("text", out var tx) && tx.ValueKind == JsonValueKind.String ? tx.GetString() : null;
                    if (string.IsNullOrWhiteSpace(text)) return Array.Empty<string>();
                    // ⚠️ 试听 = 纯预览：走 PreviewLine（不进记忆、不动 trust、不计 occurrence）
                    _float.PreviewLine(text!);
                    return new[] { JsonSerializer.Serialize(new { type = "previewDone", data = new { ok = true } }) };
                }

                case "requestSay":
                {
                    // ⭐ 9.4：首页「随便说一句」→ 走内核已有的 requestSay（内核零改动）
                    _float.RequestSay();
                    return new[] { JsonSerializer.Serialize(new { type = "sayDone", data = new { ok = true } }) };
                }

                case "toggleMute":
                {
                    // ⭐ 9.4：首页「静一下」→ 复用面板那个 ToggleMute（同一个状态源，不搞两套）
                    _float.ToggleMutePublic();
                    return new[] { JsonSerializer.Serialize(new { type = "muteDone", data = new { ok = true } }) };
                }

                default:
                    return Array.Empty<string>();
            }
        }
        catch (Exception ex)
        {
            ShellLog.Write($"[ERR] 只只的家命令处理失败：{ex.GetType().Name}: {ex.Message}");
            ShellLog.Write($"[ERR] 堆栈：{ex.StackTrace}");
            return Array.Empty<string>();
        }
    }

    private static int GetInt(JsonElement root, string key, int fallback)
    {
        if (root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i)) return i;
        return fallback;
    }

    // ───────────────────────── overview（全部来自已有内存字段，不重新采集）─────────────────────────

    private object BuildOverview()
    {
        var s = _float.HomeSnapshot;
        return new
        {
            cpu = s.Cpu,
            mem = s.Mem,
            trust = s.Trust,
            fgClass = s.FgClass,
            idleSec = s.IdleSec,
            muteLeftMin = s.MuteLeftMin,
            uptimeSec = s.UptimeSec,
            kernelRunning = _kernel.IsRunning,
        };
    }

    // ───────────────────────── 台词池（三层合并，标来源）─────────────────────────

    /// <summary>台词池的一层（段）。**强类型** —— 首页摘要要算总句数，匿名类型拿不到（9.4）。</summary>
    private sealed record PoolLayer(string Type, IReadOnlyList<PoolLineItem> Lines);

    /// <summary>池里的一句。</summary>
    private sealed record PoolLineItem(string Text, string Source);

    /// <summary>三层合并后的池（对外序列化成 { type, lines:[{text,source}] }）。</summary>
    private sealed record PoolsPayload(IReadOnlyList<PoolLayer> Sections)
    {
        /// <summary>总句数（首页摘要用；与台词池页「共 N 句」同一口径）。</summary>
        public int TotalCount => Sections.Sum(s => s.Lines.Count);
    }

    private PoolsPayload BuildPools()
    {
        var sections = new List<PoolLayer>();

        // ① 官方池：packages/plugins/persona-zhi/persona.json（仓库内，跟着代码走）
        var repo = KernelSidecar.FindRepoRoot();
        if (repo is not null)
        {
            var personaPath = Path.Combine(repo, "packages", "plugins", "persona-zhi", "persona.json");
            foreach (var (name, lines) in ReadPoolFile(personaPath))
            {
                sections.Add(new PoolLayer(name, lines.Select(l => new PoolLineItem(l, "persona")).ToList()));
            }
        }

        // ②③ 用户池 / 学习池：{dataDir}/user.json、{dataDir}/learned.json（不存在 = 正常）
        var dataDir = DataDir;
        if (dataDir is not null)
        {
            foreach (var (name, lines) in ReadPoolFile(Path.Combine(dataDir, "user.json")))
            {
                sections.Add(new PoolLayer(name, lines.Select(l => new PoolLineItem(l, "user")).ToList()));
            }
            foreach (var (name, lines) in ReadPoolFile(Path.Combine(dataDir, "learned.json")))
            {
                sections.Add(new PoolLayer(name, lines.Select(l => new PoolLineItem(l, "learned")).ToList()));
            }
        }

        return new PoolsPayload(sections);
    }

    /// <summary>
    /// 读一个台词池文件；文件不存在/坏了 → 空（不崩）。
    ///
    /// ⚠️ **两种形状都要认**（实测踩过：认漏了一种 → 页面显示「共 0 句」，但不报错）：
    ///   ① 官方 persona.json：{ "_怎么改":..., "lines": { "段名": ["句子", ...] } }  ← **段在 lines 里**
    ///   ② 用户池 user.json / learned.json：{ "段名": ["句子", ...] }                ← 段在顶层
    /// </summary>
    private static IEnumerable<(string Name, List<string> Lines)> ReadPoolFile(string path)
    {
        var result = new List<(string, List<string>)>();
        try
        {
            if (!File.Exists(path)) return result;
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return result;

            // ① 先看有没有 "lines" 子对象（官方包的形状）
            if (doc.RootElement.TryGetProperty("lines", out var linesEl) && linesEl.ValueKind == JsonValueKind.Object)
            {
                CollectSections(linesEl, result);
                return result;
            }
            // ② 否则段名直接在顶层（用户池的形状）
            CollectSections(doc.RootElement, result);
        }
        catch (Exception ex)
        {
            ShellLog.Write($"[WRN] 读台词池失败（跳过）：{path} —— {ex.Message}");
        }
        return result;
    }

    /// <summary>把一个「{ 段名: [句子, ...] }」对象收成结果列表。</summary>
    private static void CollectSections(JsonElement obj, List<(string Name, List<string> Lines)> result)
    {
        foreach (var prop in obj.EnumerateObject())
        {
            if (prop.Value.ValueKind != JsonValueKind.Array) continue;
            var lines = new List<string>();
            foreach (var item in prop.Value.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String) lines.Add(item.GetString() ?? "");
            }
            if (lines.Count > 0) result.Add((prop.Name, lines));
        }
    }

    // ───────────────────────── 首页摘要（9.4 getDigest）─────────────────────────

    /// <summary>
    /// 首页摘要：今天/昨天说了几句、它注意到你什么、说过多少句。
    ///
    /// ⚠️ **口径（开工单 9.4）**：
    ///   · 「今天/昨天」按**本地时区**分组（ts 是 epoch ms → DateTimeOffset 转本地日期）；
    ///   · ⚠️ **greeting 不计入「今天说了」**（它是一次性的「启动告知」，不是聊天）。
    ///     实测依据：今天 50 句里 **40 句是 greeting**（反复重启的噪音）——
    ///     算进去的话这个数字几乎没信息量，而且判据⑥「今天它还没开口」永远不可达
    ///     （内核一启动就打招呼 → today 至少 1）。greeting 单独记在 `greetedToday` 里。
    ///   · 「它注意到你」按 type 归并成 4 类：写码(chitchat_code) / 网页(chitchat_browser) /
    ///     开会(meeting 家族) / 戳(poked 家族) —— ⚠️ **只算今天的**
    ///     （草图里它与「今天说了」并列，是「今天它注意到你什么」；
    ///      踩过坑：漏了日期过滤 → 报「戳 111」，而今天实际只有 5 —— 那是全量历史）；
    ///   · 「说过 N 句」= **全量事件里唯一台词条数**（按 key 字段去重，不是 text ——
    ///     text 是填完占位符的成品，key 才是模板原文；同模板不同取值算同一句）。
    ///
    /// ⚠️ **为什么 uniqueSaid 不能沿用前端的 saidTotal**：
    ///   前端那个是从 history（**只取最近 200 条**）去重算的 → 会低估。
    ///   这里扫全量文件，是唯一准确口径。
    ///
    /// ⚠️ 纪律：**只在打开家/点刷新时算一次**，不轮询。文件不存在 → 全 0（前端写人话，不显示 NaN）。
    /// </summary>
    private object BuildDigest()
    {
        var today = 0;
        var yesterday = 0;
        var codeCount = 0;
        var browserCount = 0;
        var meetingCount = 0;
        var pokeCount = 0;
        var uniqueSaid = 0;
        var total = 0;
        var greetedToday = 0;   // greeting 单独记（不算进「今天说了」）
        var hasFile = false;

        var dataDir = DataDir;
        if (dataDir is not null)
        {
            var path = Path.Combine(dataDir, "memory", "events.jsonl");
            try
            {
                if (File.Exists(path))
                {
                    hasFile = true;
                    var todayDate = DateTime.Now.Date;
                    var yesterdayDate = todayDate.AddDays(-1);
                    var saidKeys = new HashSet<string>(StringComparer.Ordinal);

                    foreach (var line in File.ReadLines(path))
                    {
                        if (string.IsNullOrWhiteSpace(line)) continue;
                        JsonDocument doc;
                        try
                        {
                            doc = JsonDocument.Parse(line);
                        }
                        catch (JsonException)
                        {
                            continue;   // 坏行跳过（写盘中断可能留半行）
                        }
                        using (doc)
                        {
                            var r = doc.RootElement;
                            var ty = r.TryGetProperty("type", out var tyv) ? tyv.GetString() ?? "" : "";
                            var ts = r.TryGetProperty("ts", out var tsv) && tsv.TryGetInt64(out var tsVal) ? tsVal : 0L;

                            // 唯一台词：按 key（模板原文）去重；没有 key 的事件不算「说了句」
                            var key = r.TryGetProperty("key", out var kv) ? kv.GetString() : null;
                            if (!string.IsNullOrWhiteSpace(key)) saidKeys.Add(key!);

                            // 只统计「说/被戳」类事件 —— 告警（security.*）不是它跟你说话
                            if (!IsSayType(ty)) continue;
                            total++;

                            if (ts <= 0) continue;
                            var local = DateTimeOffset.FromUnixTimeMilliseconds(ts).LocalDateTime.Date;

                            // ⚠️ greeting 单独记 —— 它是「启动告知」，不是聊天（口径见方法注释）
                            if (ty == "greeting")
                            {
                                if (local == todayDate) greetedToday++;
                                continue;
                            }

                            if (local == todayDate)
                            {
                                today++;
                                // ⚠️ 「它注意到你」**只算今天**（草图语境：与「今天说了」并列）。
                                //   踩过坑：漏日期过滤 → 报「戳 111」，实际今天只有 5（那是全量历史）。
                                switch (ty)
                                {
                                    case "chitchat_code": codeCount++; break;
                                    case "chitchat_browser": browserCount++; break;
                                    case "poked":
                                    case "poked_again": pokeCount++; break;
                                    case "chitchat_meeting":
                                    case "chitchat_meeting_back": meetingCount++; break;
                                }
                            }
                            else if (local == yesterdayDate)
                            {
                                yesterday++;
                            }
                        }
                    }
                    uniqueSaid = saidKeys.Count;
                }
            }
            catch (Exception ex)
            {
                ShellLog.Write($"[WRN] 读摘要失败（降级为全 0）：{ex.Message}");
            }
        }

        // 池子总句数：三层池合并（官方 + 用户 + 学习）—— 与台词池页同一份口径
        var poolTotal = BuildPools().TotalCount;

        return new
        {
            today,
            yesterday,
            total,
            greetedToday,
            uniqueSaid,
            poolTotal,
            hasFile,
            noticed = new { code = codeCount, browser = browserCount, meeting = meetingCount, poke = pokeCount },
        };
    }

    /// <summary>「说/被戳」类事件（告警与安全事件不算它跟你说话）。</summary>
    private static bool IsSayType(string type) => type switch
    {
        "greeting" => true,
        "chitchat" => true,
        "chitchat_code" => true,
        "chitchat_browser" => true,
        "chitchat_back" => true,
        "chitchat_meeting" => true,
        "chitchat_meeting_back" => true,
        "poked" => true,
        "poked_again" => true,
        "said" => true,
        _ => false,
    };

    // ───────────────────────── 消息历史（events.jsonl 倒序分页）─────────────────────────

    private object BuildHistory(int limit, int offset, string? typeFilter)
    {
        var items = new List<object>();
        var total = 0;
        var dataDir = DataDir;
        if (dataDir is null) return new { total = 0, items };

        var path = Path.Combine(dataDir, "memory", "events.jsonl");
        try
        {
            if (!File.Exists(path)) return new { total = 0, items };
            // 倒序读：文件不大（1MB 轮转），整读再倒排 —— 简单可靠
            var all = new List<(long Ts, string Type, string Sev, string Text)>();
            foreach (var line in File.ReadLines(path))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var r = doc.RootElement;
                    var ts = r.TryGetProperty("ts", out var tsv) && tsv.TryGetInt64(out var tsVal) ? tsVal : 0L;
                    var ty = r.TryGetProperty("type", out var tyv) ? tyv.GetString() ?? "" : "";
                    var sev = r.TryGetProperty("severity", out var sevV) ? sevV.GetString() ?? "info" : "info";
                    var tx = r.TryGetProperty("text", out var txv) ? txv.GetString() ?? "" : "";
                    all.Add((ts, ty, sev, tx));
                }
                catch (JsonException)
                {
                    // 坏行跳过 —— 历史文件可能有半行（写盘中断）
                }
            }
            all.Reverse();   // 最新的在前
            if (!string.IsNullOrEmpty(typeFilter))
            {
                all = all.Where(x => x.Type == typeFilter).ToList();
            }
            total = all.Count;
            foreach (var x in all.Skip(offset).Take(limit))
            {
                items.Add(new { ts = x.Ts, type = x.Type, severity = x.Sev, text = x.Text });
            }
        }
        catch (Exception ex)
        {
            ShellLog.Write($"[WRN] 读消息历史失败：{ex.Message}");
        }
        return new { total, items };
    }

    // ───────────────────────── 日志（外壳 log + 内核 stderr）─────────────────────────

    private object BuildLogs(int limit)
    {
        var lines = new List<object>();
        // 外壳日志（内存环形缓冲 —— 已在 FloatWindow 里）
        foreach (var l in _float.DumpLogItems().TakeLast(limit))
        {
            lines.Add(new { ts = DateTimeOffset.Now.ToUnixTimeMilliseconds(), source = "shell", text = l.Text });
        }
        // 内核 stderr
        foreach (var l in _kernel.DumpStderrLines().TakeLast(limit))
        {
            lines.Add(new { ts = l.Ts, source = "kernel", text = l.Text });
        }
        // 时间升序（外壳的 ts 是"现在"，粗一点无妨）
        lines = lines.OrderBy(x => (long)x.GetType().GetProperty("ts")!.GetValue(x)!).ToList();
        return new { items = lines.TakeLast(limit).ToList() };
    }

    /// <summary>内核 stderr 新行 → 推给前端（实时流）。由 KernelSidecar 调。</summary>
    public void PushKernelLogLine(string text)
    {
        if (!_logLive) return;
        var msg = JsonSerializer.Serialize(new
        {
            type = "logLine",
            data = new { ts = DateTimeOffset.Now.ToUnixTimeMilliseconds(), source = "kernel", text },
        });
        _float.PostToHome(msg);
    }
}
