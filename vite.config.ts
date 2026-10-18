import { defineConfig } from 'vite';

// In development the Vite dev server (port 5173) forwards game traffic to the Node server (port 3000).
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/socket.io': { target: 'http://localhost:3000', ws: true } },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000, // Phaser is big; that's fine for a game
  },
});
