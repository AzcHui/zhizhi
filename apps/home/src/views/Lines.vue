<script setup lang="ts">
/**
 * 台词池 —— 三层合并（user / persona / learned），每句一个「只说这句」（= 试听）。
 *
 * 口径（开工单 3.5）：**试听 = 纯预览**，不进 events.jsonl、不动 trust、不计 occurrence。
 * 第一版**只读** —— 不做编辑（写回 json 防手滑）。
 */
import { computed, ref } from 'vue';
import { state, poolTotal, saidTotal, preview, refresh } from '../store';

const filter = ref('');

/** 段名 → 中文标题（没列到的段直接显示原名，不猜） */
const SECTION_LABEL: Record<string, string> = {
  greeting: '打招呼',
  chitchat: '闲聊',
  chitchat_code: '写代码时',
  chitchat_browser: '翻网页时',
  chitchat_back: '你回来时',
  poked: '被戳',
  poked_again: '被戳（第二次）',
  '*': '兜底',
  'cpu.high': 'CPU 高',
  'mem.high': '内存高',
  'disk.tight': '磁盘紧张',
  'security.newAutostart': '新增自启项',
  'security.autostartChanged': '自启项被改写',
  'security.autostartTrusted': '自启项签名正常',
  'security.autostartUnsigned': '自启项没签名',
  'security.autostartSigBroken': '自启项核验没过',
};

const SOURCE_LABEL: Record<string, string> = {
  user: '你写的',
  persona: '官方',
  learned: '学来的',
};

const sections = computed(() => {
  const all = state.pools ?? [];
  const kw = filter.value.trim();
  if (!kw) return all;
  return all
    .map((s) => ({ ...s, lines: s.lines.filter((l) => l.text.includes(kw)) }))
    .filter((s) => s.lines.length > 0);
});

function label(t: string): string {
  return SECTION_LABEL[t] ?? t;
}

/** ⭐ 含占位符的句子（{value}/{count}/{drive}…）是**内核运行时才填的模板** ——
 *  家里没有那些上下文，显示原文会让人以为只只就会这么说。标出来 + 试听时用可读替身。 */
const PLACEHOLDER = /\{[a-zA-Z_][a-zA-Z0-9_]*\}/;

function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

/** 试听用的可读版本：把占位符换成例子值（真正说话时内核填的是真实数字）。 */
function previewText(text: string): string {
  return text
    .replace(/\{value\}/g, '42')
    .replace(/\{count\}/g, '3')
    .replace(/\{drive\}/g, 'C')
    .replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, '…');
}

/** 重试：重新拉一次台词池（读失败时给用户的出口，别让人干等）。 */
async function reload(): Promise<void> {
  state.poolsError = null;
  await refresh('pools');
}
</script>

<template>
  <div class="page">
    <div class="bar">
      <input v-model="filter" class="search" placeholder="搜台词…" />
      <span class="count">共 {{ poolTotal }} 句 · 已说过 {{ saidTotal }} 句</span>
    </div>

    <!-- ⚠️ 三态区分（2026-10-22 P0 教训）：
         · 没数据       → 「正在读台词池…」（正常加载中）
         · 读失败       → 写清楚原因（state.error），并给个重试按钮
         · 读到了但空   → 「没有匹配的台词。」
         以前这三态塌成第一态 → 用户对着永远转圈的页面，完全不知道出了啥事。 -->
    <div v-if="!state.pools && !state.poolsError" class="hint">正在读台词池…</div>

    <div v-else-if="!state.pools && state.poolsError" class="hint err">
      {{ state.poolsError }}
      <button class="retry" @click="reload">重试</button>
    </div>

    <section v-for="s in sections" :key="s.type" class="section">
      <h3>{{ label(s.type) }}<small>{{ s.type }} · {{ s.lines.length }} 句</small></h3>
      <ul>
        <li v-for="(l, i) in s.lines" :key="s.type + i">
          <span class="text">
            {{ l.text }}
            <em v-if="hasPlaceholder(l.text)" class="tpl">模板（说话时填具体值）</em>
          </span>
          <span class="src" :class="l.source">{{ SOURCE_LABEL[l.source] ?? l.source }}</span>
          <button class="say" @click="preview(previewText(l.text))">只说这句</button>
        </li>
      </ul>
    </section>

    <div v-if="state.pools && sections.length === 0" class="hint">没有匹配的台词。</div>
  </div>
</template>

<style scoped>
.page { padding: 14px 20px; }
.bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.search {
  flex: 1; max-width: 320px; padding: 6px 10px; font-size: 13px;
  border: 1px solid #ddd; border-radius: 6px; outline: none;
}
.search:focus { border-color: #1f8a7a; }
.count { font-size: 12.5px; color: #888; }
.hint { color: #999; font-size: 13px; }
.hint.err { color: #c0392b; line-height: 1.8; }
.retry {
  margin-left: 8px; font-size: 12px; padding: 2px 10px; cursor: pointer;
  border: 1px solid #c0392b; background: #fff; color: #c0392b; border-radius: 5px;
}
.retry:hover { background: #c0392b; color: #fff; }
.section { margin-bottom: 16px; }
.section h3 {
  font-size: 13.5px; margin: 0 0 6px; color: #333; font-weight: 600;
  border-left: 3px solid #1f8a7a; padding-left: 7px;
}
.section h3 small { font-weight: 400; color: #aaa; margin-left: 8px; font-size: 11.5px; }
ul { list-style: none; margin: 0; padding: 0; }
li {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 6px; border-bottom: 1px solid #f2f2f2; font-size: 13px;
}
li:hover { background: #fafafa; }
.text { flex: 1; min-width: 0; color: #333; }
.src { font-size: 11px; color: #aaa; flex: none; }
.src.user { color: #b06a00; }
.src.learned { color: #6a5acd; }
.say {
  flex: none; font-size: 12px; padding: 3px 9px; cursor: pointer;
  border: 1px solid #1f8a7a; background: #fff; color: #1f8a7a; border-radius: 5px;
}
.say:hover { background: #1f8a7a; color: #fff; }
.tpl {
  font-style: normal; font-size: 11px; color: #b06a00;
  background: #fff7e8; border: 1px solid #f0dcb8; border-radius: 4px;
  padding: 0 5px; margin-left: 6px; white-space: nowrap;
}
</style>
