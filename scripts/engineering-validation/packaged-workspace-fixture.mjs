import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Synthetic input for the existing --w22-fake-software CROSS_LAYER scenario.
// No product module, workflow definition, tool or permission hook is replaced.
export function preparePackagedWorkspace({ workspace, evidence }) {
  for (const path of [workspace, evidence]) {
    const absolute = resolve(path);
    assert.match(absolute, /^E:[\\/]/i, 'Fixture artifacts must stay on E:');
    assert.match(absolute, /[\\/](?:\.tmp|\.test-data)[\\/]/i, 'Use an ignored isolated directory');
  }
  mkdirSync(workspace, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  const targetArea = ['renderer.ts', 'ipc.ts', 'store.ts'];
  const ledgerPath = join(evidence, 'verification-events.ndjson');
  const seeds = {
    'package.json':
      JSON.stringify(
        {
          name: 'e1-isolated-typescript-fixture',
          private: true,
          type: 'module',
          scripts: { test: 'node verify.mjs' },
        },
        null,
        2,
      ) + '\n',
    'tsconfig.json':
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            allowImportingTsExtensions: true,
          },
          include: ['*.ts'],
        },
        null,
        2,
      ) + '\n',
    'renderer.ts': 'export const featureRenderer: boolean = false;\n',
    'ipc.ts': "export const featureIpc: string = 'feature:pending';\n",
    'store.ts': 'export const featureStored: boolean = false;\n',
    'verify.mjs': [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      `const ledger = ${JSON.stringify(ledgerPath)};`,
      "const record = (event) => appendFileSync(ledger, JSON.stringify({ event, pid: process.pid, at: new Date().toISOString() }) + '\\n', 'utf8');",
      "record('ENTRY');",
      'try {',
      "  const renderer = await import('./renderer.ts');",
      "  const ipc = await import('./ipc.ts');",
      "  const store = await import('./store.ts');",
      '  assert.equal(renderer.featureRenderer, true);',
      "  assert.equal(ipc.featureIpc, 'feature:run');",
      '  assert.equal(store.featureStored, true);',
      "  record('COMPLETED');",
      "  console.log('offline TypeScript cross-layer verification passed');",
      '} catch (error) {',
      "  record('FAILED');",
      '  throw error;',
      '}',
      '',
    ].join('\n'),
  };
  for (const [name, content] of Object.entries(seeds)) {
    const path = join(workspace, name);
    assert.ok(!existsSync(path), 'Refuse to overwrite fixture input: ' + path);
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
  }
  const expectedContents = {
    'renderer.ts': 'export const featureRenderer = true;\n',
    'ipc.ts': "export const featureIpc = 'feature:run';\n",
    'store.ts': 'export const featureStored = true;\n',
  };
  const expectedContent = expectedContents['renderer.ts'];
  return {
    objective:
      'cross-layer renderer IPC：在隔离 TypeScript 示例中实现并验证 renderer、IPC、store 三层功能标志。',
    targetArea,
    targetPath: 'renderer.ts',
    expectedContent,
    expectedContents,
    expectedSha256: createHash('sha256').update(expectedContent).digest('hex'),
    ledgerPath,
    language:
      'TypeScript cross-layer fixture; Node 24 executes .ts module exports via the real permission-gated verify_repository command. No tsc/static-typecheck claim.',
    metadata: Object.entries(seeds).map(([name, content]) => ({
      name,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    })),
  };
}
