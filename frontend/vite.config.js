import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // ── Assets WASM (OpenCascade.js + mesh.wasm) ─────────────────────────────
  // Excluir os glues Emscripten do pré-bundling do Vite: eles são módulos
  // CommonJS/UMD com lógica de carregamento dinâmico que o esbuild não deve
  // transformar. Ambos são servidos de public/ como assets estáticos.
  optimizeDeps: {
    exclude: ['opencascade.js', 'mesh.js'],
  },


  // Headers necessários para SharedArrayBuffer (usado internamente pelo WASM).
  // COOP/COEP criam um contexto "cross-origin isolated" no browser.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
