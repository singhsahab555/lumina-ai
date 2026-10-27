import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `--mode lan` serves over self-signed HTTPS on the LAN: phones only grant
// camera access to secure origins.
export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the app under /<repo>/; the deploy workflow sets BASE.
  base: process.env.BASE ?? '/',
  worker: { format: 'es' },
  plugins: [
    mode === 'lan' && basicSsl(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'samples/*.txt'],
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
