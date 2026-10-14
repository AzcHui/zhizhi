/**
 * 只只 · cli —— 内核的独立入口（M0 的验收入口）
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
import type { Metric } from '@zhizhi/core';

// 插件：S1「契约先行」= 静态 import（动态加载 S3 才做，等真有第三方需求）
import probeCpu from '@zhizhi/probe-cpu';
import probeDisk from '@zhizhi/probe-disk';
import probeMem from '@zhizhi/probe-mem';

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
const registry = new Registry(log.child('registry'));

// 注意：官方插件也走 registry 这同一条加载路径 —— 铁律②，没有后门
registry.registerProbe('probe-cpu', () => probeCpu);
registry.registerProbe('probe-mem', () => probeMem);
registry.registerProbe('probe-disk', () => probeDisk);

// 失败的插件如实报出来，不静默吞掉 —— M1 的验收点（删掉 probe-cpu 也得能跑）
for (const outcome of registry.failed()) {
  log.warn(`插件 ${outcome.id} 未加载：${outcome.error ?? '未知原因'}`);
}

// ─────────────────────────────── 采样编排 ───────────────────────────────
// 这块编排 M0 先放在 cli（此时只有 cli 一个消费者）；
// 等 M1/M4 出现第二个消费者时，再下沉到 core，届时 app 直接复用。

async function sampleAll(): Promise<Record<string, readonly Metric[]>> {
  const byProbe: Record<string, readonly Metric[]> = {};

  for (const probe of registry.probes()) {
    try {
      byProbe[probe.id] = await probe.sample();
    } catch (err) {
      // 一个插件采样炸了，不许影响其他插件，更不许带崩内核
      byProbe[probe.id] = [];
      log.error(
        `插件 ${probe.id} 采样失败（已隔离，其余插件继续）`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return byProbe;
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

    // ⭐ stdout 只有数据，没有别的 —— 这一行就是 M0 的验收标准
    process.stdout.write(`${JSON.stringify(report)}\n`);

    if (tick >= maxTicks) shutdown(0);
  },
  log.child('scheduler'),
);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

log.info(
  `只只已上线 —— 每 ${intervalMs} ms 采一次 · 插件 ${registry.activeCount} 个（${registry.probeIds().join(', ')}）`,
);
log.info(
  `内核备件：bus=${bus.topics().length} topic · store=${store.size} 项 · ` +
    `gates=${gates.length} 道 · channels=${dispatcher.channelIds().length} 个`,
);
if (Number.isFinite(maxTicks)) log.info(`验收模式：跑满 ${maxTicks} 轮就退出。`);

scheduler.start();
