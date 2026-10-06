import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { resolve } from 'node:path';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'AI Agent Cultivation',
    executableName: 'AI-Agent-Cultivation',
    // Vite bundles JavaScript dependencies. Preserve the explicit native-only copy policy;
    // Packager's default dependency pruner otherwise bypasses ignore for dependency roots.
    prune: false,
    derefSymlinks: true,
    asar: { unpack: '**/*.node' },
    extraResource: [resolve('node_modules/sqlite-vec-windows-x64/vec0.dll')],
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
  makers: [
    new MakerSquirrel({ name: 'AiAgentCultivation', noMsi: true }, ['win32']),
    new MakerZIP({}, ['win32']),
  ],
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
