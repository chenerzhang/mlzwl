import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // 开发期把 /api 代理到后端，避免 CORS 与 cookie 问题。
      '/api': {
        target: 'http://127.0.0.1:9133',
        changeOrigin: true,
      },
    },
  },
});
