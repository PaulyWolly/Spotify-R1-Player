import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2015',
    cssTarget: 'chrome87',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      }
    }
  }
})