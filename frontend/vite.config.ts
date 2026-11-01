import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Serve MapLibre as published so its web worker file can be found
    exclude: ['maplibre-gl'],
  },
})