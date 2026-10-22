<script setup lang="ts">
/**
 * 消息历史 —— 读 events.jsonl（倒序），按 type 筛。
 * ⚠️ 只读：历史是「已发生」的事实，不提供任何修改入口。
 */
import { computed, ref, onMounted } from 'vue';
import { state, refresh } from '../store';

const typeFilter = ref('');

onMounted(() => refresh('history'));

const types = computed(() => {
  const items = state.history?.items ?? [];
  return Array.from(new Set(items.map((i) => i.type))).sort();
});

const items = computed(() => {
  const all = state.history?.items ?? [];
  if (!typeFilter.value) return all;
  return all.filter((i) => i.type === typeFilter.value);
});

function fmt(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const SEV_LABEL: Record<string, string> = { info: '说说', warn: '注意', critical: '告警' };
</script>

<template>
  <div class="page">
    <div class="bar">
      <select v-model="typeFilter" class="sel">
        <option value="">全部类型（{{ state.history?.total ?? 0 }} 条）</option>
        <option v-for="t in types" :key="t" :value="t">{{ t }}</option>
      </select>
      <button class="reload" @click="refresh('history')">刷新</button>
    </div>

    <div v-if="!state.history" class="hint">正在读历史…</div>
    <div v-else-if="items.length === 0" class="hint">没有记录。</div>

    <ul v-else class="list">
      <li v-for="(h, i) in items" :key="i" :class="'sev-' + h.severity">
        <span class="ts">{{ fmt(h.ts) }}</span>
        <span class="ty">{{ h.type }}</span>
        <span class="tx">{{ h.text }}</span>
        <span class="lv">{{ SEV_LABEL[h.severity] ?? h.severity }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.page { padding: 14px 20px; }
.bar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
.sel { padding: 5px 8px; font-size: 13px; border: 1px solid #ddd; border-radius: 6px; background: #fff; }
.reload { padding: 5px 12px; font-size: 13px; cursor: pointer; border: 1px solid #ddd; background: #fff; border-radius: 6px; }
.reload:hover { border-color: #1f8a7a; color: #1f8a7a; }
.hint { color: #999; font-size: 13px; }
.list { list-style: none; margin: 0; padding: 0; }
li { display: flex; gap: 10px; align-items: baseline; padding: 5px 4px; border-bottom: 1px solid #f4f4f4; font-size: 13px; }
.ts { color: #aaa; font-size: 11.5px; flex: none; font-variant-numeric: tabular-nums; }
.ty { color: #999; font-size: 11.5px; flex: none; min-width: 120px; }
.tx { flex: 1; min-width: 0; color: #333; }
.lv { flex: none; font-size: 11px; color: #bbb; }
li.sev-warn .tx { color: #b06a00; }
li.sev-critical .tx { color: #c0392b; font-weight: 600; }
</style>
