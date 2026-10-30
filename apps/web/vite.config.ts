import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { packApi } from './server/pack-api.ts';
import { verifyApi } from './server/verify-api.ts';
import { samApi } from './server/sam-api.ts';

// `--mode lan` serves over self-signed HTTPS on the LAN: phones only grant
// camera access to secure origins.
export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the app under /<repo>/; the deploy workflow sets BASE.
  base: process.env.BASE ?? '/',
  worker: { format: 'es' },
  // Shown in the UI, so a tablet running a stale cached build is easy to spot.
  define: { __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
  plugins: [
    mode === 'lan' && basicSsl(),
    // Local Meta AI packer endpoint (dev/preview only; the Pages build is static).
    packApi(),
    // Plant-side verifier endpoint (Ollama on the plant network; dev/preview only).
    verifyApi(),
    // SAM 3.1 screen finder for the return-channel camera (Meta Model API; dev/preview only).
    samApi(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'samples/*.txt', 'samples/*.json'],
      manifest: {
        name: 'LuminaAI',
        short_name: 'Lumina',
        description: 'Verifiable light-bridge for air-gapped machines',
        theme_color: '#0b0d10',
        background_color: '#0b0d10',
        display: 'standalone',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
    }),
  ],
}));
