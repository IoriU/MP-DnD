import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// In development the Vite dev server (port 5173) forwards game traffic to the Node server (port 3000).
// Two pages: the game (index.html) and the Codex, a read-only dashboard over the game's content (codex.html).
export default defineConfig(({ command }) => ({
  publicDir: 'client/assets', // sprite sheets (DawnLike, see CREDITS.md), served at the site root
  // The Codex links each entry to its source line in VS Code. Only the dev server knows the project folder: a build must not embed it.
  define: command === 'serve' ? { __CODEX_ROOT__: JSON.stringify(fileURLToPath(new URL('.', import.meta.url))) } : {},
  server: {
    port: 5173,
    proxy: { '/socket.io': { target: 'http://localhost:3000', ws: true } },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000, // Phaser is big; that's fine for a game
    rollupOptions: { input: { index: 'index.html', codex: 'codex.html' } },
  },
}));
