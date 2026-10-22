/**
 * 只只的家 · 入口
 *
 * 只做三件事：挂载根组件、给全局样式、启动握手。
 * 业务逻辑都在 store / views 里；与外壳的耦合只在 bridge.ts。
 */
import { createApp } from 'vue';
import App from './App.vue';
import './global.css';

createApp(App).mount('#app');
