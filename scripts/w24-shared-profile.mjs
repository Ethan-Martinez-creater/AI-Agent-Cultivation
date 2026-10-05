import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Opt-in only: the standalone W2.1/2/3 drivers retain their original isolation.
export function acceptancePaths(stage, fallback) {
  const shared = process.env.CULTIVATION_W24_PROFILE;
  if (!shared)
    return {
      profile: fallback,
      workspace: join(fallback, 'workspace'),
      evidence: join(fallback, 'evidence'),
    };
  const profile = resolve(shared);
  const allowed = resolve(process.cwd(), '.test-data');
  const child = relative(allowed, profile);
  assert.ok(
    child && !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child),
    'W2.4 profile must be a project-local child of .test-data',
  );
  return {
    profile,
    workspace: join(profile, 'workspace'),
    evidence: join(profile, 'evidence', stage),
  };
}

const captured = new Set();
export async function captureAcceptance(live, evidence, label) {
  if (!process.env.CULTIVATION_W24_PROFILE || captured.has(`${evidence}:${label}`)) return;
  captured.add(`${evidence}:${label}`);
  const folder = join(evidence, 'visual');
  mkdirSync(folder, { recursive: true });
  for (const width of [1440, 1180, 900]) {
    await live.app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(width, 900);
      window.center();
    }, width);
    await delay(120);
    if (!(await live.page.locator('.workflow-launch-drawer').isVisible())) {
      const focus = label.includes('advanced')
        ? '.workflow-advanced-card'
        : label.includes('delivery') || label.includes('completed')
          ? '.workflow-results'
          : '.workflow-overview';
      const target = live.page.locator(focus);
      if (await target.isVisible()) await target.scrollIntoViewIfNeeded();
    }
    const primary = await live.page.locator('main').evaluate((node) => {
      const copy = node.cloneNode(true);
      copy.querySelectorAll('details,pre,code').forEach((element) => element.remove());
      return copy.textContent;
    });
    assert.doesNotMatch(primary, /TEST_ONLY|FAKE:|\bfixture\b/i, `${label}: visible test marker`);
    await live.page.screenshot({ path: join(folder, `${label}-${width}.png`), fullPage: true });
    assert.equal(
      await live.page.evaluate(
        () => window.document.documentElement.scrollWidth > window.innerWidth + 2,
      ),
      false,
      `${label}/${width}: horizontal page overflow`,
    );
  }
  await live.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 900),
  );
}

export async function attachAcceptanceVisuals(live, evidence) {
  if (!process.env.CULTIVATION_W24_PROFILE) return;
  const original = live.page.screenshot.bind(live.page);
  live.page.screenshot = async (options) => {
    const result = await original(options);
    if (options?.path && !options.path.includes(`${sep}visual${sep}`))
      await captureAcceptance(live, evidence, basename(options.path, '.png'));
    return result;
  };
}

// Previously completed cases remain in the SAME database. Archive only their
// ordinary actors and disable servers through typed IPC to isolate next fixtures.
export async function isolatePreviousAcceptanceActors(live) {
  await live.page.evaluate(async () => {
    const api = window.cultivation;
    for (const actor of await api.teammates.list())
      if (actor.executorKind === 'MODEL_RUNTIME' && actor.status === 'ACTIVE')
        await api.teammates.archive(actor.id);
    for (const server of await api.tools.listMcpServers())
      if (server.enabled)
        await api.tools.saveMcpServer({
          id: server.id,
          name: server.name,
          command: server.command,
          args: server.args,
          envWhitelist: server.envWhitelist,
          cwd: server.cwd,
          enabled: false,
        });
  });
}
