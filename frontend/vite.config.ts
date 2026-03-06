import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Strip /api prefix → FastAPI routes are at /tracks, /predict, etc.
      '/api': {
        target: 'http://localhost:8000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // WebSocket — the frontend now connects directly to localhost:8000 in dev
      // (see useWebSocket.ts) so this proxy entry is only a fallback.
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
})