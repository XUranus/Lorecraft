import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? '/Lorecraft/' : '/',
  define: {
    __PUBLIC_BUILD__: JSON.stringify(!!process.env.GITHUB_PAGES),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    __GIT_HASH__: JSON.stringify(process.env.GIT_HASH ?? 'dev'),
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
