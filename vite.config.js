import { defineConfig } from 'vite';

// Base './' — игра публикуется ZIP-архивом и открывается из произвольного пути
// (в Яндекс Играх это iframe на домене платформы), поэтому никаких абсолютных URL.
export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Live-preview проксируется через внешний хост — разрешаем любые origin.
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 100000,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Один бандл: меньше запросов, проще упаковка в ZIP.
        codeSplitting: false,
      },
    },
  },
});
