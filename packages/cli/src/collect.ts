/**
 * 只只 · cli —— 采集层（M8-a · 决策 #24）
 *
 * 职责：把「采集」从统一 tick 里拆出来，做成**可控、可知、有底线**的独立层。
 *
 *   probe →（per-probe 自调度链）→ bus('metric')
 *
 * 四条验收（进度报表 M8-a 行）：
 *   ① 关掉一个 probe → 启动报告写明「哪些告警因此失效」（不静默失效）
 *   ② 档位设得比底线更快 → 内核抬到底线 + 告警，不照做
 *   ③ 启动报告公开采集开销（每个 probe 多少 ms）
 *   ④ 🔴 关掉 probe 不得影响闲聊 —— 心跳与 probe 完全解耦（main.ts 装配）
 *
 * 决策 #24 的口径：
 *   - 用户只给**档位**（off/slow/normal/fast），不给毫秒 —— 免得理解底层数字
 *   - 底线不靠人声明：实测全链路耗时（3 次取中位数）→ `minInterval = max(实测×20, 1000ms)`（占空比 ≤5%）
 *   - 校准结果**缓存**（probe 集合变了才重测；「重新校准」= 删缓存文件）
 *   - 不做「持续学习」—— 同机器耗时不怎么变，且会跟用户档位打架
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Logger } from '@zhizhi/core';
import type { MetricBatch, Probe, Rule } from '@zhizhi/core';

// ══════════ M8-a 参数（调口径只改这一块）══════════

/** 档位 → 目标采样间隔（ms）。用户语言是「快慢」，毫秒是内核的事（决策 #24 ①）。 */
export const TIER_MS = {
  fast: 1_000,    // 快：秒级响应（alarm-oriented）
  normal: 5_000,  // 常态：与旧统一 tick 的默认一致
  slow: 30_000,   // 慢：低频巡检（磁盘这类变化慢的）
  off: 0,         // 关：不调度
} as const;

export type Tier = keyof typeof TIER_MS;

const TIERS: readonly Tier[] = ['off', 'slow', 'normal', 'fast'];

/** 占空比上限的倒数：最小间隔 = 实测耗时 × 这个系数（#24 ②：≤5% 的采集占空比） */
const MIN_INTERVAL_FACTOR = 20;

/** 底线的绝对下限（ms）—— 再快的 probe 也别超过每秒一次（#24 ②） */
const MIN_INTERVAL_FLOOR = 1_000;

/** 校准实测次数（#24 ②：3~5 次取中位数） */
const CALIBRATION_RUNS = 3;

/** 校准缓存的文件名（住数据目录，与 zhizhi.settings.json 同层） */
const CALIBRATION_FILE = 'probe-calibration.json';

// ══════════ 采集计划（settings.probes → 每个 probe 的档位与目标间隔）══════════

export interface ProbePlanEntry {
  readonly tier: Tier;
  /** 档位换算的目标间隔（ms）；off = 0 */
  readonly targetMs: number;
}

export type ProbePlan = ReadonlyMap<string, ProbePlanEntry>;

/**
 * 解析 `settings.probes`（`{ "<probeId>": "off|slow|normal|fast" }`）。
 *
 * 三条纪律（与 loadSettings 一致）：
 *   键不是清单里的 probe → 告警 + 忽略（多半是拼写错，宁可不猜）
 *   值不是四个档位之一   → 告警 + 回落 normal（不静默填错）
 *   没写的 probe         → normal（默认档）
 */
