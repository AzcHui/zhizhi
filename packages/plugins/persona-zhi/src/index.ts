/**
 * persona-zhi —— 只只本尊的台词包（官方插件）
 *
 * ⭐ 这个文件**刻意写得极薄**：真正的台词全在隔壁 `persona.json` 里。
 *
 * 为什么这么分：
 *   · 台词是**数据** → 改台词不用碰代码、不用重新 build（M5 的验收标准 ①）
 *   · 代码只是**搬运** → 「读 JSON → 交给 SDK」。这么薄，别人替换它没有任何负担
 *
 * 🔒 它碰不到阈值、沉默机制、通道 —— 那些是内核宪法。它只决定「说什么」。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { definePersonaFromJson } from '@zhizhi/plugin-sdk';

// 用 import.meta.url 定位自己的数据文件 —— 不依赖 cwd，也不依赖包名怎么解析
const DATA_FILE = fileURLToPath(new URL('../persona.json', import.meta.url));

export default definePersonaFromJson(JSON.parse(readFileSync(DATA_FILE, 'utf8')) as unknown, DATA_FILE);
