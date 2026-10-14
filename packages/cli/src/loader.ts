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
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Channel,
  LoadOutcome,
  Logger,
  Persona,
  PluginFailureKind,
  PluginSpec,
  PluginType,
  Probe,
  Registry,
  Rule,
} from '@zhizhi/core';
import { definePersonaFromJson, validateManifest } from '@zhizhi/plugin-sdk';
import type { PluginManifest } from '@zhizhi/plugin-sdk';

/** 插件模块对外的形状：默认导出该插件的实例 */
interface PluginModule {
  default?: unknown;
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

  // ── 特例：persona 可以直接给一个 `.json` 路径 ──
  // 这是「性格包 = 纯数据，不执行代码」那条决策的落点（文档第七节 / 决策 D）：
  // 别人分享一套性格 = 分享一个 JSON 文件，不需要写代码，也就没有安全风险。
  // ⚠️ 关键在于：**清单里写的是路径，不是一个写死的内置包名** ——
  //    内置台词包只是「清单里的一项默认值」，不是必需品。
  if (type === 'persona' && specifier.toLowerCase().endsWith('.json')) {
    return loadPersonaJson(specifier, registry, log);
  }

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
    return registry.reject(specifier, type, kind, reason);
  }

  // ── 第 2 步：校验 manifest 合规性（权限声明默认全禁，这里是唯一入口）──
  const issues = validateManifest(rawManifest);
  if (issues.length > 0) {
    const reason = issues.map((i) => `${i.field}: ${i.message}`).join('；');
    log.error(`插件不合规：${specifier} —— ${reason}`);
    return registry.reject(specifier, type, 'invalid', reason);
  }

  const manifest = rawManifest as PluginManifest;

  // ── 第 3 步：id 冲突检查（宁可拒绝，也不静默覆盖别人的账）──
  if (registry.hasPlugin(manifest.id)) {
    const reason = `插件 id 冲突：${manifest.id} 已被注册，说明 ${specifier} 与它重名`;
    log.error(`插件不合规：${specifier} —— ${reason}`);
    return registry.reject(specifier, type, 'invalid', reason);
  }

  // ── 第 4 步：动态加载模块（模块顶层抛错也会在这里被拦住）──
  let mod: PluginModule;
  try {
    mod = (await import(specifier)) as PluginModule;
  } catch (err) {
    const reason = describe(err);
    log.error(`插件加载出错：${specifier} —— 已隔离，内核继续运行。（${reason}）`);
    return registry.reject(specifier, type, 'crashed', reason);
  }

  // ── 第 5 步：确认它真的是清单声明的那种插件 ──
  const instance = mod.default as Record<string, unknown> | undefined;
  const mismatch = mismatchReason(manifest.type, instance);
  if (mismatch !== undefined) {
    log.error(`插件不合规：${specifier} —— ${mismatch}`);
    return registry.reject(specifier, type, 'invalid', mismatch);
  }

  const selfId = (instance as { id?: unknown })['id'];
  if (typeof selfId === 'string' && selfId !== manifest.id) {
    log.warn(
      `插件 ${specifier} 的自报 id（${selfId}）与 manifest（${manifest.id}）不一致，以 manifest 为准`,
    );
  }

  // ── 第 6 步：按声明的类型登记入账 ──
  log.info(`插件已激活：${manifest.id}（${manifest.name} v${manifest.version}，${manifest.type}）`);
  return adoptInstance(registry, manifest, instance as Record<string, unknown>);
}

/** 模块形状对不对 —— 返回 undefined 表示匹配，返回字符串说明哪里不对 */
function mismatchReason(
  type: PluginType,
  instance: Record<string, unknown> | undefined,
): string | undefined {
  if (instance === undefined || instance === null || typeof instance !== 'object') {
    return '模块没有 default 导出，或导出的不是对象';
  }
  switch (type) {
    case 'probe':
      return typeof instance['sample'] === 'function' ? undefined : 'probe 必须提供 sample()';
    case 'rule':
      return typeof instance['evaluate'] === 'function' ? undefined : 'rule 必须提供 evaluate()';
    case 'persona':
      return typeof instance['speak'] === 'function'
        ? undefined
        : 'persona 必须提供 speak()（用 definePersona / definePersonaFromJson 生成即可）';
    case 'channel':
      if (typeof instance['send'] !== 'function') return 'channel 必须提供 send()';
      if (!Array.isArray(instance['sends']) || instance['sends'].length === 0) {
        return 'channel 必须在 sends 里声明至少一个严重度';
      }
      return undefined;
    default:
      return `暂不支持 ${type} 类型的插件（action / view 留给后续里程碑）`;
  }
}

/** 按 manifest 声明的类型，把实例登记进对应的账本 */
function adoptInstance(
  registry: Registry,
  manifest: PluginManifest,
  instance: Record<string, unknown>,
): LoadOutcome {
  switch (manifest.type) {
    case 'probe':
      return registry.adoptProbe(manifest.id, instance as unknown as Probe);
    case 'rule':
      return registry.adoptRule(manifest.id, instance as unknown as Rule);
    case 'persona':
      return registry.adoptPersona(manifest.id, instance as unknown as Persona);
    case 'channel':
      return registry.adoptChannel(manifest.id, instance as unknown as Channel);
    default:
      // mismatchReason 已经拦过不支持的类型，这里纯属兜底
      return registry.reject(manifest.id, manifest.type, 'invalid', `${manifest.type} 类型尚未支持`);
  }
}

/**
 * 加载一个**纯数据**台词包：清单里给的是 JSON 路径，不是包名。
 *
 * 相对路径按**当前工作目录**解析（写绝对路径更稳，推荐）。
 * 失败同样分三类，措辞与插件一致 —— 而且这里**绝不因为台词包不在就报错退出**：
 * 台词包是「默认值」不是「必需品」，读不到就用客观描述说话（见 core/voice.ts）。
 */
function loadPersonaJson(specifier: string, registry: Registry, log: Logger): LoadOutcome {
  const path = isAbsolute(specifier) ? specifier : resolve(process.cwd(), specifier);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const reason = describe(err);
    const missing = codeOf(err) === 'ENOENT';
    log.error(
      missing
        ? `台词包读不到：${path} —— 清单里指向了它，但文件不在。内核继续运行，改用客观描述说话。`
        : `台词包读不动：${path} —— ${reason}`,
    );
    return registry.reject(specifier, 'persona', missing ? 'missing' : 'invalid', reason);
  }

  try {
    const persona = definePersonaFromJson(raw, path);
    log.info(`台词包已激活：${persona.id}（纯数据 JSON：${path}）`);
    return registry.adoptPersona(persona.id, persona);
  } catch (err) {
    const reason = describe(err);
    log.error(`台词包不合规：${path} —— ${reason}`);
    return registry.reject(specifier, 'persona', 'invalid', reason);
  }
}
