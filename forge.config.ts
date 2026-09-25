import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'AI Agent Cultivation',
    executableName: 'AI-Agent-Cultivation',
    asar: { unpack: '**/*.node' },
    electronZipDir: process.env.CULTIVATION_ELECTRON_ZIP_DIR || undefined,
    ignore: (file: string) => {
      const normalized = file.replaceAll('\\', '/');
      if (!normalized) return false;
      return !(
        normalized.startsWith('/.vite') ||
        normalized === '/node_modules' ||
        normalized.startsWith('/node_modules/better-sqlite3')
      );
    },
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['win32'])],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'apps/desktop/src/main/main.ts', config: 'vite.main.config.ts' },
        { entry: 'apps/desktop/src/preload/preload.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
  ],
};

export default config;
