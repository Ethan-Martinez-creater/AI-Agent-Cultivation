import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  openDatabase,
  Gate1SqliteRepository,
  Gate3SqliteRepository,
  Gate4SqliteRepository,
  migrations,
  runMigrations,
} from '@cultivation/persistence';
import Database from 'better-sqlite3';
import { Gate1Service } from '@cultivation/application/gate1-service';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import { PermissionEngine } from '@cultivation/application/permission-engine';
import { h3GenerationFoundation } from './g2-foundation.js';
import { startH3Fixture } from '../../../../scripts/fixtures/g2-h3-http.mjs';
const secrets = {
  encrypt: async (s: string) => new TextEncoder().encode(s),
  decrypt: async (s: Uint8Array) => new TextDecoder().decode(s),
};
async function harness() {
  const http = await startH3Fixture();
  const root = join(process.cwd(), '.test-data', `g2-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  let db = openDatabase(join(root, 'data.sqlite'));
  const compose = () => {
    const store = new Gate1SqliteRepository(db);
    const missions = new Gate3SqliteRepository(db);
    const tools = new Gate4SqliteRepository(db);
    const generation = h3GenerationFoundation({
      db,
      userData: root,
      store,
      missions,
      tools,
      permission: new PermissionEngine(missions),
      secrets,
    });
    const gate1 = new Gate1Service(
      store,
      secrets,
      new FakeModelGateway(),
      undefined,
      generation.gateway,
    );
    return { store, generation, gate1 };
  };
  let h = compose();
  const provider = h.gate1.createProvider({
    name: '视频生成服务',
    kind: 'GENERATION_HTTP',
    adapterId: 'H3',
    baseUrl: http.baseUrl,
  });
  const runtime = h.gate1.createRuntimeProfile({
    name: '视频模型',
    providerId: provider.id,
    modelId: 'minimax-h3',
    credentialId: null,
    executionProtocol: 'GENERATION',
  });
  const teammate = await h.gate1.createTeammate({
    name: '映川',
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    currentRuntimeProfileId: runtime.id,
  });
  const conversation = h.generation.chat.createConversation({ teammateId: teammate.id });
  return {
    root,
    http,
    provider,
    teammate,
    runtime,
    conversation,
    get h() {
      return h;
    },
    get db() {
      return db;
    },
    restart() {
      db.close();
      db = openDatabase(join(root, 'data.sqlite'));
      h = compose();
    },
    async close() {
      db.close();
      await http.close();
    },
  };
}
async function complete(x: Awaited<ReturnType<typeof harness>>) {
  let d = x.h.generation.chat.detail({
    teammateId: x.teammate.id,
    conversationId: x.conversation.id,
  });
  for (let n = 0; n < 4 && !d.entries.every((e) => e.job?.state === 'COMPLETED'); n++)
    d = await x.h.generation.chat.refresh({
      teammateId: x.teammate.id,
      conversationId: x.conversation.id,
    });
  return d;
}
describe('G2 trusted H3 Main integration', () => {
  it('accepts the real MP4 fixture through frozen bounded media validation', async () => {
    const x = await harness();
    try {
      const file = join(x.root, 'reference.mp4');
      writeFileSync(file, x.http.video);
      await x.h.generation.media.importSelectedFile(file);
    } finally {
      await x.close();
    }
  });
  it('creates a sealed generation service identity and rejects protocol/adapter changes', async () => {
    const x = await harness();
    try {
      const binding = x.h.store.getModelBinding(x.teammate.id)!;
      expect(binding.providerKind).toBe('GENERATION_HTTP');
      expect(binding.adapterId).toBe('H3');
      expect(binding.credentialId).toBeNull();
      expect(() =>
        x.db.prepare('UPDATE providers SET adapter_id=NULL WHERE id=?').run(x.provider.id),
      ).toThrow();
      expect(() =>
        x.db
          .prepare("UPDATE runtime_profiles SET execution_protocol='LANGUAGE' WHERE id=?")
          .run(binding.runtimeProfileId),
      ).toThrow();
      expect(() =>
        x.h.gate1.createRuntimeProfile({
          name: '错误协议',
          providerId: x.provider.id,
          modelId: 'minimax-h3',
          credentialId: null,
        }),
      ).toThrow();
      expect(x.h.generation.availability.get(x.teammate.id)?.status).toBe('UNKNOWN');
    } finally {
      await x.close();
    }
  });
  it('persists real user message → job → safe Artifact without assistant text, secret or path', async () => {
    const x = await harness();
    try {
      await x.h.generation.chat.send({
        teammateId: x.teammate.id,
        conversationId: x.conversation.id,
        prompt: '日落下的山川',
        inputs: [],
        parameters: { duration: 5, aspect: '16:9' },
      });
      const d = await complete(x);
      expect(d.entries[0]!.job?.state, JSON.stringify(d.entries[0]!.job)).toBe('COMPLETED');
      expect(d.entries[0]!.artifacts).toHaveLength(1);
      expect(x.h.store.listMessages(x.teammate.id, x.conversation.id).map((m) => m.role)).toEqual([
        'USER',
      ]);
      expect(JSON.stringify(d)).not.toContain(x.root);
      expect(JSON.stringify(d)).not.toContain('storageKey');
      expect(x.http.facts.submissions).toBe(1);
      expect(x.http.facts.downloads).toBe(1);
      const before = JSON.stringify(d);
      x.restart();
      await x.h.generation.service.recover();
      expect(
        JSON.stringify(
          x.h.generation.chat.detail({
            teammateId: x.teammate.id,
            conversationId: x.conversation.id,
          }),
        ),
      ).toBe(before);
      expect(x.http.facts.downloads).toBe(1);
      expect(x.h.generation.availability.get(x.teammate.id)?.status).toBe('AVAILABLE');
      expect(() =>
        x.db
          .prepare("UPDATE messages SET content='changed' WHERE id=?")
          .run(d.entries[0]!.message.id),
      ).toThrow();
    } finally {
      await x.close();
    }
  });
  it('imports an explicit first frame as trusted identity and streams it through upload', async () => {
    const x = await harness();
    try {
      const file = join(x.root, 'frame.png');
      writeFileSync(file, x.http.png);
      const input = await x.h.generation.media.importSelectedFile(file);
      expect(JSON.stringify(input)).not.toContain(file);
      await x.h.generation.chat.send({
        teammateId: x.teammate.id,
        conversationId: x.conversation.id,
        prompt: '让山川缓缓出现',
        inputs: [{ artifactId: input.id, role: 'FIRST_FRAME' }],
        parameters: { duration: 5, aspect: '16:9' },
      });
      expect((await complete(x)).entries[0]!.job?.state).toBe('COMPLETED');
      expect(x.http.facts.uploads).toBe(1);
      expect((x.http.facts.requests[0]!.media as Array<{ role: string }>)[0]!.role).toBe(
        'first_frame',
      );
      expect(x.db.prepare('SELECT COUNT(*) AS n FROM generation_input_artifacts').get()).toEqual({
        n: 1,
      });
      expect(() =>
        x.db
          .prepare('UPDATE generation_input_artifacts SET content_hash=? WHERE id=?')
          .run('0'.repeat(64), input.id),
      ).toThrow();
    } finally {
      await x.close();
    }
  });
  it('UNKNOWN submission retains provider fact and never replays after restart', async () => {
    const x = await harness();
    try {
      x.http.mode.uncertain = true;
      await x.h.generation.chat.send({
        teammateId: x.teammate.id,
        conversationId: x.conversation.id,
        prompt: '未知提交',
        inputs: [],
        parameters: { duration: 5, aspect: '16:9' },
      });
      expect(
        x.h.generation.chat.detail({ teammateId: x.teammate.id, conversationId: x.conversation.id })
          .entries[0]!.job?.state,
      ).toBe('UNKNOWN');
      const submissions = x.http.facts.submissions;
      x.restart();
      await x.h.generation.service.recover();
      await x.h.generation.chat.refresh({
        teammateId: x.teammate.id,
        conversationId: x.conversation.id,
      });
      expect(x.http.facts.submissions).toBe(submissions);
    } finally {
      await x.close();
    }
  });
  it('recovers queued original providerJobId and partial download without duplicate generation', async () => {
    const x = await harness();
    try {
      x.http.mode.hold = true;
      await x.h.generation.chat.send({
        teammateId: x.teammate.id,
        conversationId: x.conversation.id,
        prompt: '恢复视频',
        inputs: [],
        parameters: { duration: 5, aspect: '16:9' },
      });
      const original = x.h.generation.chat.detail({
        teammateId: x.teammate.id,
        conversationId: x.conversation.id,
      }).entries[0]!.job!;
      x.restart();
      x.http.mode.hold = false;
      x.http.mode.downloadInterrupted = true;
      await x.h.generation.chat.refresh({
        teammateId: x.teammate.id,
        conversationId: x.conversation.id,
      });
      expect(
        x.h.generation.chat.detail({ teammateId: x.teammate.id, conversationId: x.conversation.id })
          .entries[0]!.artifacts,
      ).toHaveLength(0);
      x.restart();
      const done = await complete(x);
      expect(done.entries[0]!.job?.state).toBe('COMPLETED');
      expect(done.entries[0]!.job?.providerJobId).toBe(original.providerJobId);
      expect(x.http.facts.submissions).toBe(1);
      expect(done.entries[0]!.artifacts[0]!.contentHash).toBe(
        createHash('sha256').update(x.http.video).digest('hex'),
      );
    } finally {
      await x.close();
    }
  });
  it('offline explicit selection is typed unavailable with zero job creation and no reroute', async () => {
    const x = await harness();
    try {
      x.http.mode.offline = true;
      await x.h.generation.availability.recheck(x.teammate.id);
      expect(x.h.generation.availability.get(x.teammate.id)?.status).toBe('UNAVAILABLE');
      await expect(
        x.h.generation.chat.send({
          teammateId: x.teammate.id,
          conversationId: x.conversation.id,
          prompt: '不应执行',
          inputs: [],
          parameters: { duration: 5 },
        }),
      ).rejects.toThrow();
      expect(x.http.facts.submissions).toBe(0);
      expect(x.h.generation.service.list()).toHaveLength(0);
    } finally {
      await x.close();
    }
  });
  it('verified cached output survives registration crash with zero repeat HTTP download', async () => {
    const x = await harness();
    try {
      await x.h.generation.chat.send({
        teammateId: x.teammate.id,
        conversationId: x.conversation.id,
        prompt: '已完成缓存',
        inputs: [],
        parameters: { duration: 5, aspect: '16:9' },
      });
      vi.spyOn(x.h.generation.repository, 'registerOutput').mockImplementationOnce(() => {
        throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' });
      });
      await x.h.generation.chat.refresh({
        teammateId: x.teammate.id,
        conversationId: x.conversation.id,
      });
      expect(x.http.facts.downloads).toBe(1);
      expect(x.h.generation.service.list()[0]!.state).not.toBe('COMPLETED');
      x.restart();
      expect((await complete(x)).entries[0]!.job?.state).toBe('COMPLETED');
      expect(x.http.facts.downloads).toBe(1);
      expect(x.http.facts.submissions).toBe(1);
    } finally {
      await x.close();
    }
  });
  it('migration 27→28 preserves existing availability and foreign keys', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=ON');
      runMigrations(
        db,
        migrations.filter((m) => m.version <= 27),
      );
      runMigrations(db, migrations);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()).toEqual({
        n: 28,
      });
    } finally {
      db.close();
    }
  });
});
