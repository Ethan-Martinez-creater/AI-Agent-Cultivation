import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.vite/**',
      'out/**',
      'node_modules/**',
      'coverage/**',
      '.tmp/**',
      '.test-data/**',
      '.npm-cache/**',
      '.electron-cache/**',
      '.electron-dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { MAIN_WINDOW_VITE_DEV_SERVER_URL: 'readonly', MAIN_WINDOW_VITE_NAME: 'readonly' },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', window: 'readonly' } },
  },
  {
    files: ['apps/desktop/src/main/fixtures/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', Buffer: 'readonly' } },
  },
);