export function parseProbePlan(
  settings: Readonly<Record<string, unknown>>,
  probeIds: readonly string[],
  log: Logger,
): ProbePlan {
  const raw = settings['probes'];
  const userTiers = new Map<string, string>();

  if (raw !== undefined) {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string' && (TIERS as readonly string[]).includes(value)) {
          userTiers.set(id, value);
        } else {
          log.warn(
            `settings.probes["${id}"] 必须是 ${TIERS.join(' / ')} 之一（收到 ${JSON.stringify(value) ?? 'undefined'}）—— 按 normal 处理`,
          );
        }
      }
    } else {
      log.warn('settings.probes 必须是对象（如 {"probe-cpu": "slow"}）—— 整段忽略，全部按 normal');
    }
  }

  // 清单里有、用户拼错的 probe id —— 提醒一句（写了个永不生效的配置比没有更糟）
  for (const id of userTiers.keys()) {
    if (!probeIds.includes(id)) {
      log.warn(`settings.probes["${id}"]：清单里没有这个 probe（现有：${probeIds.join(', ') || '无'}）—— 忽略`);
    }
  }

  const plan = new Map<string, ProbePlanEntry>();
  for (const id of probeIds) {
    const tier = (userTiers.get(id) ?? 'normal') as Tier;
    plan.set(id, { tier, targetMs: TIER_MS[tier] });
  }
  return plan;
}

// ══════════ 底线自测（#24 ②：实测 → 中位数 → 缓存）══════════

export interface Calibration {
  /** 实测全链路耗时的中位数（ms） */
  readonly medianMs: number;
  /** 最小采样间隔（ms）= max(实测 × 20, 1000) —— 占空比 ≤5% */
  readonly minIntervalMs: number;
  /** 本次是读缓存（true）还是现测的（false）—— 启动报告注明 */
  readonly fromCache: boolean;
}

interface CalibFileShape {
  /** 校准签名 = probe id 排序拼接 —— 集合变了才重测（#24 ②） */
  signature: string;
  at: string;
  probes: Record<string, { medianMs: number; at: string }>;
}

const signatureOf = (probes: readonly Probe[]): string =>
  probes.map((p) => p.id).sort().join('|');

/** 实测一个 probe 采一次的全链路耗时（ms） */
async function measureOnce(probe: Probe): Promise<number> {
  const started = performance.now();
  await probe.sample();
  return performance.now() - started;
}

/** 中位数（奇数个直接取中间；偶数个取偏小的中间值 —— 保守，宁高勿低） */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * 校准全部 probe：读缓存（签名一致）或现测（3 次取中位数）。
 * ⭐ 实测**不经总线**（直接调 sample()）—— 校准用的采样不该触发规则、不算进正式数据。
 */
