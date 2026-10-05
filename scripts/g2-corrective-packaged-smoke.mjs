import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { startH3Fixture } from './fixtures/g2-h3-http.mjs';

const root = process.cwd();
const evidence = join(root, '.test-data', `g2-corrective-${randomUUID()}`);
mkdirSync(evidence, { recursive: true });
const fixture = await startH3Fixture();
const facts = { scenarios: {}, screenshots: [], liveIntegration: 'BLOCKED / NOT RUN' };
let live;
async function launch(profile, crashPoint) {
  live = await electron.launch({
    executablePath: join(root, 'out', 'AI Agent Cultivation-win32-x64', 'AI-Agent-Cultivation.exe'),
    args: [],
    env: {
      ...process.env,
      CULTIVATION_USER_DATA_DIR: profile,
      CULTIVATION_G2_ACCEPTANCE: '1',
      CULTIVATION_G2_PREPARATION_CRASH: crashPoint ?? '',
    },
    timeout: 60_000,
  });
  const page = await live.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor({ timeout: 60_000 });
  return page;
}
async function close() {
  if (live) await live.close().catch(() => undefined);
  live = null;
}
function read(profile, query) {
  const db = new Database(join(profile, 'data', 'cultivation.sqlite'), { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}
async function wait(check, label) {
  for (let i = 0; i < 900; i++) {
    const value = check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function seed(page) {
  return page.evaluate(async (endpoint) => {
    const provider = await window.cultivation.providers.create({
      name: '视频服务',
      kind: 'GENERATION_HTTP',
      adapterId: 'H3',
      baseUrl: endpoint,
    });
    const runtime = await window.cultivation.runtimes.create({
      name: '视频模型',
      providerId: provider.id,
      credentialId: null,
      modelId: 'minimax-h3',
      executionProtocol: 'GENERATION',
    });
    const teammate = await window.cultivation.teammates.create({
      name: '映川',
      avatar: 'preset:01',
      title: null,
      description: '',
      identityPrompt: '',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    });
    const conversation = await window.cultivation.generationChat.createConversation({
      teammateId: teammate.id,
    });
    return { teammateId: teammate.id, conversationId: conversation.id };
  }, fixture.baseUrl);
}
async function send(page, ref, prompt, parameters = { duration: 4 }) {
  return page
    .evaluate(
      async ({ ref, prompt, parameters }) => {
        try {
          await window.cultivation.generationChat.send({ ...ref, prompt, parameters, inputs: [] });
        } catch {
          /* crash and typed preparation failures are asserted from durable facts */
        }
      },
      { ref, prompt, parameters },
    )
    .catch(() => undefined);
}
function snapshot(profile) {
  return read(profile, (db) => ({
    entries: db
      .prepare('SELECT message_id,job_id,preparation_error_code FROM generation_chat_entries')
      .all(),
    jobs: db.prepare('SELECT id,state,error_code FROM generation_jobs').all(),
    adapter: db
      .prepare('SELECT state_json FROM generation_adapter_submissions')
      .all()
      .map((r) => JSON.parse(r.state_json)),
    artifacts: db.prepare('SELECT COUNT(*) AS n FROM generation_artifacts').get().n,
  }));
}
async function capture(page, name) {
  for (const width of [1440, 900]) {
    const win = await live.browserWindow(page);
    await win.evaluate((w, width) => w.setContentSize(width, 900), width);
    await page.setViewportSize({ width, height: 900 });
    const file = join(evidence, `${name}-${width}.png`);
    await page.screenshot({ path: file });
    facts.screenshots.push(relative(root, file));
  }
}
try {
  for (const point of ['ENTRY_COMMITTED', 'JOB_CREATED']) {
    const profile = join(evidence, point);
    mkdirSync(profile, { recursive: true });
    const page = await launch(profile, point);
    const ref = await seed(page);
    const initialPosts = fixture.facts.postAttempts;
    const exited = live.waitForEvent('close', { timeout: 60_000 });
    await send(page, ref, '一段平静湖面的视频');
    await exited;
    await close();
    const crashed = snapshot(profile);
    assert.equal(crashed.entries.length, 1);
    assert.equal(crashed.jobs.length, point === 'JOB_CREATED' ? 1 : 0);
    assert.equal(fixture.facts.postAttempts, initialPosts);
    await launch(profile);
    await wait(() => snapshot(profile).jobs[0]?.state === 'COMPLETED', `${point} recovery`);
    const recovered = snapshot(profile);
    assert.equal(recovered.jobs.length, 1);
    assert.equal(recovered.artifacts, 1);
    assert.equal(recovered.entries[0].job_id, recovered.jobs[0].id);
    assert.equal(fixture.facts.postAttempts - initialPosts, 1);
    await close();
    await launch(profile);
    await delay(800);
    assert.deepEqual(snapshot(profile), recovered);
    assert.equal(fixture.facts.postAttempts - initialPosts, 1);
    facts.scenarios[point] = { crashed, recovered, posts: 1, restartStable: true };
    await close();
  }
  {
    const profile = join(evidence, 'preparation-failed');
    mkdirSync(profile, { recursive: true });
    const page = await launch(profile);
    const ref = await seed(page);
    const before = fixture.facts.postAttempts;
    await send(page, ref, '保存无效时长的准备事实', { duration: 999 });
    const failed = snapshot(profile);
    assert.equal(failed.jobs.length, 0);
    assert(failed.entries[0].preparation_error_code);
    await close();
    await launch(profile);
    await delay(800);
    assert.deepEqual(snapshot(profile), failed);
    assert.equal(fixture.facts.postAttempts, before);
    facts.scenarios.preparationFailure = failed;
    await close();
  }
  for (const [code, proof, expected] of [
    ['AUTH_FAILED', true, 'FAILED'],
    ['QUEUE_FULL', true, 'FAILED'],
    ['AUTH_FAILED', false, 'UNKNOWN'],
  ]) {
    const profile = join(evidence, `${code}-${expected}`);
    mkdirSync(profile, { recursive: true });
    let page = await launch(profile);
    const ref = await seed(page);
    fixture.mode.rejectCode = code;
    fixture.mode.rejectionProof = proof;
    const before = fixture.facts.postAttempts;
    await send(page, ref, '生成一段自然风景视频');
    await wait(() => snapshot(profile).jobs[0]?.state === expected, expected);
    const result = snapshot(profile);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.artifacts, 0);
    assert.equal(result.adapter[0].phase, proof ? 'REJECTED' : 'UNKNOWN');
    assert.equal(result.jobs[0].error_code, proof ? code : 'SUBMISSION_STATE_UNKNOWN');
    await close();
    page = await launch(profile);
    await delay(800);
    assert.deepEqual(snapshot(profile), result);
    assert.equal(fixture.facts.postAttempts - before, 1);
    await page.evaluate((id) => {
      window.location.hash = `/generation-chat/${encodeURIComponent(id)}`;
    }, ref.teammateId);
    await page.getByTestId('generation-entry').waitFor();
    const visible = await page.getByTestId('generation-entry').innerText();
    assert(!visible.includes(code));
    assert(!visible.includes('SUBMISSION_STATE_UNKNOWN'));
    assert(!visible.includes(result.jobs[0].id));
    await capture(page, `${code}-${expected}`);
    await page.getByTestId('generation-entry').getByText('技术详情', { exact: true }).click();
    assert(
      (await page.getByTestId('generation-entry').innerText()).includes(result.jobs[0].error_code),
    );
    facts.scenarios[`${code}-${expected}`] = {
      ...result,
      posts: 1,
      zeroReplay: true,
      productErrorMapping: true,
    };
    fixture.mode.rejectCode = null;
    await close();
  }
} catch (error) {
  facts.failure = String(error);
  throw error;
} finally {
  await close();
  await fixture.close();
  writeFileSync(join(evidence, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');
}
console.log(
  `G2_CORRECTIVE_PACKAGED_SMOKE_OK evidence=${relative(root, evidence)} preJobRecovery=once rejected=FAILED uncertain=UNKNOWN`,
);
