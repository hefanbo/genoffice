import { build } from 'esbuild'
import { resolve } from 'node:path'

// Workspace packages ship raw TS source with extensionless imports, so they
// must be bundled (mirrors apps/docs electron.vite.config.ts localAlias).
// Alias them to their sources to avoid node_modules symlink staleness.
const alias = {
  '@genoffice/font-metrics': resolve('../../packages/font-metrics/src/index.ts'),
  '@genoffice/ai-provider': resolve('../../packages/ai-provider/src/index.ts'),
  '@genoffice/agent-core': resolve('../../packages/agent-core/src/index.ts'),
  '@genoffice/vscode-bridge': resolve('../../packages/vscode-bridge/src/index.ts'),
}

await build({
  entryPoints: [resolve('src/extension.ts')],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  alias,
  sourcemap: true,
  logLevel: 'info',
})
