import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ command }) => ({
  root: 'apps/desktop/src/renderer',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'packaged-csp',
      transformIndexHtml(html) {
        if (command !== 'build') return html;
        return html.replace(
          '<!-- CSP_META -->',
          `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">`,
        );
      },
    },
  ],
  base: './',
  build: { outDir: '../../../../.vite/renderer/main_window', emptyOutDir: true },
}));
