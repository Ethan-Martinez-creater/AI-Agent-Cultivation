import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const executablePath = join(
  process.cwd(),
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const userData = join(process.cwd(), '.test-data', `packaged-${Date.now()}`);
mkdirSync(userData, { recursive: true });
assert.ok(existsSync(executablePath), `Package not found: ${executablePath}`);

const app = await electron.launch({
  executablePath,
  timeout: 30_000,
  env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
});
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '洞府 Home' }).waitFor();
  for (const [link, heading] of [
    ['道友 Teammates', '道友 Teammates'],
    ['队伍 Parties', '队伍 Parties'],
    ['历练 Missions', '历练 Missions'],
    ['功法 Skills', '功法 Skills'],
    ['法宝 Tools', '法宝 Tools'],
    ['记忆 Memory', '记忆 Memory'],
    ['灵石 Usage', '灵石 Usage'],
    ['设置 Settings', '设置 Settings'],
  ]) {
    await page.getByRole('link', { name: link }).click();
    await page.getByRole('heading', { name: heading }).waitFor();
  }
  const ping = await page.evaluate(() => window.cultivation.health.ping());
  assert.deepEqual(ping, { status: 'ok', database: 'sqlite' });
  assert.ok(existsSync(join(userData, 'data', 'cultivation.sqlite')));
  console.log('GATE0_PACKAGED_SMOKE_OK navigation=9 ipc=ok native_sqlite=ok');
} finally {
  await app.close();
}
