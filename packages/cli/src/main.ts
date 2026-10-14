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
  DEFAULT_COOLDOWN_MS,
  DEFAULT_SUSTAIN_MS,
  Dispatcher,
  Registry,
  Scheduler,
  Store,
  composeLine,
  createGates,
  createLogger,
  runGates,
  setLogLevel,
} from '@zhizhi/core';
import type { Metric, MetricBatch, Persona, ZhizhiEvent } from '@zhizhi/core';

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

// 沉默机制的两个窗口。默认 2 分钟 / 15 分钟；验收和调试时要能调短，
// 所以做成参数（S2 阶段这两个值会外置到 JSON，用户不碰代码就能改）
const sustainMs = Number(option('sustain-ms') ?? DEFAULT_SUSTAIN_MS);
const cooldownMs = Number(option('cooldown-ms') ?? DEFAULT_COOLDOWN_MS);

if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  console.error(`--interval 必须是一个正数，收到 "${String(option('interval'))}"`);
  process.exit(2);
}

for (const [name, value] of [
  ['sustain-ms', sustainMs],
  ['cooldown-ms', cooldownMs],
] as const) {
  if (!Number.isFinite(value) || value < 0) {
    console.error(`--${name} 必须是一个非负数，收到 "${String(option(name))}"`);
    process.exit(2);
  }
}

if (argv.includes('--verbose')) setLogLevel('debug');

const log = createLogger('cli');

// ─────────────────────────── 内核 5 样立起来 ───────────────────────────

const bus = new Bus(log.child('bus'));
const store = new Store();
const dispatcher = new Dispatcher(log.child('dispatcher'));
const registry = new Registry();

// 四道闸门（内核宪法）：持续判定与冷却期的状态全记在 store 里，插件读不到也绕不过。
// ⚠️ 必须把 intervalMs 交给它 —— 持续判定靠「两次见到相隔多久」推断「中间恢复没有」，
//    不知道采样节奏就分辨不出「还在超标」和「早就恢复了」（会误报）。
const gates = createGates({ store, intervalMs, sustainMs, cooldownMs });

// ────────────────────── 加载插件：清单驱动 + 如实记账 ──────────────────────
// 加载动作在这里（而不是 core）执行 —— 原因见 loader.ts 顶部注释（Node 的解析基准是物理位置）

log.debug(
  `清单共 ${PLUGINS.length} 条：${PLUGINS.map((s) => s.specifier).join(', ')}`,
);
const outcomes = await loadPlugins(PLUGINS, registry, log.child('loader'));
const errors = outcomes.filter((o) => o.status === 'failed');

// 通道注册进 dispatcher —— 走哪个通道由 dispatcher 按 severity 裁决，插件自己选不了
for (const channel of registry.channels()) dispatcher.register(channel);

// ───────────────────────── 事件流水线（M2 的主干） ─────────────────────────
//
//   probe → bus('metric') → rule（负责「发现」）→ bus('event.candidate')
//         → 四道闸门（负责「分寸」）→ bus('event.passed') → 说话 → dispatcher → channel
//
// 两条说明：
//   ① rule 只负责发现，**能不能说出口由内核闸门决定** —— 插件不掌握分寸
//   ② 跨插件的每一次流转都走总线，没有一个插件 import 另一个（铁律①）

let tickBatches: MetricBatch[] = [];
const passedEvents: ZhizhiEvent[] = [];
// M5 才会有 persona 插件；在那之前 composeLine 会用事件自带的客观描述兜底
const personas: readonly Persona[] = [];

bus.on<MetricBatch>('metric', (batch) => {
  // ① 汇总起来，给本 tick 的 stdout 报告用
  tickBatches.push(batch);

  // ② 交给规则去「发现」
  for (const rule of registry.rules()) {
    let candidates: readonly ZhizhiEvent[];
    try {
      candidates = rule.evaluate(batch);
    } catch (err) {
      log.error(
        `规则 ${rule.id} 判定失败（已隔离，其余规则继续）`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    for (const event of candidates) bus.emit<ZhizhiEvent>('event.candidate', event);
  }
});

bus.on<ZhizhiEvent>('event.candidate', (event) => {
  const verdict = runGates(gates, event, { now: Date.now(), passed: passedEvents });

  if (!verdict.pass) {
    // 「我知道，但我选择不说。」—— 下面这行 debug 就是只只的分寸所在
    log.debug(`闸门「${verdict.blockedBy}」压下了 ${event.type}：${verdict.reason ?? ''}`);
    return;
  }

  passedEvents.push(event);
  if (passedEvents.length > 200) passedEvents.shift();

  const line = composeLine(event, personas, log.child('voice'));
  bus.emit<ZhizhiEvent>('event.passed', event);

  void dispatcher
    .dispatch({ eventId: event.id, text: line.text, severity: event.severity })
    .then((sent) => {
      if (sent) log.info(`只只说了［${event.severity}］：${line.text}`);
    });
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
  `插件在岗 ${registry.activeCount} / ${PLUGINS.length}：${registry.activeIds().join(', ') || '（无）'}`,
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
log.info(
  `闸门参数：sustain=${sustainMs}ms（持续判定）· cooldown=${cooldownMs}ms（冷却期）· baseline=占位（M7 填）`,
);
if (intervalMs >= sustainMs) {
  // 持续判定靠「两次见到它相隔多久」推断中间有没有恢复；
  // 采样比窗口还慢的话，两个样本之间的距离就足以判定「持续够久」，持续判定名存实亡。
  log.warn(
    `采样间隔（${intervalMs}ms）没有明显小于持续判定窗口（${sustainMs}ms）——` +
      `持续判定会失去意义。请把 --interval 调小，或把 --sustain-ms 调大。`,
  );
}
if (Number.isFinite(maxTicks)) log.info(`验收模式：跑满 ${maxTicks} 轮就退出。`);

scheduler.start();
