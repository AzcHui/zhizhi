/**
 * @zhizhi/plugin-sdk · define-channel
 *
 * 通道插件的定义入口：把一句话送去哪儿。
 *
 * ⚠️ `sends` 必须如实声明 —— 分通道原则（提醒强 / 互动弱，永不混用）
 * 由内核的 dispatcher 按这个字段裁决，插件不许自己越级。
 */

import type { Channel, OutgoingMessage, Severity } from '@zhizhi/core';

export interface ChannelDefinition {
  readonly id: string;
  /** 它愿意承载哪些严重度 */
  readonly sends: readonly Severity[];
  readonly send: (msg: OutgoingMessage) => void | Promise<void>;
}

export function defineChannel(definition: ChannelDefinition): Channel {
  if (!definition.id) {
    throw new Error('defineChannel: 缺少 id');
  }
  if (typeof definition.send !== 'function') {
    throw new Error(`defineChannel("${definition.id}"): 缺少 send() 方法`);
  }
  if (!Array.isArray(definition.sends) || definition.sends.length === 0) {
    throw new Error(`defineChannel("${definition.id}"): 必须声明 sends（至少一个严重度）`);
  }
  return {
    id: definition.id,
    sends: definition.sends,
    send: definition.send,
  };
}
