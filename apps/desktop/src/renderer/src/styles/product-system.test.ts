import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const styles = dirname(fileURLToPath(import.meta.url));
const renderer = dirname(styles);
const source = (file: string) => readFileSync(join(renderer, file), 'utf8');
const files = [
  'style.css',
  'product.css',
  ...readdirSync(styles)
    .filter((file) => file.endsWith('.css'))
    .map((file) => `styles/${file}`),
  ...readdirSync(join(renderer, 'pages'))
    .filter((file) => file.endsWith('.css'))
    .map((file) => `pages/${file}`),
];

describe('product system source boundaries', () => {
  it('owns semantic tokens in one source with a fixed cascade order', () => {
    expect(files.filter((file) => /:root\s*\{/.test(source(file)))).toEqual(['styles/tokens.css']);
    expect(source('style.css')).toContain('@layer tokens, foundation, components, layouts, pages;');
    expect(source('product.css')).not.toContain(':root');
    expect(source('main.tsx').trimStart()).toMatch(/^import '\.\/style\.css';/);
  });
  it('keeps page typography, palette and radius on semantic tokens', () => {
    for (const file of files.filter((file) => file !== 'styles/tokens.css')) {
      const css = source(file);
      expect(css, file).not.toMatch(/font-size\s*:\s*(?:\d|clamp\()/);
      expect(css, file).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(css, file).not.toMatch(/border-radius\s*:\s*\d+[1-9]\d*(?:px|%)/);
    }
  });
  it('uses the published five typography levels without tiny fallback labels', () => {
    const tokens = source('styles/tokens.css');
    for (const [role, size] of [
      ['title', 24],
      ['section', 18],
      ['body', 14],
      ['control', 13],
      ['caption', 12],
    ]) {
      expect(tokens).toContain(`--font-${role}: ${size}px;`);
    }
    expect(tokens).not.toMatch(/--font-[\w-]+:\s*(?:10|11)px/);
  });
  it('styles every necessary scrollbar at the foundation layer', () => {
    const foundation = source('styles/foundation.css');
    expect(foundation).toContain('scrollbar-width: thin');
    expect(foundation).toContain('::-webkit-scrollbar');
    expect(foundation).toContain('var(--scrollbar-width)');
  });
});
