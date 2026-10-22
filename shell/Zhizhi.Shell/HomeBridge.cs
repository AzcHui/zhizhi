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
            if (!root.TryGetProperty("cmd", out var cmdEl)) return null;
            var cmd = cmdEl.GetString() ?? "";

            switch (cmd)
            {
                case "ready":
                    // 首屏：一次给全（overview + pools + history）—— 三条独立消息
                    return new[]
                    {
                        JsonSerializer.Serialize(new { type = "overview", data = BuildOverview() }),
                        JsonSerializer.Serialize(new { type = "pools", data = BuildPools() }),
                        JsonSerializer.Serialize(new { type = "history", data = BuildHistory(200, 0, null) }),
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

    private object BuildPools()
    {
        var sections = new List<object>();

        // ① 官方池：packages/plugins/persona-zhi/persona.json（仓库内，跟着代码走）
        var repo = KernelSidecar.FindRepoRoot();
        if (repo is not null)
        {
            var personaPath = Path.Combine(repo, "packages", "plugins", "persona-zhi", "persona.json");
            foreach (var (name, lines) in ReadPoolFile(personaPath))
            {
                sections.Add(new { type = name, lines = lines.Select(l => new { text = l, source = "persona" }) });
            }
        }

        // ②③ 用户池 / 学习池：{dataDir}/user.json、{dataDir}/learned.json（不存在 = 正常）
        var dataDir = DataDir;
        if (dataDir is not null)
        {
            foreach (var (name, lines) in ReadPoolFile(Path.Combine(dataDir, "user.json")))
            {
                sections.Add(new { type = name, lines = lines.Select(l => new { text = l, source = "user" }) });
            }
            foreach (var (name, lines) in ReadPoolFile(Path.Combine(dataDir, "learned.json")))
            {
                sections.Add(new { type = name, lines = lines.Select(l => new { text = l, source = "learned" }) });
            }
        }

        return new { sections };
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
