/**
 * probe-autostart —— 安全哨兵采集（官方插件 · M8-b，照开工单《验收清单》二·U）
 *
 * 干什么：把**六处自启位置**当基线盯着 —— 有新增/被改写就产指标，由 rule-autostart
 * 翻译成告警。只负责「发现变化」，分寸全在内核（插件负责发现，内核负责分寸）。
 *
 * 六个数据源（照抄开工单）：HKCU Run / HKLM Run / HKLM WOW6432Node Run /
 * HKCU RunOnce / HKLM RunOnce（reg.exe，实测热 6.6ms 冷 73ms 一键）＋
 * 两个启动文件夹（fs.readdir，<1ms）。**一次采样把清单问完**（环境基线 8.2 铁律）。
 *
 * 基线语义：
 *   首次运行（无基线文件）→ 只记基线 + 日志说明，**一条都不告警**（用户第一次跑不被吓）；
 *   之后对比 → 新增/改写产指标 → **基线吸收**（同一件事不反复念，events.jsonl 有账可回溯）；
 *   基线损坏 → 当首次运行重建（绝不静默丢弃）。
 *
 * ⚠️ 两个开工单点名的大坑：
 *   ① `reg query` 退出码 1 = 键不存在（没有 WOW6432Node/RunOnce）—— **正常，当空集**；
 *   ② RunOnce 天生自删 —— **采到就并基线，永不报新增**（否则用户被输入法/更新程序烦死）。
 *
 * 单源失败（reg 被安全软件拦等）：WRN 一次（去重）＋ **该源本轮跳过且基线保留旧值** ——
 * 绝不把「读不到」当成「空了」（否则恢复那一刻满屏误报）。 Startup 目录用 readdir，
 * 沙箱里也能采 —— 两码事分开。
 *
 * 二·W（M8-b 第二版 A）：自启项签名深挖 —— 新增/改写告警后，异步核验目标 exe 的
 * 数字签名（PowerShell Get-AuthenticodeSignature，EncodedCommand + base64 输出，
 * 绕开引号与码页的一切坑），结果在下一个采样拍以 `security.autostart.sigcheck`
 * 指标带出，由 rule-autostart 翻译成跟进事件（正经货 info ／ 没签名 warn ／ 异常 warn）。
 * 核验是**加餐不是依赖**：PS 不可用/超时 → WRN 一次，主告警链路原样。
 */

import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineProbe } from '@zhizhi/plugin-sdk';
import type { Metric } from '@zhizhi/plugin-sdk';

// ══════════ 参数（照抄开工单，调口径只改这一块）══════════

