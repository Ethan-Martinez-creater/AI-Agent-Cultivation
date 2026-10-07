import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { navigateUi } from './ui-navigation.mjs';

const waitForPaint = async (page) =>
  page.evaluate(
    () => new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined))),
  );

async function setViewportAndCapture(page, width, name, screenshotDirectory) {
  await page.setViewportSize({ width, height: 820 });
  await page.waitForTimeout(100);
  await waitForPaint(page);
  const metrics = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: window.document.documentElement.scrollWidth,
    bodyWidth: window.document.body.scrollWidth,
  }));
  assert.ok(
    metrics.documentWidth <= metrics.viewportWidth + 1 &&
      metrics.bodyWidth <= metrics.viewportWidth + 1,
    `Horizontal overflow at ${width}px: ${JSON.stringify(metrics)}`,
  );
  const path = join(screenshotDirectory, name);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  return { path, ...metrics };
}

/**
 * Exercise the packaged R4 routing UI against already seeded, available model teammates.
 * The only created Mission remains a DRAFT; no run or approval is started.
 */
export async function verifyR4RoutingUi(page, { a, b }) {
  assert.ok(a?.id && a?.name, 'Expected teammate a with id and name.');
  assert.ok(b?.id && b?.name, 'Expected teammate b with id and name.');
  assert.notEqual(a.id, b.id, 'The routing UI smoke test needs two distinct teammates.');

  const runId = randomUUID();
  const screenshotDirectory = join(process.cwd(), '.test-data', `r4-ui-${runId}`);
  mkdirSync(screenshotDirectory, { recursive: true });
  const screenshots = [];
  const missionTitle = `R4 自动分配 UI ${runId.slice(0, 8)}`;
  const missionObjective = `请用三点概括一个简单问题的核心意思并给出简短理由。检查 ${runId.slice(0, 8)}。`;

  await navigateUi(page, '历练 Missions');
  await page
    .locator('.mission-list-card header')
    .getByRole('button', { name: '发起历练', exact: true })
    .click();
  await page.getByRole('heading', { name: '发起历练', exact: true }).waitFor();
  assert.equal(await page.getByLabel('分配方式').inputValue(), 'AUTO');

  await page.getByRole('button', { name: /可选：指定必需能力/ }).click();
  const selectedCapabilities = await page
    .locator('.routing-capability-grid input[type="checkbox"]:checked')
    .count();
  assert.equal(selectedCapabilities, 0, 'Capability selection must not have a fabricated default.');

  await page.getByLabel('标题', { exact: true }).fill(missionTitle);
  await page.getByLabel('任务目标', { exact: true }).fill(missionObjective);
  screenshots.push(
    await setViewportAndCapture(page, 1180, 'missions-auto-create-1180.png', screenshotDirectory),
  );
  await page.getByRole('button', { name: '分配并创建草稿', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '历练草稿已创建' }).waitFor();
  await page.locator('.mission-advanced > summary').filter({ hasText: '执行分配记录' }).click();
  await page.locator('.routing-receipt').waitFor({ state: 'visible' });

  const routeResult = await page.evaluate(async (title) => {
    const rows = await window.cultivation.missions.list();
    const mission = rows.find((row) => row.title === title);
    if (!mission) return null;
    const [detail, receipts] = await Promise.all([
      window.cultivation.missions.detail(mission.id),
      window.cultivation.routing.receipts(mission.id),
    ]);
    return { mission: detail.mission, receipts };
  }, missionTitle);
  assert.ok(routeResult, 'Automatic routing should create the requested draft Mission.');
  assert.equal(routeResult.mission.state, 'DRAFT', 'The UI smoke must not start a Mission run.');
  const assignedReceipt = routeResult.receipts.find((receipt) => receipt.outcome === 'ASSIGNED');
  assert.ok(assignedReceipt, 'The created Mission should have an assigned routing receipt.');
  assert.equal(
    assignedReceipt.assignment?.kind,
    'SOLO',
    'Automatic routing should assign solo execution.',
  );
  const assignedTeammateId = assignedReceipt.assignment?.coordinatorTeammateId;
  assert.ok(
    [a.id, b.id].includes(assignedTeammateId),
    `Expected the assigned actor to be one of the seeded teammates; received ${assignedTeammateId}.`,
  );
  assert.equal(routeResult.mission.coordinatorTeammateId, assignedTeammateId);
  const assignedTeammate = assignedTeammateId === a.id ? a : b;
  assert.equal(
    (await page.locator('.mission-executor-summary strong').innerText()).trim(),
    assignedTeammate.name,
    'The Mission detail should show the assigned actor name.',
  );
  assert.equal(await page.locator('.routing-action-required').count(), 0);
  assert.ok(
    assignedReceipt.candidates.length > 0,
    'The assignment receipt should explain its candidates.',
  );
  const candidateDisclosure = page
    .locator('.routing-receipt')
    .first()
    .locator('.routing-candidate-details > summary');
  await candidateDisclosure.click();
  const candidateRows = page.locator('.routing-receipt').first().locator('.routing-candidate-row');
  assert.equal(
    await candidateRows.count(),
    Math.min(128, assignedReceipt.candidates.length),
    'The receipt should show the full bounded candidate set, capped visibly at 128.',
  );
  assert.equal(
    (await candidateRows.first().locator('strong').innerText()).trim(),
    assignedTeammate.name,
    'The selected executor should be prioritized in candidate details.',
  );
  screenshots.push(
    await setViewportAndCapture(page, 1180, 'mission-receipt-1180.png', screenshotDirectory),
  );

  const unavailableTeammate = await page.evaluate(async (sourceId) => {
    const duplicate = await window.cultivation.teammates.duplicate(sourceId);
    const archived = await window.cultivation.teammates.archive(duplicate.id);
    return { id: archived.id, name: archived.name, status: archived.status };
  }, b.id);
  assert.equal(unavailableTeammate.status, 'ARCHIVED');
  const priorUnavailableAvailability = await page.evaluate(
    async (teammateId) =>
      (await window.cultivation.availability.list()).filter(
        (item) => item.teammateId === teammateId,
      ),
    unavailableTeammate.id,
  );

  await page.evaluate((teammateId) => {
    window.location.hash = `#/missions?create=1&teammateId=${encodeURIComponent(teammateId)}`;
  }, unavailableTeammate.id);
  await page.getByRole('heading', { name: '发起历练', exact: true }).waitFor();
  // The wrapping label also includes native select option text, so use a
  // partial accessible-name match for this control.
  const selectedTeammate = page.getByLabel('选择道友');
  assert.equal(await selectedTeammate.inputValue(), unavailableTeammate.id);
  assert.match(await selectedTeammate.locator('option:checked').innerText(), /当前不可用/);

  const rejectedTitle = `R4 指定不可用 UI ${runId.slice(0, 8)}`;
  await page.getByLabel('标题', { exact: true }).fill(rejectedTitle);
  await page
    .getByLabel('任务目标', { exact: true })
    .fill('验证指定不可用道友时保留选择，不自动改派。');
  await page.getByRole('button', { name: '分配并创建草稿', exact: true }).click();
  await page.locator('.routing-action-required').waitFor({ state: 'visible' });
  const unavailableNotice = await page.locator('.routing-action-required').innerText();
  assert.match(unavailableNotice, /指定的道友当前不可用/);
  assert.match(unavailableNotice, /没有改派给其他人/);
  assert.equal(await selectedTeammate.inputValue(), unavailableTeammate.id);
  const missionsAfterRejectedChoice = await page.evaluate(() => window.cultivation.missions.list());
  assert.equal(
    missionsAfterRejectedChoice.some((mission) => mission.title === rejectedTitle),
    false,
    'An unavailable explicit assignment must not create or silently reassign a Mission.',
  );
  screenshots.push(
    await setViewportAndCapture(
      page,
      1180,
      'mission-unavailable-choice-1180.png',
      screenshotDirectory,
    ),
  );

  const recheckButton = page.getByRole('button', { name: '重新检测', exact: true });
  if ((await recheckButton.count()) > 0) {
    await recheckButton.click();
    await page.getByRole('alert').waitFor({ state: 'visible' });
    assert.match(await page.getByRole('alert').innerText(), /没有当前可重新检测的模型道友/);
    assert.equal(await selectedTeammate.inputValue(), unavailableTeammate.id);
  }
  const afterUnavailableAvailability = await page.evaluate(
    async (teammateId) =>
      (await window.cultivation.availability.list()).filter(
        (item) => item.teammateId === teammateId,
      ),
    unavailableTeammate.id,
  );
  assert.deepEqual(
    afterUnavailableAvailability,
    priorUnavailableAvailability,
    'Archived teammates must be guarded from availability rechecks.',
  );

  const shadowBefore = await page.evaluate(() => window.cultivation.r3.getConfig());
  assert.equal(shadowBefore.enabled, false, 'R3 Shadow must remain disabled before the R4 check.');
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  await navigateUi(page, '设置 Settings');
  await page.getByRole('tab', { name: '智能分配', exact: true }).click();
  const routingCheckbox = page.getByRole('switch', {
    name: 'Cloud 智能分配',
    exact: true,
  });
  assert.equal(
    await routingCheckbox.isChecked(),
    true,
    'The fixture should have enabled R4 Cloud.',
  );
  const routingConfig = await page.evaluate(() => window.cultivation.routing.config());
  assert.equal(routingConfig.cloudEnabled, true);
  await page.locator('.routing-config-card details > summary').click();
  const privacyCopy = await page.locator('.routing-config-card details p').allTextContents();
  const privacyText = privacyCopy.join('\n');
  for (const expectedField of [
    '有界的任务摘要',
    '候选道友身份',
    'Benchmark 能力档位',
    '已启用功法元数据',
    '可核验经历摘要',
    '当前道友的候选记忆摘要',
    '摘要为空时使用脱敏后的有限摘录',
    '关闭 Cloud 时不发送这些内容',
  ]) {
    assert.ok(
      privacyText.includes(expectedField),
      `Missing bounded send-scope item: ${expectedField}`,
    );
  }
  for (const excludedField of [
    '不发送 API Key',
    '完整私有记忆',
    '完整文件',
    '完整聊天记录',
    '工具输出',
    'Tool secret',
  ]) {
    assert.ok(privacyText.includes(excludedField), `Missing privacy exclusion: ${excludedField}`);
  }
  screenshots.push(
    await setViewportAndCapture(page, 900, 'settings-routing-900.png', screenshotDirectory),
  );
  const shadowAfter = await page.evaluate(() => window.cultivation.r3.getConfig());
  assert.equal(shadowAfter.enabled, shadowBefore.enabled, 'R4 settings must not toggle R3 Shadow.');
  assert.equal((await page.evaluate(() => window.cultivation.routing.config())).cloudEnabled, true);

  const bridgeBefore = await page.evaluate(
    async (teammateIds) => {
      const api = window.cultivation;
      const profile = await api.r2.bridgeProfile();
      const availability = (await api.availability.list()).filter((item) =>
        teammateIds.includes(item.teammateId),
      );
      return { profile, availability };
    },
    [a.id, b.id],
  );
  assert.equal(bridgeBefore.profile.teammate.executorKind, 'USER_BRIDGE');
  assert.equal(bridgeBefore.profile.teammate.systemKind, 'HUMAN_BRIDGE');
  assert.equal(bridgeBefore.profile.teammate.currentRuntimeProfileId, null);
  assert.ok(
    bridgeBefore.profile.dimensions.some(
      (item) => item.dimension === 'GENERAL_REASONING' && item.enabled,
    ),
    'The packaged fixture must explicitly enable the selected Human Bridge capability.',
  );
  assert.equal(bridgeBefore.availability.length, 2);
  const humanBridgeTitle = `R4 本尊执行 UI ${runId.slice(0, 8)}`;
  const humanBridgeObjective = '请为一段通用推理任务给出简明分析与结论。';
  const beforeMissingCapability = await page.evaluate(async () => ({
    missions: await window.cultivation.missions.list(),
    receipts: await window.cultivation.routing.receipts(),
  }));

  await navigateUi(page, '历练 Missions');
  await page
    .locator('.mission-list-card header')
    .getByRole('button', { name: '发起历练', exact: true })
    .click();
  await page.getByRole('heading', { name: '发起历练', exact: true }).waitFor();
  await page.getByLabel('分配方式').selectOption('HUMAN_BRIDGE');
  assert.equal(await page.getByLabel('分配方式').inputValue(), 'HUMAN_BRIDGE');
  assert.equal(await page.getByLabel('选择道友', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('参与队伍', { exact: true }).count(), 0);
  assert.match(await page.locator('[aria-label="本尊执行者"]').innerText(), /本尊 \/ Human Bridge/);
  await page.getByLabel('标题', { exact: true }).fill(humanBridgeTitle);
  await page.getByLabel('任务目标', { exact: true }).fill(humanBridgeObjective);
  assert.equal(await page.locator('.routing-capability-grid input:checked').count(), 0);
  assert.match(
    await page.getByRole('status').filter({ hasText: '尚未选择必需能力' }).innerText(),
    /不能创建/,
  );
  assert.equal(
    await page.getByRole('button', { name: '分配并创建草稿', exact: true }).isDisabled(),
    true,
  );
  const afterMissingCapability = await page.evaluate(async (title) => {
    const missions = await window.cultivation.missions.list();
    const receipts = await window.cultivation.routing.receipts();
    return {
      missions,
      receipts,
      missionTitleExists: missions.some((item) => item.title === title),
    };
  }, humanBridgeTitle);
  assert.equal(afterMissingCapability.missionTitleExists, false);
  assert.equal(afterMissingCapability.missions.length, beforeMissingCapability.missions.length);
  assert.deepEqual(afterMissingCapability.receipts, beforeMissingCapability.receipts);

  await page.locator('.routing-capability-grid').getByLabel('通用推理', { exact: true }).check();
  assert.equal(await page.locator('.routing-capability-grid input:checked').count(), 1);
  screenshots.push(
    await setViewportAndCapture(page, 1180, 'mission-human-bridge-1180.png', screenshotDirectory),
  );
  await page.getByRole('button', { name: '分配并创建草稿', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: '已完成执行者分配，历练草稿已创建。' })
    .waitFor({ state: 'visible', timeout: 30000 });
  const humanBridgeResult = await page.evaluate(async (title) => {
    const api = window.cultivation;
    const missionRow = (await api.missions.list()).find((item) => item.title === title);
    if (!missionRow) return null;
    const [detail, receipts] = await Promise.all([
      api.missions.detail(missionRow.id),
      api.routing.receipts(missionRow.id),
    ]);
    return { mission: detail.mission, receipts };
  }, humanBridgeTitle);
  assert.ok(humanBridgeResult, 'The explicit Human Bridge choice should create a Mission draft.');
  assert.equal(humanBridgeResult.mission.state, 'DRAFT');
  assert.equal(humanBridgeResult.mission.coordinatorTeammateId, bridgeBefore.profile.teammate.id);
  const humanBridgeReceipt = humanBridgeResult.receipts.find(
    (receipt) => receipt.outcome === 'ASSIGNED',
  );
  assert.ok(humanBridgeReceipt, 'The Human Bridge Mission should have an assigned receipt.');
  assert.equal(humanBridgeReceipt.reason, 'HUMAN_BRIDGE_SELECTED');
  assert.equal(humanBridgeReceipt.assignment?.kind, 'HUMAN_BRIDGE');
  assert.equal(
    humanBridgeReceipt.assignment?.coordinatorTeammateId,
    bridgeBefore.profile.teammate.id,
  );
  assert.deepEqual(
    humanBridgeReceipt.demand.map((item) => item.dimension),
    ['GENERAL_REASONING'],
    'The explicit Human Bridge request must preserve the capability chosen by the user.',
  );
  assert.equal(humanBridgeReceipt.candidates.length, 0);
  assert.equal(humanBridgeReceipt.decisionSignals.length, 0);
  const bridgeAfter = await page.evaluate(
    async (teammateIds) => ({
      profile: await window.cultivation.r2.bridgeProfile(),
      availability: (await window.cultivation.availability.list()).filter((item) =>
        teammateIds.includes(item.teammateId),
      ),
    }),
    [a.id, b.id],
  );
  assert.deepEqual(
    bridgeAfter.availability,
    bridgeBefore.availability,
    'An explicit Human Bridge assignment must not probe or update ordinary model availability.',
  );
  assert.equal(bridgeAfter.profile.teammate.currentRuntimeProfileId, null);

  const finalMission = await page.evaluate(
    (missionId) => window.cultivation.missions.detail(missionId),
    routeResult.mission.id,
  );
  assert.equal(finalMission.mission.state, 'DRAFT');
  return {
    missionId: routeResult.mission.id,
    missionTitle,
    assignedTeammate: { id: assignedTeammate.id, name: assignedTeammate.name },
    unavailableTeammate,
    unavailableReason: 'EXPLICIT_TEAMMATE_UNAVAILABLE',
    capabilityDefaultsChecked: selectedCapabilities,
    routingCloudEnabled: routingConfig.cloudEnabled,
    shadowEnabledBefore: shadowBefore.enabled,
    shadowEnabledAfter: shadowAfter.enabled,
    humanBridgeCreation: { mission: humanBridgeResult.mission, receipt: humanBridgeReceipt },
    screenshots,
  };
}
