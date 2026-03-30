import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'))
let gitHash = process.env.GIT_HASH ?? ''
if (!gitHash) {
  try { gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim() } catch { gitHash = 'dev' }
}

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? '/Lorecraft/' : '/',
  define: {
    __PUBLIC_BUILD__: JSON.stringify(!!process.env.GITHUB_PAGES),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
    __GIT_HASH__: JSON.stringify(gitHash),
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
    include: ['sql.js'],
  },
})
