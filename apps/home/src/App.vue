<script setup lang="ts">
/**
 * 只只的家 · 根组件
 *
 * 四个页签：概览 / 台词池 / 消息历史 / 日志。
 * 风格轻量（不引 UI 库 —— 四个页面不值得拖一个组件库进来）。
 */
import { ref, onMounted } from 'vue';
import { bootstrap, state } from './store';
import Overview from './views/Overview.vue';
import Lines from './views/Lines.vue';
import History from './views/History.vue';
import Logs from './views/Logs.vue';

type TabKey = 'overview' | 'lines' | 'history' | 'logs';

const TABS: { key: TabKey; label: string; comp: unknown }[] = [
  { key: 'overview', label: '概览', comp: Overview },
  { key: 'lines', label: '台词池', comp: Lines },
  { key: 'history', label: '消息历史', comp: History },
  { key: 'logs', label: '日志', comp: Logs },
];

const tab = ref<TabKey>('overview');

onMounted(() => {
  void bootstrap();
});
</script>

<template>
  <div class="shell">
    <header class="head">
      <div class="brand">
        <span class="dot"></span>
        <span class="title">只只的家</span>
      </div>
      <nav class="tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          :class="{ on: tab === t.key }"
          @click="tab = t.key"
        >{{ t.label }}</button>
      </nav>
      <div v-if="state.error" class="err" :title="state.error">{{ state.error }}</div>
    </header>

    <main class="body">
      <component :is="TABS.find(t => t.key === tab)!.comp" />
    </main>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100%; }
.head {
  display: flex; align-items: center; gap: 20px;
  padding: 10px 20px; border-bottom: 1px solid #eee; flex: none;
}
.brand { display: flex; align-items: center; gap: 7px; }
.dot {
  width: 11px; height: 11px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #8fe3d3, #1f8a7a 70%);
}
.title { font-size: 14px; font-weight: 600; color: #333; }
.tabs { display: flex; gap: 4px; }
.tab {
  padding: 5px 13px; font-size: 13px; cursor: pointer;
  border: 1px solid transparent; background: transparent; color: #888; border-radius: 6px;
  font-family: inherit;
}
.tab:hover { color: #1f8a7a; }
.tab.on { background: #eef7f5; color: #1f8a7a; border-color: #cfe8e2; font-weight: 600; }
.err {
  margin-left: auto; font-size: 12px; color: #b06a00;
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.body { flex: 1; min-height: 0; overflow-y: auto; }
</style>
