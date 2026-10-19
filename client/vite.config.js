import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to all interfaces so GitHub Codespaces can forward port 5173.
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // Proxy Socket.IO polling AND WebSocket upgrade requests to the backend.
      // Because both the browser request and Vite's forwarded request share the
      // same loopback address, no cross-origin headers are needed and Codespaces
      // never inserts an authentication redirect on the backend port.
      '/socket.io': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        ws: true,           // forward WebSocket upgrades too
      },
      // Also proxy REST API calls so the frontend never needs to know the backend port.
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
});

