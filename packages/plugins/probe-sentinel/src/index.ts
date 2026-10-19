/**
 * probe-sentinel —— 安全哨兵采集（官方插件 · M8-b）
 *
 * 干什么：把「开机自启项」（HKCU\...\Run）当**基线**盯着 —— 出现新的就产指标，
 * 由 rule-sentinel 翻译成告警。只负责「发现变化」，分寸全在内核（铁律：插件负责发现，内核负责分寸）。
 *
 * 为什么是子进程类：Node 没有注册表 API，零运行时依赖也不允许引 npm 注册表库。
 * 走 `cmd /c chcp 65001 & reg query`（实测 ~270ms，比起一次 PowerShell 的 966ms 便宜）；
 * chcp 65001 让 reg 以 UTF-8 出中文项名。**一次进程把清单问完**（环境基线 8.2 铁律：绝不能一个指标起一次进程）。
 *
 * 基线语义（验收「一分钟内告警」）：
 *   首次采样 = 建基线（不告警 —— 你机器上已有的东西不是异常）；
 *   之后每次对比 → 新增项产 `sentinel.autorunAdded`（meta 带名称与命令）→ **基线吸收**（告警一次就够，不重复狼来了）；
 *   消失项产 `sentinel.autorunRemoved`（info —— 可能是卸载，也可能是恶意清理痕迹，值得知道但别吓人）；
 *   基线持久化到 dataDir/sentinel-baseline.json（configure 下发路径）→ **重启后不重报**。
 *
 * ⚠️ 采样失败（reg 不可用 / 被安全软件拦截）→ **抛错**让内核的错误隔离去记录，
 *   绝不返回空数组冒充「没有自启项」—— 宁可吵，不可静默装没事。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineProbe } from '@zhizhi/plugin-sdk';
import type { Metric } from '@zhizhi/plugin-sdk';

// ══════════ 参数（调口径只改这一块）══════════

/** 自启项所在的注册表键（HKCU 只看当前用户 —— 不需要管理员权限） */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** 基线文件名（住 cli 下发的 dataDir，与 zhizhi.settings.json 同层） */
const BASELINE_FILE = 'sentinel-baseline.json';

// ══════════ 状态（模块级 —— 与 probe-cpu 的 previous 快照同款做法）══════════

/** 上一次见到的自启项集合（名称 → 命令）。undefined = 还没见过（首采建基线） */
let lastSeen: Map<string, string> | undefined;
/** cli 下发的数据目录（configure）；没拿到 = 基线只在内存里活一个进程周期 */
let dataDirPath: string | undefined;

/** 一次读出来的自启项集合 */
interface AutorunSnapshot {
  readonly items: Map<string, string>;
  /** reg 的原始退出码与 stderr —— 失败时抛错用 */
  readonly status: number;
}

function queryAutorun(): AutorunSnapshot {
  // ⚠️ cmd /c chcp 65001 —— reg 输出中文项名按控制台代码页；不切 65001 就是 GBK 乱码
  const r = spawnSync(
    'cmd.exe',
    ['/d', '/s', '/c', `chcp 65001 >nul & reg query "${RUN_KEY}"`],
    { encoding: 'utf8', windowsHide: true },
  );
  // reg 对「键不存在」返回 1 且 stdout 为空 —— 那也是合法状态（没有自启项）
  if (r.status !== 0 && (r.stdout ?? '').trim() === '') {
    // ⚠️ stderr 是 GBK（控制台代码页），utf8 解出来是乱码 —— 别把它塞进错误消息；
    //    只报 exit code + 最可能的原因，要真原文去 cmd 里手动跑一次看。
    throw new Error(
      `reg query 失败（exit ${r.status}）：读不到自启项。` +
        `常见原因：安全软件/沙箱拦截了 reg.exe（错误隔离后内核照常运行，但哨兵不工作）。` +
        `可在终端手动执行 reg query "${RUN_KEY}" 复核。`,
    );
  }
  const items = new Map<string, string>();
  // reg query 输出：首行键路径、空行、然后每项一行「    <名称>    REG_SZ    <命令>」
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/^\s{2,}(.+?)\s{2,}REG_(?:SZ|EXPAND_SZ|BINARY|DWORD)\s+(.*)$/);
    if (m?.[1] && m[2] !== undefined) items.set(m[1].trim(), m[2].trim());
  }
  return { items, status: r.status ?? 0 };
}

// ══════════ 基线持久化（重启后不重报的关键）══════════

function baselinePath(): string | undefined {
  return dataDirPath === undefined ? undefined : resolve(dataDirPath, BASELINE_FILE);
}

function loadBaseline(): Map<string, string> | undefined {
  const path = baselinePath();
  if (path === undefined || !existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { items?: Record<string, string> } | null;
    if (raw?.items !== null && typeof raw.items === 'object') {
      return new Map(Object.entries(raw.items));
    }
  } catch {
    // 基线坏了 = 当没有（下次重 建）—— 不静默装「没变化」，代价只是重报一次
  }
  return undefined;
}

function saveBaseline(items: Map<string, string>): void {
  const path = baselinePath();
  if (path === undefined) return;   // 没 dataDir（比如探针环境）→ 基线只在内存，注释里已声明代价
  try {
    writeFileSync(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), items: Object.fromEntries(items) }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // 写失败同理：下个周期用内存基线照常对比；重启后最坏重报一次 —— 不打断采样
  }
}

// ══════════ 采样（对比 → 产指标）══════════

export default defineProbe({
  id: 'probe-sentinel',

  configure(config): void {
    // cli 下发 dataDir（用户数据目录）—— 基线文件住这里，重启后不重报
    if (typeof config['dataDir'] === 'string' && config['dataDir'] !== '') {
      dataDirPath = config['dataDir'];
    }
  },

  sample(): readonly Metric[] {
    const ts = Date.now();
    const { items } = queryAutorun();
    const count = items.size;

    // 首采：建基线（文件有就用文件的 —— 重启不重报；没有就把当前状态记下去）
    if (lastSeen === undefined) {
      const persisted = loadBaseline();
      lastSeen = persisted ?? items;
      if (persisted === undefined) saveBaseline(items);
      return [{ key: 'sentinel.autorunCount', value: count, unit: 'count', ts }];
    }

    const metrics: Metric[] = [{ key: 'sentinel.autorunCount', value: count, unit: 'count', ts }];

    const added = [...items.entries()].filter(([name]) => !lastSeen!.has(name));
    const removed = [...lastSeen!.keys()].filter((name) => !items.has(name));

    if (added.length > 0) {
      // ⭐ 新增项：出现即事实（ephemeral，见 rule-sentinel）—— meta 里带上名称与命令，
      //   rule 翻译成告警时要说得出来「是谁、从哪来」。「多少」是报警，「谁」才是帮助。
      for (const [name, command] of added) {
        metrics.push({
          key: 'sentinel.autorunAdded',
          value: 1,
          unit: 'count',
          ts,
          source: name,
          meta: { name, command },
        });
      }
    }
    if (removed.length > 0) {
      for (const name of removed) {
        metrics.push({
          key: 'sentinel.autorunRemoved',
          value: 1,
          unit: 'count',
          ts,
          source: name,
          meta: { name, command: lastSeen!.get(name) ?? '' },
        });
      }
    }

    if (added.length > 0 || removed.length > 0) saveBaseline(items);   // 变化已报告 → 基线吸收（告警一次就够）
    lastSeen = items;
    return metrics;
  },
});
