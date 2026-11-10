import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // 开发时前端由 vite 提供，/api 反代到本机内核
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
