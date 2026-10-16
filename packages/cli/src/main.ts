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

import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Bus,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_SUSTAIN_MS,
  Dispatcher,
  Memory,
  Registry,
  Scheduler,
  Store,
  composeLine,
  createGates,
  createLogger,
  runGates,
  setLogLevel,
} from '@zhizhi/core';
import type { ContextInput, Metric, MetricBatch, ZhizhiEvent } from '@zhizhi/core';
import { definePersonaFromJson } from '@zhizhi/plugin-sdk';

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

// ── M6 · 数据目录与闲聊参数 ──
// 数据目录（决策 #21）：user.json / learned.json / zhizhi.settings.json 这些**用户数据**
// 都住这里 —— 绝不放插件包（随代码走 = git 冲突 / 重装即丢 / 污染只读区）。
// ⚠️ 路径走配置项、不硬编码：默认按 cli 模块位置推到仓库根的 data/（与 cwd 无关，
//    pnpm start 和浮窗拉起两种跑法落在同一处）；M4-b 打包后只改这个默认值指向 %LOCALAPPDATA%。
const dataDirOption = option('data-dir');
const dataDir =
  dataDirOption === undefined
    ? fileURLToPath(new URL('../../../data/', import.meta.url))
    : isAbsolute(dataDirOption)
      ? `${dataDirOption.replace(/[\\/]+$/, '')}/`
      : resolve(process.cwd(), dataDirOption);

// 固定空闲时长（**验收 / 调试用**）：省去「真得闲 10 分钟」才能验闲聊。
// 正常运行不要传它 —— 空闲时长该由外壳经 stdin 实时喂。
const idleOverrideOption = option('idle-ms');
const idleOverride =
  idleOverrideOption === undefined ? undefined : Number(idleOverrideOption);
if (idleOverride !== undefined && (!Number.isFinite(idleOverride) || idleOverride < 0)) {
  console.error(`--idle-ms 必须是一个非负数，收到 "${String(idleOverrideOption)}"`);
  process.exit(2);
}

if (argv.includes('--verbose')) setLogLevel('debug');

const log = createLogger('cli');

// 数据目录建好（用户要往里放 user.json / 改 settings）；建不出来不拦内核，只告警
try {
  mkdirSync(dataDir, { recursive: true });
} catch (err) {
  log.warn(
    `数据目录建不了：${dataDir} —— 用户台词池与设置文件将不可用（内核照常运行）`,
    err instanceof Error ? err.message : err,
  );
}

/**
 * 读数据目录里的设置文件（`zhizhi.settings.json`）。
 *
 * 三条纪律（与「宁可不传也不传错」一致）：
 *   文件不在   → 全用默认（第一次跑的正常状态，不是错）
 *   JSON 坏了  → 整份不用，告警（不猜半个配置）
 *   单键类型不对 → 只丢那个键，告警（其余照用）
 */
