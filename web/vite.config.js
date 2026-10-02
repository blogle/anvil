import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, assetsDir: 'assets' },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: { alias: { 'react': 'preact/compat', 'react-dom': 'preact/compat' } },
})
