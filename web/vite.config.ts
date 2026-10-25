import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Тяжёлый ExcelJS (нужен только владельцу при выгрузке) не пред-кешируем:
        // грузится по требованию, кассиры его не качают.
        globIgnores: ['**/exceljs*.js'],
      },
      manifest: {
        name: 'Kassa',
        short_name: 'Kassa',
        description: 'Учёт для магазина',
        theme_color: '#0b0d1a',
        background_color: '#0b0d1a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  server: {
    host: true, // доступ по локальной сети (с телефона)
    port: 5173,
    // Домены туннеля (cloudflared) — чтобы открывать кассу вне локальной сети.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': 'http://localhost:4000',
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
