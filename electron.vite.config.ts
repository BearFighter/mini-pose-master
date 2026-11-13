// SPDX-License-Identifier: GPL-3.0-or-later
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const alias = { '@shared': resolve('src/shared') }

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: mpm:; connect-src 'self' mpm:; worker-src 'self' blob:; font-src 'self' data:"

// Production builds only. Dev mode runs without CSP (Vite HMR needs inline scripts).
const cspPlugin: Plugin = {
  name: 'mpm-csp',
  apply: 'build',
  transformIndexHtml(html) {
    if (!html.includes('<head>')) throw new Error('index.html has no <head> to inject the CSP into')
    return html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`
    )
  }
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve('electron/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve('electron/preload/index.ts') } }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    plugins: [react(), cspPlugin]
  }
})
