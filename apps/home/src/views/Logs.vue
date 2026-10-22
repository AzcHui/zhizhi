<script setup lang="ts">
/**
 * 日志 —— 外壳日志（zhi-shell.log）+ 内核 stderr 合并，实时推流可开关。
 */
import { ref, onMounted, nextTick, watch } from 'vue';
import { state, refresh, setLogLive } from '../store';

const box = ref<HTMLElement | null>(null);

onMounted(async () => {
  await refresh('logs');
  setLogLive(true);
});

/** 新行进来自动滚到底（只有用户本来就贴着底才滚 —— 往上翻看时别被拽走）。 */
function maybeScroll(): void {
  const el = box.value;
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

watch(() => state.logs.length, async () => {
  await nextTick();
  maybeScroll();
});

function fmt(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
</script>

<template>
  <div class="page">
    <div class="bar">
      <label class="live">
        <input type="checkbox" :checked="state.logLive" @change="setLogLive(($event.target as HTMLInputElement).checked)" />
        实时
      </label>
      <span class="count">{{ state.logs.length }} 行</span>
      <button class="reload" @click="refresh('logs')">重载</button>
    </div>

    <div ref="box" class="console">
      <div v-if="state.logs.length === 0" class="hint">还没有日志。</div>
      <div v-for="(l, i) in state.logs" :key="i" class="line">
        <span class="ts">{{ fmt(l.ts) }}</span>
        <span class="src" :class="l.source">{{ l.source === 'shell' ? '壳' : '核' }}</span>
        <span class="tx">{{ l.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 14px 20px; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.bar { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
.live { font-size: 12.5px; color: #666; display: flex; align-items: center; gap: 4px; cursor: pointer; }
.count { font-size: 12px; color: #aaa; }
.reload { margin-left: auto; padding: 4px 12px; font-size: 12.5px; cursor: pointer; border: 1px solid #ddd; background: #fff; border-radius: 6px; }
.console {
  flex: 1; min-height: 0; overflow-y: auto; background: #1e1e1e; color: #d4d4d4;
  border-radius: 8px; padding: 10px 12px; font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; line-height: 1.65;
}
.line { display: flex; gap: 8px; }
.ts { color: #6a6a6a; flex: none; }
.src { flex: none; font-size: 10.5px; padding: 0 4px; border-radius: 3px; }
.src.shell { background: #1f4a44; color: #7fd8c4; }
.src.kernel { background: #3a3a1f; color: #d8c87f; }
.tx { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-all; }
.hint { color: #888; }
</style>
