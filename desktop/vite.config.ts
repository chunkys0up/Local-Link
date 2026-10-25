import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The renderer. In dev the engine's HTTP API is proxied under /api, as the dashboard did;
// packaged, the window loads dist/renderer and talks to the engine on 127.0.0.1 directly.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: {
    port: 5317,
    strictPort: true,
    proxy: {
      // Anchored, so the renderer's own api.ts isn't proxied.
      '^/api/': {
        target: `http://127.0.0.1:${process.env.LOCAL_LINK_PORT ?? 8000}`,
        rewrite: (path: string) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: { root: '.', include: ['tests/**/*.test.ts'], environment: 'node', setupFiles: ['tests/setup.ts'] },
} as never)
