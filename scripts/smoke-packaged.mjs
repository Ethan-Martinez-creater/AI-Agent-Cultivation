import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';

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
  args: ['--gate1-fake-model'],
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
  const key = `sk-gate1-smoke-${randomUUID()}`;
  const providers = await page.evaluate(async () => {
    const api = window.cultivation;
    const providerA = await api.providers.create({ name: 'Smoke OpenAI', kind: 'OPENAI' });
    const providerB = await api.providers.create({ name: 'Smoke Anthropic', kind: 'ANTHROPIC' });
    return { providerA, providerB };
  });
  const rendererKeyRejected = await page.evaluate(
    (providerId) =>
      window.cultivation.credentials
        .create({ providerId, label: 'Rejected', apiKey: 'renderer-plaintext' })
        .then(
          () => false,
          () => true,
        ),
    providers.providerA.id,
  );
  assert.equal(rendererKeyRejected, true);
  await app.evaluate(({ clipboard }, plaintext) => clipboard.writeText(plaintext), key);
  const rendererClipboard = await page.evaluate(async () => {
    try {
      return await window.navigator.clipboard?.readText();
    } catch {
      return null;
    }
  });
  assert.notEqual(rendererClipboard, key);
  const credentialA = await page.evaluate(
    (providerId) => window.cultivation.credentials.create({ providerId, label: 'A' }),
    providers.providerA.id,
  );
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
  await app.evaluate(({ clipboard }, plaintext) => clipboard.writeText(plaintext), key);
  const credentialB = await page.evaluate(
    (providerId) => window.cultivation.credentials.create({ providerId, label: 'B' }),
    providers.providerB.id,
  );
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
  const result = await page.evaluate(
    async ({ providerA, providerB, credentialA, credentialB }) => {
      const api = window.cultivation;
      const returnedCredential = (await api.credentials.list(providerA.id))[0];
      const runtimeA = await api.runtimes.create({
        name: 'Runtime A',
        providerId: providerA.id,
        credentialId: credentialA.id,
        modelId: 'smoke-model-a',
      });
      const runtimeB = await api.runtimes.create({
        name: 'Runtime B',
        providerId: providerB.id,
        credentialId: credentialB.id,
        modelId: 'smoke-model-b',
      });
      const connection = await api.runtimes.testConnection(runtimeA.id);
      const teammateInput = {
        name: '青玄',
        avatar: null,
        title: null,
        description: 'Smoke test',
        identityPrompt: 'You are Qingxuan.',
        behaviorPrompt: '',
        currentRuntimeProfileId: runtimeA.id,
      };
      const teammate = await api.teammates.create(teammateInput);
      const conversation = await api.chat.createConversation(teammate.id);
      const stream = (teammateId, conversationId, text) =>
        new Promise((resolve, reject) => {
          const requestId = window.crypto.randomUUID();
          const events = [];
          const timer = window.setTimeout(() => {
            off();
            reject(new Error('stream timeout'));
          }, 15_000);
          const off = api.chat.onEvent((event) => {
            if (event.requestId !== requestId) return;
            events.push(event);
            if (event.type === 'done' || event.type === 'error') {
              window.clearTimeout(timer);
              off();
              if (event.type === 'error') reject(new Error(event.message));
              else resolve(events);
            }
          });
          api.chat.send({ requestId, teammateId, conversationId, text }).catch((error) => {
            window.clearTimeout(timer);
            off();
            reject(error);
          });
        });
      const first = await stream(teammate.id, conversation.id, 'PING');
      const switched = await api.teammates.switchRuntime({
        teammateId: teammate.id,
        runtimeProfileId: runtimeB.id,
      });
      const second = await stream(teammate.id, conversation.id, 'again');
      const other = await api.teammates.create({ ...teammateInput, name: '玄明' });
      const otherConversation = await api.chat.createConversation(other.id);
      const [third, fourth] = await Promise.all([
        stream(teammate.id, conversation.id, 'parallel A'),
        stream(other.id, otherConversation.id, 'parallel B'),
      ]);
      return {
        credentialId: credentialA.id,
        credentialKeys: Object.keys(api.credentials).sort(),
        returnedCredential,
        providerA: providerA.id,
        providerB: providerB.id,
        runtimeA: runtimeA.id,
        runtimeB: runtimeB.id,
        connection,
        teammateId: teammate.id,
        switchedId: switched.id,
        conversationId: conversation.id,
        messages: await api.chat.listMessages({
          teammateId: teammate.id,
          conversationId: conversation.id,
        }),
        usage: await api.usage.list(),
        streams: [first, second, third, fourth],
        otherTeammateId: other.id,
        otherConversationId: otherConversation.id,
      };
    },
    { ...providers, credentialA, credentialB },
  );
  assert.deepEqual(result.credentialKeys, ['create', 'list']);
  assert.ok(!JSON.stringify(result.returnedCredential).includes(key));
  assert.ok(!('ciphertext' in result.returnedCredential));
  assert.equal(result.switchedId, result.teammateId);
  assert.equal(result.connection.ok, true);
  assert.equal(result.messages.length, 6);
  assert.ok(result.messages.every((message) => message.conversationId === result.conversationId));
  for (const [index, events] of result.streams.entries()) {
    assert.ok(events.some((event) => event.type === 'delta'));
    assert.equal(events.at(-1)?.type, 'done');
    const expectedTeammate = index === 3 ? result.otherTeammateId : result.teammateId;
    const expectedConversation = index === 3 ? result.otherConversationId : result.conversationId;
    assert.ok(
      events.every(
        (event) =>
          event.teammateId === expectedTeammate && event.conversationId === expectedConversation,
      ),
    );
  }
  const teammateUsage = result.usage.filter((item) => item.teammateId === result.teammateId);
  assert.equal(teammateUsage.length, 3);
  assert.equal(
    teammateUsage.filter(
      (item) => item.runtimeProfileId === result.runtimeA && item.provider === result.providerA,
    ).length,
    1,
  );
  assert.equal(
    teammateUsage.filter(
      (item) => item.runtimeProfileId === result.runtimeB && item.provider === result.providerB,
    ).length,
    2,
  );
  assert.ok(teammateUsage.every((item) => item.inputTokens !== null && item.outputTokens !== null));
  assert.equal(result.usage.filter((item) => item.teammateId === result.otherTeammateId).length, 1);

  const db = new Database(join(userData, 'data', 'cultivation.sqlite'), { readonly: true });
  try {
    const row = db
      .prepare('SELECT ciphertext FROM provider_credentials WHERE id = ?')
      .get(result.credentialId);
    assert.ok(row && row.ciphertext instanceof Buffer);
    assert.ok(!row.ciphertext.includes(Buffer.from(key)));
  } finally {
    db.close();
  }
  console.log(
    'GATE1_PACKAGED_SMOKE_OK navigation=9 ipc=ok native_sqlite=ok secret=encrypted chat=streamed runtime_migration=ok usage=ok',
  );
} finally {
  await app.close();
}
