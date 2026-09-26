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

  const gate2 = await page.evaluate(
    async ({
      teammateId,
      conversationId,
      otherTeammateId,
      otherConversationId,
      runtimeA,
      nonce,
    }) => {
      const api = window.cultivation;
      const inspectMarker = '__GATE2_PROMPT_INSPECT__';
      const stream = (targetTeammateId, targetConversationId, text) =>
        new Promise((resolve, reject) => {
          const requestId = window.crypto.randomUUID();
          const events = [];
          const timer = window.setTimeout(() => {
            off();
            reject(new Error('Gate 2 stream timeout'));
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
          api.chat
            .send({
              requestId,
              teammateId: targetTeammateId,
              conversationId: targetConversationId,
              text,
            })
            .catch((error) => {
              window.clearTimeout(timer);
              off();
              reject(error);
            });
        });
      const send = async (targetTeammateId, targetConversationId, text) => {
        const events = await stream(targetTeammateId, targetConversationId, text);
        const done = events.find((event) => event.type === 'done');
        if (!done || done.type !== 'done') throw new Error('Gate 2 chat did not complete');
        return done.assistantMessage;
      };

      const memoryA = await api.memories.create({
        teammateId,
        memoryType: 'FACT',
        content: `A_ONLY_MEMORY_${nonce}`,
        summary: `${inspectMarker} A_SCOPE_${nonce}`,
        importance: 0.9,
      });
      const memoryB = await api.memories.create({
        teammateId: otherTeammateId,
        memoryType: 'FACT',
        content: `B_ONLY_MEMORY_${nonce}`,
        summary: `${inspectMarker} B_SCOPE_${nonce}`,
        importance: 0.9,
      });
      const archiveTarget = await api.memories.create({
        teammateId,
        memoryType: 'OBSERVATION',
        content: `EDIT_THEN_ARCHIVE_${nonce}`,
        summary: 'temporary',
        importance: 0.2,
      });
      const edited = await api.memories.update({
        teammateId,
        id: archiveTarget.id,
        memoryType: 'OBSERVATION',
        content: `EDITED_THEN_ARCHIVE_${nonce}`,
        summary: 'edited before archive',
        importance: 0.3,
      });
      const archived = await api.memories.archive({ teammateId, id: edited.id });

      const acceptedEvidence = `ACCEPTED_EVIDENCE_${nonce} ${inspectMarker}`;
      await send(teammateId, conversationId, acceptedEvidence);
      const acceptedUser = (await api.chat.listMessages({ teammateId, conversationId })).find(
        (message) => message.role === 'USER' && message.content === acceptedEvidence,
      );
      if (!acceptedUser) throw new Error('Accepted candidate evidence was not persisted');
      const acceptedProposals = await api.memories.proposeFromMessage({
        teammateId,
        conversationId,
        messageId: acceptedUser.id,
      });
      const accepted = await api.memories.accept({
        teammateId,
        id: acceptedProposals[0].id,
        edits: {
          content: `ACCEPTED_MEMORY_${nonce}`,
          summary: `${inspectMarker} A_ACCEPTED_${nonce}`,
          importance: 0.95,
        },
      });
      const rejectedEvidence = `REJECTED_EVIDENCE_${nonce} ${inspectMarker}`;
      await send(teammateId, conversationId, rejectedEvidence);
      const rejectedUser = (await api.chat.listMessages({ teammateId, conversationId })).find(
        (message) => message.role === 'USER' && message.content === rejectedEvidence,
      );
      if (!rejectedUser) throw new Error('Rejected candidate evidence was not persisted');
      const rejectedProposals = await api.memories.proposeFromMessage({
        teammateId,
        conversationId,
        messageId: rejectedUser.id,
      });
      const rejected = await api.memories.reject({
        teammateId,
        id: rejectedProposals[0].id,
      });
      const crossOwnerArchiveRejected = await api.memories
        .archive({ teammateId, id: memoryB.id })
        .then(
          () => false,
          () => true,
        );
      const crossConversationExtractionRejected = await api.memories
        .proposeFromMessage({
          teammateId,
          conversationId: otherConversationId,
          messageId: 'foreign-message',
        })
        .then(
          () => false,
          () => true,
        );

      const skillA = await api.skills.create({
        name: `Smoke Skill A ${nonce}`,
        description: 'Enabled only for Teammate A',
        instructions: 'initial revision',
        tags: ['smoke'],
      });
      const updatedSkillA = await api.skills.update({
        id: skillA.id,
        name: skillA.name,
        description: skillA.description,
        instructions: `A_ONLY_SKILL_${nonce}`,
        tags: skillA.tags,
      });
      const skillRevisions = await api.skills.listRevisions(skillA.id);
      await api.skills.assign({ teammateId, skillId: updatedSkillA.id });
      const assignmentA = await api.skills.setEnabled({
        teammateId,
        skillId: updatedSkillA.id,
        enabled: true,
      });
      const disabledSkill = await api.skills.create({
        name: `Smoke Disabled Skill ${nonce}`,
        description: 'Assigned but disabled',
        instructions: `DISABLED_SKILL_${nonce}`,
        tags: [],
      });
      await api.skills.assign({ teammateId, skillId: disabledSkill.id });
      const disabledAssignment = await api.skills.setEnabled({
        teammateId,
        skillId: disabledSkill.id,
        enabled: false,
      });
      const skillB = await api.skills.create({
        name: `Smoke Skill B ${nonce}`,
        description: 'Enabled only for Teammate B',
        instructions: `B_ONLY_SKILL_${nonce}`,
        tags: ['smoke'],
      });
      await api.skills.assign({ teammateId: otherTeammateId, skillId: skillB.id });
      const assignmentB = await api.skills.setEnabled({
        teammateId: otherTeammateId,
        skillId: skillB.id,
        enabled: true,
      });
      const archivedSkill = await api.skills.create({
        name: `Smoke Archived Skill ${nonce}`,
        description: 'Archive lifecycle coverage',
        instructions: 'Never injected',
        tags: [],
      });
      const archivedSkillResult = await api.skills.archive(archivedSkill.id);

      const embeddingBefore = await api.embedding.getConfig();
      const embeddingConfig = await api.embedding.setConfig(runtimeA);
      const indexedA = await api.embedding.reindex(teammateId);
      const indexedB = await api.embedding.reindex(otherTeammateId);
      const oldMessages = await api.chat.listMessages({ teammateId, conversationId });
      const oldMessageIds = oldMessages.map((message) => message.id);
      const switched = await api.teammates.switchRuntime({
        teammateId,
        runtimeProfileId: runtimeA,
      });
      const inspectionA = (await send(teammateId, conversationId, inspectMarker)).content;
      const inspectionB = (await send(otherTeammateId, otherConversationId, inspectMarker)).content;
      return {
        inspectMarker,
        memoryAId: memoryA.id,
        memoryBId: memoryB.id,
        acceptedMemoryId: accepted.id,
        rejectedMemoryId: rejected.id,
        archivedMemoryId: archived.id,
        editedMemory: edited,
        allA: await api.memories.list(teammateId),
        allB: await api.memories.list(otherTeammateId),
        activeA: await api.memories.list(teammateId, 'ACTIVE'),
        activeB: await api.memories.list(otherTeammateId, 'ACTIVE'),
        acceptedProposal: acceptedProposals[0],
        accepted,
        rejectedProposal: rejectedProposals[0],
        rejected,
        archived,
        crossOwnerArchiveRejected,
        crossConversationExtractionRejected,
        skillA: updatedSkillA,
        skillB,
        skillRevisions,
        assignmentA,
        disabledAssignment,
        assignmentB,
        archivedSkillResult,
        embeddingBefore,
        embeddingConfig,
        indexedA,
        indexedB,
        switchedId: switched.id,
        switchedRuntimeId: switched.currentRuntimeProfileId,
        oldMessageIds,
        messagesAfterSwitch: await api.chat.listMessages({ teammateId, conversationId }),
        assignmentsAfterSwitch: await api.skills.listAssignments(teammateId),
        memoriesAfterSwitch: await api.memories.list(teammateId),
        inspectionA,
        inspectionB,
        usage: await api.usage.list(teammateId),
      };
    },
    {
      teammateId: result.teammateId,
      conversationId: result.conversationId,
      otherTeammateId: result.otherTeammateId,
      otherConversationId: result.otherConversationId,
      runtimeA: result.runtimeA,
      nonce: randomUUID(),
    },
  );
  assert.equal(gate2.accepted.status, 'ACTIVE');
  assert.ok(gate2.accepted.confirmedAt);
  assert.equal(gate2.accepted.sourceType, 'CHAT_EXTRACTION');
  assert.equal(gate2.accepted.sourceConversationId, result.conversationId);
  assert.ok(gate2.accepted.sourceMessageId);
  assert.equal(gate2.acceptedProposal.status, 'PROPOSED');
  assert.equal(gate2.rejectedProposal.status, 'PROPOSED');
  assert.equal(gate2.rejected.status, 'REJECTED');
  assert.equal(gate2.archived.status, 'ARCHIVED');
  assert.ok(gate2.editedMemory.content.startsWith('EDITED_THEN_ARCHIVE_'));
  assert.equal(gate2.crossOwnerArchiveRejected, true);
  assert.equal(gate2.crossConversationExtractionRejected, true);
  assert.ok(gate2.allA.every((memory) => memory.ownerId === result.teammateId));
  assert.ok(gate2.allB.every((memory) => memory.ownerId === result.otherTeammateId));
  assert.ok(gate2.activeA.some((memory) => memory.id === gate2.memoryAId));
  assert.ok(gate2.activeA.some((memory) => memory.id === gate2.acceptedMemoryId));
  assert.equal(gate2.activeA.find((memory) => memory.id === gate2.memoryAId).sourceType, 'MANUAL');
  assert.ok(!gate2.activeA.some((memory) => memory.id === gate2.rejectedMemoryId));
  assert.ok(!gate2.activeA.some((memory) => memory.id === gate2.archivedMemoryId));
  assert.ok(gate2.activeB.some((memory) => memory.id === gate2.memoryBId));
  assert.equal(gate2.skillA.version, '1.0.1');
  assert.deepEqual(
    gate2.skillRevisions.map((revision) => revision.version),
    ['1.0.0', '1.0.1'],
  );
  assert.equal(gate2.assignmentA.enabled, true);
  assert.equal(gate2.disabledAssignment.enabled, false);
  assert.equal(gate2.assignmentB.enabled, true);
  assert.equal(gate2.archivedSkillResult.status, 'ARCHIVED');
  assert.equal(gate2.embeddingBefore.available, true);
  assert.equal(gate2.embeddingConfig.runtimeProfileId, result.runtimeA);
  assert.equal(gate2.indexedA.total, 2);
  assert.equal(gate2.indexedA.indexed, 2);
  assert.equal(gate2.indexedB.total, 1);
  assert.equal(gate2.indexedB.indexed, 1);
  assert.equal(gate2.switchedId, result.teammateId);
  assert.equal(gate2.switchedRuntimeId, result.runtimeA);
  assert.ok(
    gate2.oldMessageIds.every((id) =>
      gate2.messagesAfterSwitch.some((message) => message.id === id),
    ),
  );
  assert.ok(
    gate2.messagesAfterSwitch.every((message) => message.conversationId === result.conversationId),
  );
  assert.ok(gate2.memoriesAfterSwitch.some((memory) => memory.id === gate2.memoryAId));
  assert.ok(
    gate2.assignmentsAfterSwitch.some(
      (assignment) => assignment.skillId === gate2.skillA.id && assignment.enabled,
    ),
  );
  assert.ok(gate2.inspectionA.includes('A_SCOPE_'));
  assert.ok(gate2.inspectionA.includes('A_ACCEPTED_'));
  assert.ok(gate2.inspectionA.includes('A_ONLY_SKILL_'));
  assert.ok(!gate2.inspectionA.includes('B_SCOPE_'));
  assert.ok(!gate2.inspectionA.includes('B_ONLY_SKILL_'));
  assert.ok(!gate2.inspectionA.includes('REJECTED_EVIDENCE_'));
  assert.ok(!gate2.inspectionA.includes('DISABLED_SKILL_'));
  assert.ok(gate2.inspectionB.includes('B_SCOPE_'));
  assert.ok(gate2.inspectionB.includes('B_ONLY_SKILL_'));
  assert.ok(!gate2.inspectionB.includes('A_SCOPE_'));
  assert.ok(!gate2.inspectionB.includes('A_ACCEPTED_'));
  assert.ok(!gate2.inspectionB.includes('A_ONLY_SKILL_'));
  assert.ok(
    gate2.usage.some((item) => item.providerMetadata?.purpose === 'MEMORY_CANDIDATE_EXTRACTION'),
  );
  assert.ok(
    gate2.usage.some((item) => item.providerMetadata?.purpose === 'MEMORY_EMBEDDING_QUERY'),
  );
  const extractionUsage = gate2.usage.find(
    (item) => item.providerMetadata?.purpose === 'MEMORY_CANDIDATE_EXTRACTION',
  );
  assert.equal(extractionUsage.runtimeProfileId, result.runtimeB);
  assert.equal(extractionUsage.provider, result.providerB);
  const embeddingQueryUsage = gate2.usage.find(
    (item) => item.providerMetadata?.purpose === 'MEMORY_EMBEDDING_QUERY',
  );
  assert.equal(embeddingQueryUsage.runtimeProfileId, result.runtimeA);
  assert.equal(embeddingQueryUsage.provider, result.providerA);
  assert.ok(embeddingQueryUsage.inputTokens !== null);
  assert.equal(embeddingQueryUsage.outputTokens, null);

  const db = new Database(join(userData, 'data', 'cultivation.sqlite'), { readonly: true });
  try {
    const row = db
      .prepare('SELECT ciphertext FROM provider_credentials WHERE id = ?')
      .get(result.credentialId);
    assert.ok(row && row.ciphertext instanceof Buffer);
    assert.ok(!row.ciphertext.includes(Buffer.from(key)));
    const vectorRows = db
      .prepare(
        `SELECT memory_id, runtime_profile_id, model_id, dimension, length(embedding) AS bytes
         FROM memory_embeddings WHERE memory_id IN (?, ?, ?, ?) ORDER BY memory_id`,
      )
      .all(gate2.memoryAId, gate2.memoryBId, gate2.acceptedMemoryId, gate2.rejectedMemoryId);
    const vectorIds = vectorRows.map((vectorRow) => vectorRow.memory_id);
    assert.ok(vectorIds.includes(gate2.memoryAId));
    assert.ok(vectorIds.includes(gate2.memoryBId));
    assert.ok(vectorIds.includes(gate2.acceptedMemoryId));
    assert.ok(!vectorIds.includes(gate2.rejectedMemoryId));
    assert.ok(
      vectorRows.every(
        (vectorRow) =>
          vectorRow.runtime_profile_id === result.runtimeA &&
          vectorRow.model_id === 'smoke-model-a' &&
          vectorRow.dimension === 16 &&
          vectorRow.bytes === 64,
      ),
    );
    const embeddingSetting = db
      .prepare('SELECT runtime_profile_id FROM embedding_settings WHERE id = 1')
      .get();
    assert.equal(embeddingSetting.runtime_profile_id, result.runtimeA);
  } finally {
    db.close();
  }
  console.log(
    'GATE1_PACKAGED_SMOKE_OK navigation=9 ipc=ok native_sqlite=ok secret=encrypted chat=streamed runtime_migration=ok usage=ok',
  );
  console.log(
    'GATE2_PACKAGED_SMOKE_OK memory_scope=ok review=accept_reject skill_assignment=ok prompt_scope=ok sqlite_vec=loaded_and_queried runtime_migration=ok',
  );
} finally {
  await app.close();
}

await import('./smoke-gate3-packaged.mjs');