export async function calibrateProbes(
  probes: readonly Probe[],
  dataDir: string,
  log: Logger,
): Promise<ReadonlyMap<string, Calibration>> {
  const result = new Map<string, Calibration>();
  if (probes.length === 0) return result;

  const path = resolve(dataDir, CALIBRATION_FILE);
  const signature = signatureOf(probes);

  // ① 先看缓存：签名一致 → 直接用（#24 ④：不做持续学习 —— 同机器耗时不怎么变）
  if (existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as CalibFileShape;
      if (cached.signature === signature && cached.probes !== null && typeof cached.probes === 'object') {
        for (const probe of probes) {
          const hit = cached.probes[probe.id];
          if (typeof hit?.medianMs === 'number' && Number.isFinite(hit.medianMs) && hit.medianMs >= 0) {
            result.set(probe.id, {
              medianMs: hit.medianMs,
              minIntervalMs: Math.max(Math.round(hit.medianMs * MIN_INTERVAL_FACTOR), MIN_INTERVAL_FLOOR),
              fromCache: true,
            });
          }
        }
        if (result.size === probes.length) {
          log.info(
            `采集校准：命中缓存（${CALIBRATION_FILE}，签名一致）—— ${probes.map((p) => `${p.id} ${result.get(p.id)!.medianMs.toFixed(1)}ms`).join(' / ')}；删该文件可强制重新校准`,
          );
          return result;
        }
        log.warn(`采集校准：缓存缺条目（${probes.length - result.size} 个）—— 全部重新实测`);
      } else {
        log.info(`采集校准：probe 集合变了（缓存签名 ${cached.signature} ≠ 现算 ${signature}）—— 重新实测`);
      }
    } catch (err) {
      log.warn(`采集校准：缓存读不动（${CALIBRATION_FILE}）—— 重新实测`, err instanceof Error ? err.message : err);
    }
  }

  // ② 现测：每个 probe 采 CALIBRATION_RUNS 次取中位数
  for (const probe of probes) {
    try {
      const samples: number[] = [];
      for (let i = 0; i < CALIBRATION_RUNS; i++) samples.push(await measureOnce(probe));
      const medianMs = median(samples);
      result.set(probe.id, {
        medianMs,
        minIntervalMs: Math.max(Math.round(medianMs * MIN_INTERVAL_FACTOR), MIN_INTERVAL_FLOOR),
        fromCache: false,
      });
    } catch (err) {
      // 校准失败 ≠ 内核失败：按「不知道耗时」处理 → 底线取绝对下限，告警说明
      log.warn(
        `采集校准：${probe.id} 实测抛错（已隔离）—— 底线按 ${MIN_INTERVAL_FLOOR}ms 处理`,
        err instanceof Error ? err.message : err,
      );
      result.set(probe.id, { medianMs: Number.NaN, minIntervalMs: MIN_INTERVAL_FLOOR, fromCache: false });
    }
  }

  // ③ 写缓存（写失败不拦 —— 大不了下次重测）
  const file: CalibFileShape = { signature, at: new Date().toISOString(), probes: {} };
  for (const [id, c] of result) {
    if (Number.isFinite(c.medianMs)) file.probes[id] = { medianMs: c.medianMs, at: file.at };
  }
  try {
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    log.info(
      `采集校准：实测 ${CALIBRATION_RUNS} 次取中位数 —— ${probes.map((p) => `${p.id} ${result.get(p.id)!.medianMs.toFixed(1)}ms → 底线 ${result.get(p.id)!.minIntervalMs}ms`).join(' / ')}（已缓存到 ${CALIBRATION_FILE}）`,
    );
  } catch (err) {
    log.warn(`采集校准：缓存写不进去（${path}）—— 下次启动会重新实测`, err instanceof Error ? err.message : err);
  }
  return result;
}

// ══════════ 生效间隔（档位 vs 底线 —— 验收②：宁抬勿快）══════════

export interface EffectiveEntry {
  /** 最终生效的采样间隔（ms）；off = 0（不调度） */
  readonly effectiveMs: number;
  /** 是否被底线抬高过（启动报告要说明，不静默改用户的档位） */
  readonly raisedToFloor: boolean;
}

/**
 * 档位目标 vs 自测底线取大 —— 用户要「更快」而 probe 扛不住时，**内核抬到底线 + 告警**，
 * 不照做（#24 ③：把 1s 一次的 probe 设成 1s 一采 = 每秒起一个耗时 1s 的进程，
 * 「系统生命体征助手把自己电脑搞卡是最讽刺的失败」）。
 */
export function resolveEffectiveIntervals(
  plan: ProbePlan,
  calibration: ReadonlyMap<string, Calibration>,
  log: Logger,
): ReadonlyMap<string, EffectiveEntry> {
  const out = new Map<string, EffectiveEntry>();
  for (const [id, entry] of plan) {
    if (entry.tier === 'off') {
      out.set(id, { effectiveMs: 0, raisedToFloor: false });
      continue;
    }
    const minInterval = calibration.get(id)?.minIntervalMs ?? MIN_INTERVAL_FLOOR;
    if (entry.targetMs < minInterval) {
      log.warn(
        `${id}：${entry.tier} 档（${entry.targetMs}ms）低于它的实测底线 ${minInterval}ms —— 已抬到底线（占空比 ≤5%，宁慢勿卡）`,
      );
      out.set(id, { effectiveMs: minInterval, raisedToFloor: true });
    } else {
      out.set(id, { effectiveMs: entry.targetMs, raisedToFloor: false });
    }
  }
  return out;
}

// ══════════ 启动报告（验收①③：采集开销公开 + 关 probe 不静默）══════════

