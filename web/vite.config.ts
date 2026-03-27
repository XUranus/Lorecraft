import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? '/Lorecraft/' : '/',
  define: {
    __PUBLIC_BUILD__: JSON.stringify(!!process.env.GITHUB_PAGES),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@engine': resolve(__dirname, '../src'),
    },
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['sql.js'],
  },
})
