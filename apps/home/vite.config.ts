import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// ⭐ base: './' —— 必设。
//   家页面不走 file://（ES module + fetch 会被 CORS 卡死），外壳用「虚拟主机」加载：
//   SetVirtualHostNameToFolderMapping("zhizhi.home", distPath) → Navigate("https://zhizhi.home/index.html")
//   虚拟主机下**绝对路径会 404**（/assets/x.js 会被当成 zhizhi.home 根下不存在），
//   相对路径 ./assets/x.js 才解析到 dist 目录里。忘了这行 → 页面加载不出来（--home-test ② 会红）。
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 源码映射不产（家是本地工具，没人会去断点）
    sourcemap: false,
  },
});