/**
 * 打印采集计划报告。
 *
 * 验收①：off 的 probe 必须列出「哪些告警因此失效」—— 依据是各规则自己声明的
 * `watches`（指标 key 列表）；没声明 watches 的规则按指标前缀约定（probe-x → `x.`）
 * 推断，推不出就明说「无法推断」，绝不假装没事。
 */
export function reportCollectionPlan(
  plan: ProbePlan,
  effective: ReadonlyMap<string, EffectiveEntry>,
  calibration: ReadonlyMap<string, Calibration>,
  rules: readonly Rule[],
  log: Logger,
): void {
  log.info('── 采集计划（M8-a）──');
  for (const [id, entry] of plan) {
    const eff = effective.get(id)!;
    if (entry.tier === 'off') {
      log.info(`${id}：off（不采样）`);
      continue;
    }
    const calib = calibration.get(id);
    const measured = calib === undefined || !Number.isFinite(calib.medianMs)
      ? '未知（校准失败）'
      : `${calib.medianMs.toFixed(1)}ms`;
    const raised = eff.raisedToFloor ? ` ⚠️ 已从 ${entry.targetMs}ms 抬到底线` : '';
    log.info(
      `${id}：${entry.tier} → ${eff.effectiveMs}ms（实测 ${measured}，底线 ${calib?.minIntervalMs ?? '?'}ms）${raised}`,
    );
  }

  // 验收①：关掉的 probe → 谁的告警跟着失效
  const offIds = [...plan.entries()].filter(([, e]) => e.tier === 'off').map(([id]) => id);
  if (offIds.length === 0) return;
  for (const offId of offIds) {
    const prefix = `${offId.replace(/^probe-/, '')}.`;
    const affected: string[] = [];
    const undeclared: string[] = [];
    for (const rule of rules) {
      if (rule.watches === undefined) {
        undeclared.push(rule.id);
        continue;
      }
      const hits = rule.watches.filter((key) => key.startsWith(prefix));
      if (hits.length > 0) affected.push(`${rule.id}（${hits.join(', ')}）`);
    }
    if (affected.length > 0) {
      log.warn(`${offId} 已关 —— 以下告警因此失效：${affected.join('；')}`);
    } else {
      log.warn(`${offId} 已关 —— 已登记规则里没有依赖它的告警`);
    }
    if (undeclared.length > 0) {
      log.warn(
        `${offId} 已关 —— 另有 ${undeclared.length} 条规则未声明 watches，无法推断是否受影响：${undeclared.join(', ')}`,
      );
    }
  }
  log.info('── 采集计划完 ──');
}

// ══════════ per-probe 自调度链（#24 ③：不再跟着统一 tick）══════════

export interface ProbeLoop {
  stop(): void;
}

/**
 * 一条 probe 的自调度链 —— 与 core/scheduler 同哲学：`setTimeout` 链而非 `setInterval`
 * （上一轮没跑完绝不排下一轮，采样重叠结构性不可能）。首采立即做。
 *
 * @param emit 采样成功后的出口（main.ts 里 = 写最近快照 + bus.emit('metric')）
 */
export function startProbeLoop(
  probe: Probe,
  intervalMs: number,
  emit: (batch: MetricBatch, elapsedMs: number) => void,
  log: Logger,
): ProbeLoop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<void> => {
    if (stopped) return;
    const started = performance.now();
    try {
      const metrics = await probe.sample();
      emit({ probeId: probe.id, metrics }, performance.now() - started);
    } catch (err) {
      // 一个插件采样炸了，不许影响其他插件，更不许带崩内核（铁律③）
      log.error(
        `插件 ${probe.id} 采样失败（已隔离，其余插件继续）`,
        err instanceof Error ? err.message : err,
      );
    }
    if (!stopped) timer = setTimeout(() => void run(), intervalMs);
  };

  timer = setTimeout(() => void run(), 0);   // 首采立即
  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
