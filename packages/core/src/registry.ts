/**
 * @zhizhi/core · registry
 *
 * 插件注册表 —— 内核 7 样之一（绝不外放）。
 *
 * 它是**插件状况的唯一账本**：起来的、缺失的、不合规的、加载时炸的，
 * 全部登记在这里。谁想知道插件全貌都只问它一处 —— 不用去翻散落各处的报告。
 *
 * ⚠️ 为什么「加载动作」不写在这个文件里？
 *     Node 的模块解析基于**文件的物理位置**。实测：
 *     从 core 的位置 `import('@zhizhi/probe-cpu')` 会直接 `ERR_MODULE_NOT_FOUND`
 *     （core 的 package.json 不依赖它，也就看不到它的 node_modules）。
 *     所以真正执行 `import()` 的地方**必须**在入口进程（cli / 未来的 app）。
 *     内核在这里负责的是**账本与状态机**，不是「搬模块」。
 *
 * ⚠️ 为什么这个类不打日志？
 *     「插件缺失」这话该怎么说才让人看懂，是入口的表述责任（措辞、语气都得看语境）。
 *     内核只管如实记账，日志全部由 loader 出。
 */

import type {
  Channel,
  LoadOutcome,
  Persona,
  PluginFailureKind,
  PluginType,
  Probe,
  Rule,
} from './types.ts';

export class Registry {
  readonly #probes = new Map<string, Probe>();
  readonly #rules = new Map<string, Rule>();
  readonly #personas = new Map<string, Persona>();
  readonly #channels = new Map<string, Channel>();
  readonly #outcomes: LoadOutcome[] = [];

  /** 登记一个已经加载就绪的 probe */
  adoptProbe(id: string, probe: Probe): LoadOutcome {
    this.#probes.set(id, probe);
    const outcome: LoadOutcome = { id, type: 'probe', status: 'active' };
    this.#outcomes.push(outcome);
    return outcome;
  }

  /** 登记一个已经加载就绪的 rule（判断规则） */
  adoptRule(id: string, rule: Rule): LoadOutcome {
    this.#rules.set(id, rule);
    const outcome: LoadOutcome = { id, type: 'rule', status: 'active' };
    this.#outcomes.push(outcome);
    return outcome;
  }

  /**
   * 登记一个已经加载就绪的 persona（台词包）。
   *
   * 📌 **可以有 0 个** —— 台词包是「默认值」不是「必需品」：
   *    一个都不在时，内核用事件的客观描述兜底说话（见 core/voice.ts）。
   *    所以这里**不是** must-have，缺失时只记账、不报错。
   */
  adoptPersona(id: string, persona: Persona): LoadOutcome {
    this.#personas.set(id, persona);
    const outcome: LoadOutcome = { id, type: 'persona', status: 'active' };
    this.#outcomes.push(outcome);
    return outcome;
  }

  /** 登记一个已经加载就绪的 channel（通道） */
  adoptChannel(id: string, channel: Channel): LoadOutcome {
    this.#channels.set(id, channel);
    const outcome: LoadOutcome = { id, type: 'channel', status: 'active' };
    this.#outcomes.push(outcome);
    return outcome;
  }

  /**
   * 登记一个**没起来**的插件 —— 如实记下是哪一类原因，绝不静默吞掉。
   *
   * 为什么这里要显式传 type：插件既然没起来，就没法自报身份，
   * 只能相信清单里声明的期望类型（见 `PluginSpec`）。
   */
  reject(id: string, type: PluginType, kind: PluginFailureKind, reason: string): LoadOutcome {
    const outcome: LoadOutcome = {
      id,
      type,
      status: 'failed',
      failureKind: kind,
      error: reason,
    };
    this.#outcomes.push(outcome);
    return outcome;
  }

  probe(id: string): Probe | undefined {
    return this.#probes.get(id);
  }

  probes(): readonly Probe[] {
    return [...this.#probes.values()];
  }

  probeIds(): string[] {
    return [...this.#probes.keys()];
  }

  rules(): readonly Rule[] {
    return [...this.#rules.values()];
  }

  ruleIds(): string[] {
    return [...this.#rules.keys()];
  }

  channels(): readonly Channel[] {
    return [...this.#channels.values()];
  }

  channelIds(): string[] {
    return [...this.#channels.keys()];
  }

  /** 在岗的台词包（可能为空 —— 空 loadout 必须能降级，不是故障） */
  personas(): readonly Persona[] {
    return [...this.#personas.values()];
  }

  personaIds(): string[] {
    return [...this.#personas.keys()];
  }

  /** 这个 id 是否已被任何类型的插件占用（加载器用来查重名冲突） */
  hasPlugin(id: string): boolean {
    return (
      this.#probes.has(id) ||
      this.#rules.has(id) ||
      this.#personas.has(id) ||
      this.#channels.has(id)
    );
  }

  /** 账本全貌（含没起来的那些） */
  outcomes(): readonly LoadOutcome[] {
    return this.#outcomes;
  }

  /** 没起来的那些 */
  failures(): readonly LoadOutcome[] {
    return this.#outcomes.filter((o) => o.status === 'failed');
  }

  /** 在岗插件的全部 id（四类合并）—— 上线报告用 */
  activeIds(): string[] {
    return [
      ...this.#probes.keys(),
      ...this.#rules.keys(),
      ...this.#personas.keys(),
      ...this.#channels.keys(),
    ];
  }

  /** 在岗插件总数（probe + rule + persona + channel 相加） */
  get activeCount(): number {
    return this.#probes.size + this.#rules.size + this.#personas.size + this.#channels.size;
  }
}
