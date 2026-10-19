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
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** 上一轮基线（entries：sourceKey → (name → "TYPE|value")）。undefined = 首采 */
let baseline: Record<string, Record<string, string>> | undefined;
let dataDirPath: string | undefined;
let logFn: ((msg: string) => void) | undefined;
/** 已经 WRN 过的失败源（去重 —— 采样失败不刷屏，恢复后重新武装） */
const warnedSources = new Set<string>();

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
    const m = line.match(/^\s{2,}(.+?)\s{2,}REG_(SZ|EXPAND_SZ|BINARY|DWORD)\s+(.*?)\s*$/);
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      items[m[1].trim()] = `${m[2]}|${m[3].trim()}`;
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
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: Record<string, Record<string, string>> } | null;
    if (raw?.entries !== null && typeof raw.entries === 'object') return raw.entries;
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
  try {
    writeFileSync(
      path,
      `${JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), entries }, null, 2)}\n`,
      'utf8',
    );
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
    if (failedSources.length > 0) {
      // 有恢复的源要重新武装 WRN（下次再失败还能听得见）
      for (const key of warnedSources) {
        if (!failedSources.includes(key) && baseline?.[key] !== undefined) warnedSources.delete(key);
      }
    }

    const metrics: Metric[] = [];
    let total = 0;
    for (const m of Object.values(current)) total += Object.keys(m).length;
    metrics.push({ key: 'security.autostartCount', value: total, unit: 'count', ts });

    // ── 首采：只建基线，一条不告警（开工单纪律 1）──
    if (baseline === undefined) {
      baseline = current;
      saveBaseline(baseline);
      logFn?.(`首次建立安全基线：${countEntries(baseline)} 条自启项（security-baseline.json）—— 从现在起的变化才会告警`);
      return metrics;
    }

    const runonceKeys = new Set(REG_SOURCES.filter((s) => s.runonce).map((s) => s.key));
    const addedMetrics: Metric[] = [];
    const changedMetrics: Metric[] = [];

    for (const [srcKey, nowItems] of Object.entries(current)) {
      const prevItems = baseline[srcKey] ?? {};
      const isRunonce = runonceKeys.has(srcKey);
      for (const [name, value] of Object.entries(nowItems)) {
        const prev = prevItems[name];
        if (prev === undefined) {
          if (isRunonce) continue;   // 开工单坑 3：RunOnce 天生自删 —— 永不报新增
          addedMetrics.push({
            key: 'security.autostart.item', value: 1, unit: 'count', ts,
            source: name,
            meta: { name, command: value.split('|')[1] ?? '', sourceKey: srcKey, suspicious: isSuspicious(name, value) ? 1 : 0 },
          });
        } else if (prev !== value) {
          // 同名不同值 = 被改写 —— before/after 都带上（RunOnce 天生短命，改写无意义，也静默）
          if (isRunonce) continue;
          changedMetrics.push({
            key: 'security.autostart.changedItem', value: 1, unit: 'count', ts,
            source: name,
            meta: { name, before: prev, after: value, sourceKey: srcKey },
          });
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
