// Bundles the main process, the standalone engine, the preload and the runtime that
// generated workflow scripts import. The renderer is built by vite.
import { build } from 'esbuild'

const watch = process.argv.includes('--watch')
const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: true, logLevel: 'info' }

const configs = [
  { ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/main/engine.ts'], outfile: 'dist/engine.cjs', format: 'cjs' },
  { ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs', external: ['electron'] },
  // Copied next to every generated script as ./locallink.mjs.
  { ...common, entryPoints: ['src/runtime/locallink.ts'], outfile: 'dist/locallink.mjs', format: 'esm', sourcemap: false },
]

if (watch) {
  const { context } = await import('esbuild')
  for (const c of configs) await (await context(c)).watch()
} else {
  await Promise.all(configs.map((c) => build(c)))
}
