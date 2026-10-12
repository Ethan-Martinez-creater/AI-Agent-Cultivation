/* global AbortSignal */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

// Read-only, explicit live acceptance. No generation POST or hidden fallback.
const root = process.cwd();
const key = (await readFile(join(root, 'private/keys.txt'), 'utf8'))
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)[3]
  .trim();
assert.ok(key && !/\s/.test(key));
const app = await electron.launch({
  executablePath: join(root, 'out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe'),
  args: ['--proxy-server=http://127.0.0.1:7890'],
  env: {
    ...process.env,
    CULTIVATION_USER_DATA_DIR: join(root, '.test-data/gen-v1-live/production-profile'),
  },
  timeout: 60000,
});
try {
  const facts = await app.evaluate(async ({ net }, key) => {
    const result = { generationPosts: 0, requests: [] };
    for (const path of ['/v1/models', '/v1/videos?page=1&pageSize=1']) {
      try {
        const response = await net.fetch('https://tokenrhythm.studio' + path, {
          headers: { authorization: 'Bearer ' + key },
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        });
        const body = await response.json();
        result.requests.push({
          path,
          http: response.status,
          modelIds:
            path === '/v1/models'
              ? (Array.isArray(body.data) ? body.data : (body.models ?? []))
                  .slice(0, 100)
                  .map((value) => value.id ?? value.name ?? null)
              : undefined,
          code:
            typeof body.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code) ? body.code : null,
          count: path.includes('/videos?') ? (body.total ?? body.totalCount ?? null) : undefined,
        });
      } catch (error) {
        result.requests.push({ path, errorType: error.name });
      }
    }
    return result;
  }, key);
  facts.status = 'BLOCKED';
  facts.reason =
    'Authenticated read-only checks do not establish a current Wan model price and account-specific generation permission. No billable POST was made.';
  facts.videoGeneration = 'NOT_RUN';
  facts.publicDocumentation = 'https://tokenrhythm.studio/docs/api-integration';
  facts.checkedAt = new Date().toISOString();
  const output = JSON.stringify(facts, null, 2);
  assert.ok(!output.includes(key));
  await writeFile(
    join(root, 'docs/evidence/gen-v1-live-software-v2/packaged/tokenrhythm-video-check.json'),
    output + '\n',
    'utf8',
  );
  console.log('LIVE_TOKENRHYTHM_WAN_VIDEO_CHECK BLOCKED; generation POST=0');
} finally {
  await app.close();
}