function loadSettings(): Record<string, unknown> {
  const path = resolve(dataDir, 'zhizhi.settings.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!missing) {
      log.warn(`设置文件读不动：${path} —— 整份忽略，全用默认。`, err instanceof Error ? err.message : err);
    }
    return {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn(`设置文件不合规：${path} —— 顶层必须是 JSON 对象。整份忽略，全用默认。`);
    return {};
  }
  // 字符串枚举键（M6-b：话量档）—— 只收白名单里的值，别的当没写（不猜）
  const STRING_ENUM_KEYS: Record<string, readonly string[]> = {
    chitchatVolume: ['low', 'normal', 'high'],
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const allowed = STRING_ENUM_KEYS[key];
    if (allowed !== undefined) {
      if (typeof value === 'string' && allowed.includes(value)) {
        out[key] = value;
      } else {
        log.warn(
          `设置文件里 "${key}" 必须是 ${allowed.join(' / ')} 之一（收到 ${JSON.stringify(value) ?? 'undefined'}），忽略该键`,
        );
      }
      continue;
    }
    const ok =
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? true
        : typeof value === 'boolean';
    if (!ok) {
      log.warn(`设置文件里 "${key}" 不是非负数或布尔（收到 ${JSON.stringify(value) ?? 'undefined'}），忽略该键`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

const settings = loadSettings();

// ── M6-b：旧旋钮下线 ──
// 「间隔旋钮的存在本身就是失败信号」（决策 #18 改写）—— 检测到旧键就明说，
// 然后拦下不发给规则：节奏由只只按亲密度自管，双保险不因 settings 被绕开。
for (const legacy of ['chitchatIntervalMs', 'chitchatIdleMs'] as const) {
  if (legacy in settings) {
    log.warn(
      `设置 "${legacy}" 已下线（M6-b：发言间隔与空闲门槛由只只按亲密度自管）—— 该键被忽略。` +
        `现在手上只有 chitchatEnabled（开/关）与 chitchatVolume（low/normal/high）`,
    );
    delete settings[legacy];
  }
}

// ── M7 · 记忆 + 亲密度 ──
// 说出口的话进 events.jsonl（重启后「说过没说过」「第几次」还在）；
// trust.json 记亲密度（0~100）。文件坏 / 写不进 → 记忆退化、内核照常（Memory 自己兜）。
const memory = new Memory({ dir: dataDir, log: log.child('memory') });

/**
 * 把数据目录里的一份台词池（`user.json` / `learned.json`）登记进账本。
 *
 * 它们与 manifest 台词包同一种 JSON 形状（`{ id?, lines }`），但**不是插件**：
 *   · 文件不在 = 正常状态（第一次跑本来就没有）→ debug 记一笔就走，不告警
 *   · 坏了 / 与已有插件重名 → 告警 + 跳过（绝不静默顶掉别人的账）
 * 入账顺序由调用方控制 —— registry 按入账顺序说话，这正是三层优先级的实现：
 *   **user（最先）→ manifest 台词包 → learned（最后）**（决策 #20）
 */
function adoptDataPool(filename: string, fallbackId: string): void {
  const path = resolve(dataDir, filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (missing) {
      log.debug(`用户台词池 ${filename} 不存在（正常，不是错）—— 跳过`);
    } else {
      log.warn(`用户台词池读不动：${path} —— 跳过（内核照常运行）`, err instanceof Error ? err.message : err);
    }
    return;
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj['id'] !== 'string' || obj['id'].trim() === '') obj['id'] = fallbackId;
  }
  try {
    const persona = definePersonaFromJson(raw, path);
    if (registry.hasPlugin(persona.id)) {
      log.warn(`用户台词池 ${filename} 的 id（${persona.id}）与已有插件重名 —— 跳过（不覆盖别人的账）`);
      return;
    }
    registry.adoptPersona(persona.id, persona);
    log.info(`用户台词池已激活：${persona.id}（${path}）`);
  } catch (err) {
    log.warn(`用户台词池不合规：${path} —— 跳过。`, err instanceof Error ? err.message : err);
  }
}

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
// 台词池三层（决策 #20）的第 1 层先入账：user.json（你手写的，优先级最高）
adoptDataPool('user.json', 'persona-user');
const outcomes = await loadPlugins(PLUGINS, registry, log.child('loader'));
// 第 3 层最后入账：learned.json（模型补的，可删改 —— 它就是反馈的载体）
adoptDataPool('learned.json', 'persona-learned');
const errors = outcomes.filter((o) => o.status === 'failed');

// 配置下发（M6）：数据目录设置文件 → 实现了 configure() 的规则各认领各的键。
// 一次启动只发一次；单个规则接配置时抛错被隔离，不影响其余规则。
for (const rule of registry.rules()) {
  if (typeof rule.configure !== 'function') continue;
  try {
    rule.configure(settings);
  } catch (err) {
    log.error(
      `规则 ${rule.id} 接收配置时抛错（已隔离，用自身默认值继续）`,
      err instanceof Error ? err.message : err,
    );
  }
}

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

// 台词包从**账本**里取（见下方 composeLine 调用处）—— 与 probe / rule / channel 走同一条加载路径。
// ⚠️ M5 硬约束：这里**不许** import 任何写死的内置台词包，否则「可整体替换」就是假的。
//   一个台词包都没有时，composeLine 会自动降级成事件的客观描述（不崩、不哑）。
let tickBatches: MetricBatch[] = [];
const passedEvents: ZhizhiEvent[] = [];

/** 把一个 batch 交给全部规则去「发现」；单条规则抛错被隔离，其余继续 */
function dispatchToRules(batch: MetricBatch): void {
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
}

bus.on<MetricBatch>('metric', (batch) => {
  // ① 汇总起来，给本 tick 的 stdout 报告用
  tickBatches.push(batch);

  // ② 交给规则去「发现」
  dispatchToRules(batch);
});

bus.on<ZhizhiEvent>('event.candidate', (event) => {
  // 决策 #22：闸门是**告警**的分寸系统 —— chitchat 没有指标证据（threshold 会拦「空口报」）、
  // 天然只冒一次（sustained 会拦）→ **绕闸门**；但 **dispatcher 不能绕**：
  // 它是唯一出口，静默时段 / 每日上限这些宪法级机制都在出口那一侧管着闲聊。
  if (event.kind !== 'chitchat') {
    const verdict = runGates(gates, event, { now: Date.now(), passed: passedEvents });

    if (!verdict.pass) {
      // 「我知道，但我选择不说。」—— 下面这行 debug 就是只只的分寸所在
      log.debug(`闸门「${verdict.blockedBy}」压下了 ${event.type}：${verdict.reason ?? ''}`);
      return;
    }
  } else if (memory.trust < 10 && !event.id.startsWith('say@')) {
    // M7 亲密度档位「沉默」（0~9）：只报警（功能性），几乎不说话 —— 原设计表的行为。
    // ⚠️ 只压**自动闲聊**，两样永不受影响：告警（功能性，沉默机制说了算，宪法不变）、
    //    用户点名的 `say@`（明确指令 —— 而且它是 low-trust 状态唯一的回暖入口，
    //    把它也压掉 = 死锁，trust 永远救不回来）。
    log.debug(`亲密度 ${memory.trust}（沉默档）：压下自动闲聊 —— 它现在不想自己找话`);
    return;
  }

  passedEvents.push(event);
  if (passedEvents.length > 200) passedEvents.shift();

  // 记忆进挑句：说过没说过跨重启算数 + {count}（第几次）可入台词
  const line = composeLine(event, registry.personas(), log.child('voice'), memory.voice);
  bus.emit<ZhizhiEvent>('event.passed', event);

  void dispatcher
    .dispatch({ eventId: event.id, text: line.text, severity: event.severity })
    .then((sent) => {
      if (sent) {
        log.info(`只只说了［${event.severity}］：${line.text}`);
        // ⭐ 说出去了才算「说过」（压在闸门里的不算）—— 记模板 key，不记填完的文本
        memory.recordSpoken(event, line.key ?? line.text, line.text);
      }
    });
});

// ─────────────────── 反向通道（M6）：外壳经 stdin 喂上下文 ───────────────────
//
// 协议：一行一个 JSON 对象，目前只认 `{"idleMs": <非负数>}`。
// 没有外壳喂 = 没有上下文 → 闲聊自动静默（不崩、不报错，监控照常 —— 硬约束 ③）。
// ⚠️ 不是键鼠监听：idleMs 只是「最后一次输入距今多少毫秒」这一个数字。

let context: ContextInput = idleOverride === undefined ? {} : { idleMs: idleOverride };

function deliverContext(ctx: ContextInput): void {
  // M6-b：内核把亲密度一并注入（规则按信任档位自管节奏）—— 外壳不用喂它，也不会喂错
  const full: ContextInput = { trust: memory.trust, ...ctx };
  for (const rule of registry.rules()) {
    if (typeof rule.onContext !== 'function') continue;
    try {
      rule.onContext(full);
    } catch (err) {
      log.error(
        `规则 ${rule.id} 处理上下文时抛错（已隔离）`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdinBuf += chunk;
  let idx = stdinBuf.indexOf('\n');
  while (idx >= 0) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (line !== '') {
      try {
        const obj = JSON.parse(line) as Record<string, unknown> | null;
        const idle = obj === null || typeof obj !== 'object' ? undefined : obj['idleMs'];
        const say = obj === null || typeof obj !== 'object' ? undefined : obj['requestSay'];
        const idleOk = typeof idle === 'number' && Number.isFinite(idle) && idle >= 0;
        if (idleOk) {
          context = { idleMs: idle as number };
          deliverContext(context);
        }
        if (say === true) {
          // 用户点了「说说」—— 把请求连同最新上下文一起递给规则（规则决定怎么开口）。
          // M7：这是「和它对话」—— 亲密度 +2（原设计表唯一不需要反馈 UI 的加分项）
          memory.recordInteraction();
          deliverContext({ ...context, requestSay: true });
        }
        if (!idleOk && say !== true) {
          log.warn(`上下文行缺有效的 "idleMs"/"requestSay"，已忽略：${line.slice(0, 80)}`);
        }
      } catch {
        log.warn(`上下文行不是合法 JSON，已忽略：${line.slice(0, 80)}`);
      }
    }
    idx = stdinBuf.indexOf('\n');
  }
});
process.stdin.on('error', (err) => {
  log.warn('stdin 读取出错（外壳的上下文喂不进来了，闲聊将静默；监控照常）', err.message);
});
// ⚠️ 不让 stdin 拖住退出：验收模式（--ticks）跑满后进程要能干净退场。
// 但 unref 只有 TTY / 管道型 stdin（Socket）才有 —— **重定向文件**时是 fs.ReadStream，
// 没有 unref，直接调会 TypeError 启动即崩（监工复验抓到）→ 先探再调。
if (typeof (process.stdin as { unref?: unknown }).unref === 'function') {
  process.stdin.unref();
}
// 把初始上下文（含 --idle-ms 的固定值）也发一遍 —— 别让规则等到第一行 stdin 才见到它
deliverContext(context);

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

    // 决策 #24-⑥ 的**最小解耦**：一个 probe 都没有（没装 / 全挂）也要给规则一次心跳 ——
    // 闲聊是**时间驱动**的，不需要任何指标；「只想让它陪聊、不想监控」正是关 probe 最自然的
    // 动机，闲聊不该陪葬。空 batch 对 rule-threshold 无害（没有指标就无命中）。
    // （完整的「事件评估与采集解耦」——按 probe 独立调度等 —— 仍归 M8-a。）
    if (tickBatches.length === 0) {
      dispatchToRules({ probeId: '(no-probe)', metrics: [] });
    }

    const elapsedMs = Number((performance.now() - started).toFixed(1));

    // M7：每天不互动 -2 —— 跨天后的第一个 tick 结账（没互动的日子这里就是唯一的触碰点）
    memory.decayIfNewDay();

    const report = {
      tick,
      ts: new Date(now).toISOString(),
      elapsedMs,
      probes,
      trust: memory.trust, // M7：外壳据此在状态区显示亲密度档位
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
log.info(`数据目录：${dataDir}（user.json / learned.json / zhizhi.settings.json 住这里；--data-dir 可改）`);
// M7：记忆与亲密度 —— 「0 条」是第一次跑的正常状态，得说清不是故障
log.info(
  memory.spokenTotal > 0
    ? `记忆：${memory.spokenTotal} 句说过的话在案（events.jsonl）—— 挑句跨重启不重复、{count} 可用`
    : '记忆：空的（第一次跑，正常）—— 说出口的话会记到 memory/events.jsonl',
);
log.info(`亲密度：trust=${memory.trust}（${memory.tier}档）—— 点「说说」+2 / 每天不互动 -2；只影响闲聊，告警不受影响`);
// 闲聊旋钮（M6-b 极简化）：用户手上只有 开/关 ＋ 话量档 —— 间隔与空闲门槛由只只自管
const chitchatEnabled = settings['chitchatEnabled'] !== false; // 不写 = 开
const chitchatVolume =
  typeof settings['chitchatVolume'] === 'string' ? String(settings['chitchatVolume']) : 'normal';
const volumeWord: Record<string, string> = { low: '少', normal: '正常', high: '多' };
log.info(
  chitchatEnabled
    ? `闲聊：开（话量档 ${volumeWord[chitchatVolume] ?? chitchatVolume}）—— ` +
        `间隔与空闲门槛由只只按亲密度自管（熟悉档约 25~60 分钟一句，档内随机）`
    : '闲聊：关 —— 一句闲聊都不说（含点名）；告警照常（它管不着告警）',
);
log.info('闲聊双保险（宪法，不暴露也不可设 0）：最短 10 分钟一句 · 每日自动闲聊 ≤ 24 句');
const modelEnabled = settings['modelEnabled'] === true;
log.info(
  modelEnabled
    ? '模型层：设置里开了，但 M6 加餐还没实现 —— 现在先当没开（纯池子照常说话）'
    : '模型层：关（M6 加餐；预生成挂载位已留 —— 说话永不等模型）',
);
log.info(
  idleOverride === undefined
    ? '上下文输入：等外壳经 stdin 喂 {"idleMs":N} —— 没有外壳 = 闲聊自动静默（不是故障）'
    : `上下文输入：固定 idleMs=${idleOverride}（验收/调试用；正常该由外壳实时喂）`,
);
// 台词包单独说一句 —— 「0 个」是**正常降级**，不是故障，得让日志把它说清楚
const personaIds = registry.personaIds();
log.info(
  personaIds.length > 0
    ? `台词包：${personaIds.join(', ')}（挑台词）`
    : '台词包：0 个 —— 只只会用事件的客观描述说话（降级，不是故障）',
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
  `闸门参数：sustain=${sustainMs}ms（持续判定）· cooldown=${cooldownMs}ms（冷却期）· baseline=占位（M8-a 填：需指标样本历史）`,
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
