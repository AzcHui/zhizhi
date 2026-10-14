/**
 * @zhizhi/plugin-sdk · manifest
 *
 * 插件的「身份证 + 权限声明」。
 * 设计原则直接借鉴 Tauri v2 的 capability 模型：**默认全禁**，
 * 插件要什么能力，必须自己写在 manifest 里显式申请。
 *
 * 为什么这是必做项而不是可选项：
 *   只只本身是「安全哨兵」。如果它加载插件时没有权限模型，
 *   用户为了「更安全」而装插件，却引入了整台机器上最大的攻击面。
 */

import type { PluginType } from '@zhizhi/core';

/** 权限声明 —— 四项全部默认空（= 不许） */
export interface PluginPermissions {
  /** 允许读写的路径白名单 */
  readonly fs?: readonly string[];
  /** 允许联网的域名白名单 */
  readonly net?: readonly string[];
  /** 允许执行的命令白名单 */
  readonly exec?: readonly string[];
  /** 系统能力，如 hardware.read */
  readonly sys?: readonly string[];
}

export interface PluginManifest {
  /** 唯一 id，建议与目录名一致：probe-temp */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly type: PluginType;
  /** 兼容的 SDK 版本（语义化范围，如 ^0.1.0） */
  readonly sdk: string;
  /** 入口文件（相对 manifest 所在目录） */
  readonly entry: string;
  readonly description?: string;
  readonly permissions?: PluginPermissions;
}

export const PLUGIN_TYPES: readonly PluginType[] = [
  'probe',
  'rule',
  'persona',
  'channel',
  'action',
  'view',
];

export interface ManifestIssue {
  readonly field: string;
  readonly message: string;
}

/**
 * 校验一份 manifest。
 * M0 版本只守必填项与 type 合法性；S3（动态加载）时会加重版本兼容检查。
 */
export function validateManifest(input: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];

  if (typeof input !== 'object' || input === null) {
    return [{ field: '(root)', message: 'manifest 必须是一个对象' }];
  }

  const m = input as Record<string, unknown>;

  for (const field of ['id', 'name', 'version', 'type', 'sdk', 'entry'] as const) {
    const value = m[field];
    if (typeof value !== 'string' || value.length === 0) {
      issues.push({ field, message: `缺少必填字段 "${field}"` });
    }
  }

  if (typeof m['type'] === 'string' && !PLUGIN_TYPES.includes(m['type'] as PluginType)) {
    issues.push({
      field: 'type',
      message: `type 必须是 ${PLUGIN_TYPES.join(' / ')} 之一，收到 "${m['type']}"`,
    });
  }

  return issues;
}
