import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves the app from /<repo-name>/; the deploy workflow sets VITE_BASE for that
  base: process.env.VITE_BASE ?? '/',
  optimizeDeps: {
    // Serve MapLibre as published so its web worker file can be found
    exclude: ['maplibre-gl'],
  },
})
