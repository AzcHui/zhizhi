/**
 * 插件加载器 —— 把清单里的「包名」变成内核里能用的 probe 实例。
 *
 * ⚠️ 为什么它住在 cli，而不在 core（虽然「插件加载器」是内核 7 样之一）？
 *     Node 的模块解析基于**文件的物理位置**。实测：从 core 的位置
 *     `import('@zhizhi/probe-cpu')` 会直接 ERR_MODULE_NOT_FOUND
 *     （core 的 package.json 不依赖它，看不到它的 node_modules）。
 *     所以**执行加载动作的地方必须在入口进程**。
 *     core 负责「账本与状态机」，这里负责「搬运 + 表述」，各司其职。
 *
 * 铁律③在这一层落地：**任何一步失败都被隔离并如实分类记账，绝不影响其他插件。**
 * 失败分三类，因为处置方式不同：
 *     missing → 没装 / 装不上          → 提示用户去装
 *     invalid → 装上了但 manifest 不合规 → 提示插件作者去改
 *     crashed → 装上了、合规，加载时炸了 → 提示插件作者去修
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { LoadOutcome, Logger, PluginFailureKind, PluginSpec, Registry } from '@zhizhi/core';
import { validateManifest } from '@zhizhi/plugin-sdk';
import type { PluginManifest, Probe } from '@zhizhi/plugin-sdk';

/** 插件模块对外的形状：默认导出一个 probe */
interface ProbeModule {
  default?: Probe;
}

/** 从错误里尽量抠出「错误码 + 原话」，让日志能自证 */
function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * 按包路径解析并读取 manifest.json。
 * 之所以走 `import.meta.resolve` 而不是拼路径：把「包在哪」交给 Node 自己回答，
 * 免得我们写死 node_modules 的布局（pnpm 的布局还带软链）。
 */
function readManifest(specifier: string): unknown {
  const url = import.meta.resolve(`${specifier}/manifest.json`);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

/** 加载清单里的全部插件；返回逐条的账本记录（顺序与清单一致） */
export async function loadPlugins(
  specs: readonly PluginSpec[],
  registry: Registry,
  log: Logger,
): Promise<readonly LoadOutcome[]> {
  const outcomes: LoadOutcome[] = [];
  for (const spec of specs) {
    outcomes.push(await loadOne(spec, registry, log));
  }
  return outcomes;
}

async function loadOne(spec: PluginSpec, registry: Registry, log: Logger): Promise<LoadOutcome> {
  const { specifier, type } = spec;

  // ── 第 1 步：读 manifest（顺带把「装没装」判掉）──
  let rawManifest: unknown;
  try {
    rawManifest = readManifest(specifier);
  } catch (err) {
    const reason = describe(err);
    const kind: PluginFailureKind =
      codeOf(err) === 'ERR_MODULE_NOT_FOUND' ? 'missing' : 'invalid';
    log.error(
      kind === 'missing'
        ? `插件缺失：${specifier} —— 清单里声明了它，但装不上。内核继续运行，跳过该插件。（${reason}）`
        : `插件 manifest 读不到或不合法：${specifier} —— ${reason}`,
    );
    return registry.rejectProbe(specifier, type, kind, reason);
  }

  // ── 第 2 步：校验 manifest 合规性（权限声明默认全禁，这里是唯一入口）──
  const issues = validateManifest(rawManifest);
  if (issues.length > 0) {
    const reason = issues.map((i) => `${i.field}: ${i.message}`).join('；');
    log.error(`插件不合规：${specifier} —— ${reason}`);
    return registry.rejectProbe(specifier, type, 'invalid', reason);
  }

  const manifest = rawManifest as PluginManifest;

  // ── 第 3 步：id 冲突检查（宁可拒绝，也不静默覆盖别人的账）──
  if (registry.probe(manifest.id) !== undefined) {
    const reason = `插件 id 冲突：${manifest.id} 已被注册，说明 ${specifier} 与它重名`;
    log.error(`插件不合规：${specifier} —— ${reason}`);
    return registry.rejectProbe(specifier, type, 'invalid', reason);
  }

  // ── 第 4 步：动态加载模块（模块顶层抛错也会在这里被拦住）──
  let mod: ProbeModule;
  try {
    mod = (await import(specifier)) as ProbeModule;
  } catch (err) {
    const reason = describe(err);
    log.error(`插件加载出错：${specifier} —— 已隔离，内核继续运行。（${reason}）`);
    return registry.rejectProbe(specifier, type, 'crashed', reason);
  }

  // ── 第 5 步：确认它真的是个 probe ──
  const probe = mod.default;
  if (probe === undefined || typeof probe.sample !== 'function') {
    const reason = '模块没有 default 导出，或它不是合法的 probe（缺少 sample()）';
    log.error(`插件不合规：${specifier} —— ${reason}`);
    return registry.rejectProbe(specifier, type, 'invalid', reason);
  }

  if (probe.id !== manifest.id) {
    log.warn(
      `插件 ${specifier} 的自报 id（${probe.id}）与 manifest（${manifest.id}）不一致，以 manifest 为准`,
    );
  }

  // ── 第 6 步：登记入账 ──
  log.info(`插件已激活：${manifest.id}（${manifest.name} v${manifest.version}）`);
  return registry.adoptProbe(manifest.id, probe);
}
