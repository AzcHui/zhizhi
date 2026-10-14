/**
 * 只只 · cli —— 内核的独立入口（M0 起就是验收入口）
 *
 * 为什么需要它：内核「零 UI 依赖」不是口号 —— 这个文件就是证据。
 * 它今天独立跑在终端里，M4 之后会被 app 作为 sidecar 启动，内核代码一行不改。
 *
 * 两条通道约定（很重要）：
 *   stdout → **数据**（一行指标 JSON），给外壳 / 管道消费
 *   stderr → **日志**，给人看
 *
 * 用法：
 *   pnpm --filter cli start                 # 常驻，每 5 秒一行 JSON
 *   pnpm --filter cli once                  # 只跑几轮就退出（自动化验收用）
 *   node src/main.ts --interval=1000 --ticks=5 --verbose
 *
 * M1 起，插件不再写死在这个文件里 —— 见 `plugins.ts`（清单）与 `loader.ts`（加载器）。
 */

import {
  Bus,
  Dispatcher,
  Registry,
  Scheduler,
  Store,
  createLogger,
  createPassThroughGates,
  setLogLevel,
} from '@zhizhi/core';
import type { Metric, MetricBatch } from '@zhizhi/core';

import { loadPlugins } from './loader.ts';
import { PLUGINS } from './plugins.ts';

// ─────────────────────────────── 参数 ───────────────────────────────

const argv = process.argv.slice(2);

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

const intervalMs = Number(option('interval') ?? 5000);
const ticksOption = option('ticks');
const maxTicks = ticksOption === undefined ? Number.POSITIVE_INFINITY : Number(ticksOption);

if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  console.error(`--interval 必须是一个正数，收到 "${String(option('interval'))}"`);
  process.exit(2);
}

if (argv.includes('--verbose')) setLogLevel('debug');

const log = createLogger('cli');

// ─────────────────────────── 内核 5 样先立起来 ───────────────────────────
// （gates / dispatcher 的契约已在 core 定义，M2 才真正接入判断逻辑）

const bus = new Bus(log.child('bus'));
const store = new Store();
const gates = createPassThroughGates();
const dispatcher = new Dispatcher(log.child('dispatcher'));
const registry = new Registry();

// ────────────────────── 加载插件：清单驱动 + 如实记账 ──────────────────────
// 加载动作在这里（而不是 core）执行 —— 原因见 loader.ts 顶部注释（Node 的解析基准是物理位置）

log.debug(
  `清单共 ${PLUGINS.length} 条：${PLUGINS.map((s) => s.specifier).join(', ')}`,
);
const outcomes = await loadPlugins(PLUGINS, registry, log.child('loader'));
const errors = outcomes.filter((o) => o.status === 'failed');

// ─────────────────── 事件总线：让指标经总线流动，而不是各拿各的 ───────────────────
// 此刻的订阅者只有下面这个汇总器；M2 的 rule 插件会挂到**同一个** 'metric' 上，
// 到时这一行不用改 —— 这就是「插件之间只走总线」的雏形。

let tickBatches: MetricBatch[] = [];
bus.on<MetricBatch>('metric', (batch) => {
  tickBatches.push(batch);
});

// ─────────────────────────────── 采样编排 ───────────────────────────────
// 编排逻辑仍留在 cli：它是「内核进程的入口」，M4 的 app 连的是这个进程而不是重跑一份。

async function sampleAll(): Promise<Record<string, readonly Metric[]>> {
  tickBatches = [];

  for (const probe of registry.probes()) {
    try {
      const metrics = await probe.sample();
      // 广播出去 —— 谁想用谁自己订阅（铁律①：插件之间只能走总线）
      bus.emit<MetricBatch>('metric', { probeId: probe.id, metrics });
    } catch (err) {
      // 一个插件采样炸了，不许影响其他插件，更不许带崩内核
      log.error(
        `插件 ${probe.id} 采样失败（已隔离，其余插件继续）`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return Object.fromEntries(tickBatches.map((b) => [b.probeId, b.metrics]));
}

// ─────────────────────────────── 主循环 ───────────────────────────────

let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.stop();
  log.info('只只下班了。');
  // 只设 exitCode 不强制 exit —— 让 stdout 先把最后一行数据冲干净
  process.exitCode = code;
}

const scheduler = new Scheduler(
  intervalMs,
  async (tick, now): Promise<void> => {
    const started = performance.now();
    const probes = await sampleAll();
    const elapsedMs = Number((performance.now() - started).toFixed(1));

    const report = {
      tick,
      ts: new Date(now).toISOString(),
      elapsedMs,
      probes,
    };

    // ⭐ stdout 只有数据，没有别的 —— M0 的验收标准，M1 继续守
    process.stdout.write(`${JSON.stringify(report)}\n`);

    if (tick >= maxTicks) shutdown(0);
  },
  log.child('scheduler'),
);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ─────────────────────────────── 上线报告 ───────────────────────────────

log.info(`只只已上线 —— 每 ${intervalMs} ms 采一次`);
log.info(
  `插件在岗 ${registry.activeCount} / ${PLUGINS.length}：${registry.probeIds().join(', ') || '（无）'}`,
);
if (errors.length > 0) {
  log.warn(`有 ${errors.length} 个插件没起来（明细见上方 loader 日志），内核照常运行`);
}
if (registry.activeCount === 0) {
  log.warn('一个插件都没起来 —— 只只会照常运行，但不会采集任何指标。');
}
log.info(
  `内核备件：bus=${bus.topics().length} topic · store=${store.size} 项 · ` +
    `gates=${gates.length} 道 · channels=${dispatcher.channelIds().length} 个`,
);
if (Number.isFinite(maxTicks)) log.info(`验收模式：跑满 ${maxTicks} 轮就退出。`);

scheduler.start();