/** reg 数据源：key = 注册表路径；runonce = 天生自删（只记基线不报新增） */
const REG_SOURCES: readonly { key: string; runonce?: boolean }[] = [
  { key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
  { key: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
  { key: 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run' },
  { key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', runonce: true },
  { key: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', runonce: true },
];

/** 启动文件夹（fs.readdir，零成本） */
const STARTUP_SOURCES: readonly { key: string; path: () => string }[] = [
  { key: 'startup:user', path: () => resolve(process.env['APPDATA'] ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') },
  { key: 'startup:system', path: () => resolve(process.env['PROGRAMDATA'] ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') },
];

/** 基线文件名（住 cli 下发的 dataDir）—— 格式照开工单：version/capturedAt/entries */
const BASELINE_FILE = 'security-baseline.json';

/** 可疑特征 —— 名称伪装成系统进程的名单（路径不在 C:\Windows\ 就是伪装） */
const IMPERSONATION_NAMES = new Set(['svchost', 'lsass', 'csrss', 'winlogon', 'explorer']);

// ══════════ 状态 ══════════

/** 上一轮基线（entries：sourceKey → (name → "TYPE|value)")。undefined = 未加载（内存里没有） */
let baseline: Record<string, Record<string, string>> | undefined;
/**
 * 基线是否已就位（loadBaseline 成功 或 本进程已完成首采）。
 * ⭐ 独立于 baseline 的 undefined：空基线 {} 是「加载到了、内容为空」——要照常对比告警，
 *   不能和「没加载过」混为一谈（否则空基线会被反复当首采重建，永远检不出第一条新增）。
 */
let baselineLoaded = false;
/** 上次写盘时的 entries 序列化结果 —— 无变化不写盘（二·V ④：原来 1Hz 无条件重写，mtime 一直在动） */
let lastEntriesJson: string | undefined;
let dataDirPath: string | undefined;
let logFn: ((msg: string) => void) | undefined;
/** 已经 WRN 过的失败源（去重 —— 采样失败不刷屏，恢复后重新武装） */
const warnedSources = new Set<string>();
/** 校准试采挂起标志 —— collect.ts 直调 sample() 测耗时时置位（二·V 碰撞修复） */
let calibrating = false;

// ══════════ 签名核验（二·W：异步、单飞、去重 —— 加餐不是依赖）══════════

/** 队列上限：同时排队+在飞的核验数。超过就丢弃并 WRN（一次）—— 防异常风暴把 PS 连环拉起 */
const SIG_QUEUE_MAX = 20;
/** 正在排队/在飞的核验（去重键 = srcKey|name|value） */
const sigInFlight = new Set<string>();
/** 已完成、等下一个采样拍带出的核验结果 */
const sigResults: Metric[] = [];
/** PowerShell 不可用只 WRN 一次（核验是加餐，坏了不该刷屏） */
let sigWarned = false;
/** 单飞链：保证任意时刻最多 1 个 PowerShell 进程 */
let sigChain: Promise<void> = Promise.resolve();

/** 从命令值里取目标（首 token，支持引号包裹）—— 与可疑特征②同一套提取逻辑 */
function extractTarget(value: string): string | undefined {
  const v = value.replace(/^[A-Z_]+\|/, '');
  const first = v.match(/^"([^"]+)"/) ?? v.match(/^(\S+)/);
  const t = first?.[1]?.trim();
  return t === '' ? undefined : t;
}

/**
 * PowerShell 核验脚本：经 -EncodedCommand（UTF-16LE base64）下发 —— 免引号地狱；
 * 目标路径走环境变量 ZZ_SIG_TARGET（路径含中文/空格/单引号都安全）；
 * 输出 base64(UTF-8) 三段：状态 |DELIM| 签名者 CN |DELIM| 实际核验的路径 —— 字节保真（latin1 教训姊妹招）。
 * 目标不存在时先 Get-Command 兜底解析（"cmd" → C:\Windows\System32\cmd.exe），
 * 用户的 `cmd /c echo test` 测试命令不许被误判成「无签名」。
 */
const PS_SCRIPT_FINAL = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$p = $env:ZZ_SIG_TARGET',
  'if (-not $p) { Write-Output ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("ERR|DELIM||"))); exit }',
  'if (-not (Test-Path -LiteralPath $p)) {',
  '  $c = Get-Command $p -ErrorAction SilentlyContinue',
  '  if ($c -and $c.Source) { $p = $c.Source }',
  '}',
  'if (-not (Test-Path -LiteralPath $p)) { Write-Output ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("MISSING|DELIM||$p"))); exit }',
  '$s = Get-AuthenticodeSignature -LiteralPath $p',
  '$cn = ""',
  'if ($s -and $s.SignerCertificate) { $m = [regex]::Match($s.SignerCertificate.Subject, "CN=([^,]+)"); $cn = $m.Groups[1].Value }',
  '$status = "UNKNOWN"; if ($s) { $status = $s.Status.ToString() }',
  'Write-Output ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$status|DELIM|$cn|DELIM|$p")))',
].join('\r\n');

const PS_COMMAND_B64 = Buffer.from(PS_SCRIPT_FINAL, 'utf16le').toString('base64');
/** PS 输出分段符（避开一切可能出现在状态/路径/厂商里的字符） */
const SIG_DELIM = '|DELIM|';

/** 单个核验任务：跑 PS → 解码 → 落结果（error 不落，只 WRN 一次） */
function runSigcheck(key: string, name: string, target: string): void {
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', PS_COMMAND_B64],
    {
      timeout: 15_000,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, ZZ_SIG_TARGET: target },
    },
    (err, stdout) => {
      sigInFlight.delete(key);
      try {
        if (err !== null && err !== undefined && (err as { killed?: boolean }).killed === true) {
          throw new Error(`超时或被终止：${err.message}`);
        }
        const decoded = Buffer.from(String(stdout).trim(), 'base64').toString('utf8');
        const parts = decoded.split(SIG_DELIM).map((s) => s.trim());
        const status = parts[0] ?? '';
        const publisher = parts[1] ?? '';
        const resolved = parts[2] ?? target;
        if (status === 'ERR') throw new Error('脚本执行失败（无目标）');
        let verdict: string;
        if (status === 'Valid') verdict = 'valid';
        else if (status === 'NotSigned') verdict = 'unsigned';
        else if (status === 'MISSING') verdict = 'missing';
        else verdict = 'broken';
        logFn?.(`[签名核验] ${name} → ${verdict}${publisher === '' ? '' : `（${publisher}）`}`);
        sigResults.push({
          key: 'security.autostart.sigcheck',
          value: 1,
          unit: 'count',
          ts: Date.now(),
          source: name,
          meta: { name, verdict, publisher, target, resolved, sourceKey: key.split('|')[0] ?? '' },
        });
      } catch (e) {
        // 核验失败是加餐失败：WRN 一次（去重），主告警链路不受任何影响
        if (!sigWarned) {
          sigWarned = true;
          logFn?.(
            `签名核验不可用（${e instanceof Error ? e.message : String(e)}）—— ` +
              '自启项告警照常，只是没有跟进的签名结论。可在终端手跑 powershell Get-AuthenticodeSignature 复核。',
          );
        }
      }
    },
  );
}

/** 排一个核验（去重 + 上限 + 单飞链）—— 只在真实采样的新增/改写检出时调用 */
function queueSigcheck(srcKey: string, name: string, value: string): void {
  const target = extractTarget(value);
  if (target === undefined) return;
  const key = `${srcKey}|${name}|${value}`;
  if (sigInFlight.has(key)) return;
  if (sigInFlight.size >= SIG_QUEUE_MAX) {
    if (!sigWarned) {
      sigWarned = true;
      logFn?.(`签名核验队列已满（${SIG_QUEUE_MAX}）—— 本轮新增项跳过核验（主告警照常）`);
    }
    return;
  }
  sigInFlight.add(key);
  sigChain = sigChain.then(() => runSigcheck(key, name, target));
}

// ══════════ reg 采集 ═══════════

/**
 * 读一个 reg 键 → (名称 → "类型|值")。
 * ⭐ 退出码 1 且无输出 = 键不存在 = **正常空集**（没有 WOW6432Node/RunOnce 的机器很常见）；
 *   有输出但退出码非 0 也照解析 —— 键在就行，别拿退出码上岗歧视。
 */
function queryRegKey(key: string): Record<string, string> {
  const r = spawnSync('reg.exe', ['query', key], { encoding: 'latin1', windowsHide: true });
  const out = r.stdout ?? '';
  if (r.status !== 0 && out.trim() === '') {
    // 退出码 1 + 无输出 = 键不存在 = 正常空集（开工单坑 1）；其它失败（如被拦）当错误抛
    if (r.status === 1) return {};
    throw new Error(
      `reg query 失败（exit ${r.status}）：读不到 ${key}。` +
        `常见原因：安全软件/沙箱拦截了 reg.exe。可在终端手动执行 reg query "${key}" 复核。`,
    );
  }
  const items: Record<string, string> = {};
  // ⭐ split 必须吃掉 \r（reg 输出 \r\n 行尾）：JS 的 `.` 不匹配 \r，`(.*)$` 遇行尾 \r
  //   会全体失配（2026-10-19 合成测试抓的——基线变空集，之后永远检不出新增）。
  for (const line of out.split(/\r?\n/)) {
    // ⭐ 类型枚举用开放集合 REG_[A-Z_]+（二·V ③）：REG_MULTI_SZ/REG_QWORD 原来整行被丢
    //   —— Run 键值类型不受限，用 MULTI_SZ 塞多条命令是真人会用的手法，**不认识也比看不见强**
    const m = line.match(/^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s+(.*?)\s*$/);
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      items[m[1].trim()] = `${m[2].slice(4)}|${m[3].trim()}`;
    }
  }
  return items;
}

/** 启动文件夹 → (文件名 → "")。目录不存在 = 正常空集 */
function readStartupDir(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).map((f) => [f, '']));
}

// ══════════ 可疑特征（开工单四条，只影响 severity 与措辞 —— 只只是哨兵不是杀软）══════════

function isSuspicious(name: string, value: string): boolean {
  const v = value.toLowerCase();
  // ① 命令行落在临时目录
  if (v.includes('\\temp\\') || v.includes('%temp%')) return true;
  // ② 指向的 exe 不存在（很多人删了程序忘了删自启）—— 取第一个 token（处理引号包裹）
  const first = v.match(/^"([^"]+)"/) ?? v.match(/^(\S+)/);
  const exePath = first?.[1] ?? '';
  if (/\.(exe|dll|bat|cmd|js|vbs|ps1)\b/.test(exePath.toLowerCase()) && exePath.includes('\\') && !existsSync(exePath)) return true;
  // ③ 名称伪装系统进程，但路径不在 C:\Windows\
  const base = name.replace(/\.(exe|dll)$/i, '').toLowerCase();
  if (IMPERSONATION_NAMES.has(base) && !v.includes('\\windows\\')) return true;
  // ④ 解释器壳 + 混淆或外联
  if (/\b(powershell|cmd|mshta|wscript)\b/.test(v) && /(-enc\b|https?:\/\/)/.test(v)) return true;
  return false;
}

// ══════════ 基线持久化 ═══════════

function baselinePath(): string | undefined {
  return dataDirPath === undefined ? undefined : resolve(dataDirPath, BASELINE_FILE);
}

function loadBaseline(): Record<string, Record<string, string>> | undefined {
  const path = baselinePath();
  if (path === undefined || !existsSync(path)) return undefined;
  try {
    // ⭐ 可选链只护「读」不护「类型」：raw?.entries !== null 在 raw 为 null 时左边是
    //   undefined !== null = true → 下面 raw.entries 直接炸（TS18047，typecheck 常年红）。
    //   显式收窄两段（二·V ②）。
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: Record<string, Record<string, string>> } | null;
    if (raw !== null && raw.entries !== null && typeof raw.entries === 'object') return raw.entries;
    // 结构不合规 = 基线损坏 —— 绝不静默丢弃，当首次运行重建（上面 return undefined 走首采分支）
    logFn?.(`安全基线文件结构不合规（${path}）—— 按首次运行重建`);
  } catch (err) {
    logFn?.(
      `安全基线文件读不动（${path}）—— 按首次运行重建：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return undefined;
}

function saveBaseline(entries: Record<string, Record<string, string>>): void {
  const path = baselinePath();
  if (path === undefined) return;
  // ⭐ 无变化不写盘（二·V ④）：原来每拍无条件重写（1Hz × 1.3KB，mtime 一直在动）——
  //   修好加载后 healthy 重启根本不需要碰这个文件。
  const entriesJson = JSON.stringify(entries);
  if (entriesJson === lastEntriesJson) return;
  try {
    // 原子替换：写 tmp → rename（同目录 rename 原子）—— 写一半崩溃/断电不留半截 JSON，
    // 不会把「读坏 → 按首次重建」这条静默漏报路径人为制造出来。
    const tmp = `${path}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), entries }, null, 2)}\n`,
      'utf8',
    );
    renameSync(tmp, path);
    lastEntriesJson = entriesJson;
  } catch {
    // 写失败不打断采样：内存基线照常对比，重启后最坏重报一次
  }
}

/** 全源条目总数（首采日志用） */
function countEntries(entries: Record<string, Record<string, string>>): number {
  return Object.values(entries).reduce((sum, m) => sum + Object.keys(m).length, 0);
}

// ══════════ 采样 ═══════════

export default defineProbe({
  id: 'probe-autostart',

  configure(config): void {
    if (typeof config['dataDir'] === 'string' && config['dataDir'] !== '') {
      dataDirPath = config['dataDir'];
    }
    // cli 把 logger 一起递进来 —— 「首次建立基线」「单源失败 WRN」这类哨兵自己的话要能上日志
    if (typeof config['log'] === 'function') logFn = config['log'] as (msg: string) => void;
    // ⭐ P0（二·V ①）：loadBaseline 必须真的被调用 —— 原来它定义了却没人调（死代码），
    //   每次启动都当「首次运行」静默重建基线 → 关机期间新增的自启项永远不告警，
    //   哨兵退化成「只在你正好开着只只时有效」。在 configure 末尾加载（dataDir/log 都已就位）。
    const loaded = loadBaseline();
    if (loaded !== undefined) {
      baseline = loaded;
      baselineLoaded = true;
      lastEntriesJson = JSON.stringify(loaded); // 加载成功 = 磁盘已是这份内容，healthy 时不再写
      logFn?.(`已加载安全基线：${countEntries(loaded)} 条自启项（security-baseline.json）—— 跨重启对比生效`);
    }
  },

  // 二·V：校准试采期间挂起副作用 —— 采集照真跑（耗时真实），但基线不对比/不吸收/不落盘
  setCalibrating(on: boolean): void {
    calibrating = on;
  },

  sample(): readonly Metric[] {
    const ts = Date.now();
    const current: Record<string, Record<string, string>> = {};
    const failedSources: string[] = [];

    // ── 采五个 reg 键 ──
    for (const src of REG_SOURCES) {
      try {
        current[src.key] = queryRegKey(src.key);
      } catch (err) {
        failedSources.push(src.key);
        if (!warnedSources.has(src.key)) {
          warnedSources.add(src.key);
          logFn?.(
            `probe-autostart：数据源 ${src.key} 不可用（${err instanceof Error ? err.message : String(err)}）—— ` +
              `该源的自启项告警已失效，其余源照常；恢复后自动重新武装`,
          );
        }
        // 基线保留旧值（绝不把「读不到」当「空了」—— 否则恢复那一刻满屏误报）
        if (baseline?.[src.key] !== undefined) current[src.key] = baseline[src.key]!;
      }
    }
    // ── 采两个启动文件夹 ──
    for (const src of STARTUP_SOURCES) {
      try {
        current[src.key] = readStartupDir(src.path());
      } catch (err) {
        failedSources.push(src.key);
        if (!warnedSources.has(src.key)) {
          warnedSources.add(src.key);
          logFn?.(`probe-autostart：数据源 ${src.key} 不可用（${err instanceof Error ? err.message : String(err)}）—— 该源告警已失效`);
        }
        if (baseline?.[src.key] !== undefined) current[src.key] = baseline[src.key]!;
      }
    }
    // 有恢复的源要重新武装 WRN（下次再失败还能听得见）—— ⭐ 每拍都清（二·V ⑤）：
    //   原来套在「本轮有失败」里，全源健康的那拍不清 → 「失败→恢复→再失败」第二次静默
    for (const key of warnedSources) {
      if (!failedSources.includes(key) && baseline?.[key] !== undefined) warnedSources.delete(key);
    }

    const metrics: Metric[] = [];
    let total = 0;
    for (const m of Object.values(current)) total += Object.keys(m).length;
    metrics.push({ key: 'security.autostartCount', value: total, unit: 'count', ts });

    // ⭐ 校准试采（二·V）：到这里为止全是真实采集（耗时真实），**就此打住** ——
    //   基线对比/吸收/落盘全是副作用，做了的话关机期间的新增会在校准里被静默吞掉
    if (calibrating) return metrics;

    // 二·W：把已完成的签名核验结果带出（真实采样拍；校准拍不经过总线，结果多等一拍）
    if (sigResults.length > 0) metrics.push(...sigResults.splice(0));

    // ── 首采：只建基线，一条不告警（开工单纪律 1）──
    // ⭐ 判据用 baselineLoaded 不是 baseline === undefined：从磁盘加载到的空基线 {} 要
    //   直接进对比（照常告警），不能被当成「没加载过」再重建一遍（二·V ①）
    if (!baselineLoaded) {
      baseline = current;
      baselineLoaded = true;
      saveBaseline(baseline);
      logFn?.(`首次建立安全基线：${countEntries(baseline)} 条自启项（security-baseline.json）—— 从现在起的变化才会告警`);
      return metrics;
    }

    const runonceKeys = new Set(REG_SOURCES.filter((s) => s.runonce).map((s) => s.key));
    // baselineLoaded=true ⇒ baseline 必非空（磁盘加载或本进程首采，二者其一）——
    // 本地快照既是语义说明，也让 TS 收窄（模块级 let 跨赋值不保留非空 narrowing）
    const prevBaseline = baseline ?? {};
    const addedMetrics: Metric[] = [];
    const changedMetrics: Metric[] = [];

    for (const [srcKey, nowItems] of Object.entries(current)) {
      const prevItems = prevBaseline[srcKey] ?? {};
      const isRunonce = runonceKeys.has(srcKey);
      for (const [name, value] of Object.entries(nowItems)) {
        const prev = prevItems[name];
        if (prev === undefined) {
          if (isRunonce) continue;   // 开工单坑 3：RunOnce 天生自删 —— 永不报新增
          addedMetrics.push({
            key: 'security.autostart.item', value: 1, unit: 'count', ts,
            source: name,
            // ⭐ 用 indexOf 定位第一个 | 取后半段（不用 split('|')[1]）：MULTI_SZ 的命令里
            //   可能自带 |，split 会把命令截断；类型前缀在解析时已剥掉 REG_ 前缀（"SZ|…"）
            meta: { name, command: value.slice(value.indexOf('|') + 1), sourceKey: srcKey, suspicious: isSuspicious(name, value) ? 1 : 0 },
          });
          queueSigcheck(srcKey, name, value);   // 二·W：新增 → 排签名核验（异步，结果下拍带出）
        } else if (prev !== value) {
          // 同名不同值 = 被改写 —— before/after 都带上（RunOnce 天生短命，改写无意义，也静默）
          if (isRunonce) continue;
          changedMetrics.push({
            key: 'security.autostart.changedItem', value: 1, unit: 'count', ts,
            source: name,
            meta: { name, before: prev, after: value, sourceKey: srcKey },
          });
          queueSigcheck(srcKey, name, value);   // 二·W：改写也核验（核的是**新值**指向的目标）
        }
        // 已消失的项（prev 有 now 无）→ 静默：基线更新时自然吸收（开工单⑤：删除不告警）
      }
    }

    metrics.push(...addedMetrics, ...changedMetrics);
    baseline = current;
    saveBaseline(baseline);   // 变化已报告 → 基线吸收（同一件事不反复念）
    return metrics;
  },
});

/**
 * 合成验收钩子（二·W 验收②③④）：loader 只 import default，不影响生产；
 * 合成探针用它**进程内直接打核心**（验收纪律 1：构造输入直接打核心，不跑真实负载）。
 */
export const __sigcheckTest = {
  queueSigcheck,
  extractTarget,
  /** 取走全部已完成的核验结果 */
  drain: (): readonly Metric[] => sigResults.splice(0),
  /** 当前排队/在飞数（去重与上限断言用） */
  pending: (): number => sigInFlight.size,
};
