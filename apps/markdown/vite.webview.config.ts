import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Webview build for the markdown editor (output → apps/vscode-ext/media/markdown).
const localAlias = {
  '@genoffice/docx-engine': resolve(__dirname, '../../packages/docx-engine/src/index.ts'),
  '@genoffice/vscode-bridge': resolve(__dirname, '../../packages/vscode-bridge/src/index.ts'),
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  resolve: { alias: localAlias },
  build: {
    outDir: resolve(__dirname, '../vscode-ext/media/markdown'),
    emptyOutDir: true,
  },
})
