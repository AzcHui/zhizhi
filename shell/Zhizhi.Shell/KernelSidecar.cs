using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Zhizhi.Shell;

/// <summary>
/// 一条采样：从内核 stdout 的 tick 报告行解析出来。
/// （stdout 只出数据 —— M0 锁定的约定；stderr 只出日志。）
/// </summary>
public sealed record Sample(int Tick, double? Cpu, double? Mem, int? Trust);

/// <summary>
/// 一句只只说的话：从 stdout 的 {"type":"event"} 行解析出来 ——
/// 告警和闲聊一条路（M6 漂移闭环后的约定），poked 的回应也在这条路上。
/// </summary>
public sealed record SaidLine(string EventId, string Level, string Text);

/// <summary>
/// 内核 sidecar：外壳自己把 node 内核拉起来当子进程，长连接读它的流。
/// ⚠️ C# 里读子进程输出用 DataReceived 事件是安全的（那条「线程池线程炸脚本块」的坑
///    是 PowerShell 特有）；但回调不在 UI 线程 → 事件监听方必须自己 Dispatcher 切回。
/// ⚠️ 编码必须显式 UTF8 —— 否则只只说的中文被按系统 ANSI（GBK）解成乱码（M4-a 实测踩过）。
/// </summary>
public sealed class KernelSidecar : IDisposable
{
    private Process? _proc;
    private readonly StringBuilder _stderrBuf = new();

    /// <summary>每收到一条采样（UI 线程外！监听方自行调度）。</summary>
    public event Action<Sample>? SampleArrived;

    /// <summary>只只说了话（UI 线程外！）。</summary>
    public event Action<SaidLine>? Said;

    public bool IsRunning => _proc is { HasExited: false };
    public int? Pid => _proc is { HasExited: false } ? _proc.Id : null;

    /// <summary>启动日志（含定位失败、退出等）。</summary>
    public event Action<string>? Log;

    /// <summary>
    /// 定位仓库根：从 exe 所在目录向上找 packages/cli/src/main.ts（最多 8 层）。
    /// 找不到返回 null —— 由调用方决定怎么报告（不猜、不静默填错）。
    /// </summary>
    public static string? FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "packages", "cli", "src", "main.ts")))
                return dir.FullName;
        }
        return null;
    }

    /// <summary>拉起内核。失败抛异常（调用方决定怎么显示 —— 不吞）。</summary>
    public void Start(string repoRoot, int intervalMs)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "node",
            WorkingDirectory = repoRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            StandardOutputEncoding = new UTF8Encoding(false),   // ⚠️ 必须 —— 否则中文乱码
            StandardErrorEncoding = new UTF8Encoding(false),
        };
        psi.ArgumentList.Add("--disable-warning=ExperimentalWarning");
        psi.ArgumentList.Add("packages/cli/src/main.ts");
        psi.ArgumentList.Add($"--interval={intervalMs}");

        _proc = Process.Start(psi) ?? throw new InvalidOperationException("node 进程启动失败（Process.Start 返回 null）");
        _proc.OutputDataReceived += OnStdout;
        _proc.ErrorDataReceived += OnStderr;
        _proc.BeginOutputReadLine();
        _proc.BeginErrorReadLine();     // ⚠️ stderr 必须抽干，否则 64KB 管道写满会阻塞内核（M4-a 老规矩）
        Log?.Invoke($"内核已作为 sidecar 启动：PID={_proc.Id} interval={intervalMs}ms cwd={repoRoot}");
    }

    private void OnStdout(object sender, DataReceivedEventArgs e)
    {
        var line = e.Data;
        if (string.IsNullOrEmpty(line)) return;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.TryGetProperty("type", out var t) && t.ValueEquals("event"))
            {
                var said = new SaidLine(
                    root.TryGetProperty("eventId", out var eid) ? eid.GetString() ?? "" : "",
                    root.TryGetProperty("level", out var lv) ? lv.GetString() ?? "" : "",
                    root.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "");
                Said?.Invoke(said);
                return;
            }
            if (root.TryGetProperty("probes", out var probes))
            {
                SampleArrived?.Invoke(new Sample(
                    root.TryGetProperty("tick", out var tk) ? tk.GetInt32() : 0,
                    PickMetric(probes, "probe-cpu", "cpu.usage"),
                    PickMetric(probes, "probe-mem", "mem.usage"),
                    root.TryGetProperty("trust", out var tr) && tr.TryGetInt32(out var tvi) ? tvi : null));
            }
        }
        catch (JsonException)
        {
            // stdout 理论上只有数据；坏行不崩外壳，记一笔走人
            Log?.Invoke($"[WRN] stdout 有行不是合法 JSON（已忽略）：{line[..Math.Min(80, line.Length)]}");
        }
    }

    private static double? PickMetric(JsonElement probes, string probeId, string key)
    {
        if (probes.ValueKind != JsonValueKind.Object || !probes.TryGetProperty(probeId, out var arr)) return null;
        if (arr.ValueKind != JsonValueKind.Array) return null;
        foreach (var m in arr.EnumerateArray())
        {
            if (m.TryGetProperty("key", out var k) && k.ValueEquals(key) && m.TryGetProperty("value", out var v))
            {
                return v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
            }
        }
        return null;
    }

    private void OnStderr(object sender, DataReceivedEventArgs e)
    {
        // stderr = 日志。b1 只留最近 64 行做诊断窗口（面板「日志」按钮可看），不落盘。
        if (string.IsNullOrEmpty(e.Data)) return;
        lock (_stderrBuf)
        {
            _stderrBuf.AppendLine(e.Data);
            if (_stderrBuf.Length > 8192) _stderrBuf.Clear(); // 极简防膨胀
        }
    }

    public string DumpStderr()
    {
        lock (_stderrBuf) { return _stderrBuf.ToString(); }
    }

    /// <summary>往反向通道写一行 JSON（idleMs / requestSay / poked）。</summary>
    public bool Feed(string line)
    {
        if (!IsRunning) return false;
        try
        {
            _proc!.StandardInput.WriteLine(line);
            return true;
        }
        catch (Exception ex)
        {
            Log?.Invoke($"[WRN] 反向通道写失败（闲聊会静默，监控不受影响）：{ex.Message}");
            return false;
        }
    }

    public void Stop()
    {
        var p = _proc;
        _proc = null;
        if (p is null) return;
        try
        {
            if (!p.HasExited)
            {
                p.Kill(entireProcessTree: true);   // ⚠️ 必须收 —— 不然留孤儿 node
                p.WaitForExit(3000);
            }
            Log?.Invoke("内核 sidecar 已收掉");
        }
        catch (Exception ex)
        {
            Log?.Invoke($"[WRN] 收内核时出错：{ex.Message}");
        }
        finally
        {
            p.Dispose();
        }
    }

    public void Dispose() => Stop();
}
