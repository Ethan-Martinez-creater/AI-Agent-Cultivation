import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  databasePath,
  Gate1SqliteRepository,
  migrations,
  openDatabase,
  runMigrations,
} from './index.js';

describe('SQLite bootstrap', () => {
  it('places data beneath userData', () => {
    expect(databasePath('E:/example-user-data').replaceAll('\\', '/')).toBe(
      'E:/example-user-data/data/cultivation.sqlite',
    );
  });

  it('migrates fresh and reopened databases with WAL and foreign keys', () => {
    const directory = join(
      process.cwd(),
      'packages',
      'persistence',
      '.test-data',
      `migration-${crypto.randomUUID()}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = databasePath(directory);
    let db = openDatabase(path);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(() =>
      db
        .prepare(
          `INSERT INTO runtime_profiles
      (id, name, provider_id, model_id, created_at, updated_at) VALUES
      ('r1', 'Test', 'missing-provider', 'fake', 'now', 'now')`,
        )
        .run(),
    ).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
      count: 2,
    });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
      .all() as { name: string }[];
    for (const name of [
      'app_meta',
      'providers',
      'provider_credentials',
      'runtime_profiles',
      'teammates',
      'conversations',
      'memories',
      'memory_fts',
      'skills',
      'teammate_skills',
      'tools',
      'mcp_servers',
      'teammate_tool_grants',
      'parties',
      'party_members',
      'missions',
      'mission_runs',
      'mission_participants',
      'messages',
      'legacy_unscoped_messages',
      'mission_events',
      'approval_requests',
      'permission_rules',
      'collaboration_requests',
      'audit_events',
      'usage_records',
      'experience_events',
      'capability_profiles',
    ]) {
      expect(tables.some((table) => table.name === name)).toBe(true);
    }
    const appendOnlyTriggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'mission_events'",
      )
      .all() as { name: string }[];
    expect(appendOnlyTriggers.map((row) => row.name)).toEqual(
      expect.arrayContaining(['mission_events_no_update', 'mission_events_no_delete']),
    );
    runMigrations(db, migrations);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
      count: 2,
    });
    db.close();
    db = openDatabase(path);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
      count: 2,
    });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('upgrades Gate 0 data without binding Mission messages to chat conversations', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, [migrations[0]!]);
    db.prepare(
      `INSERT INTO providers (id, name, kind, created_at, updated_at)
       VALUES ('provider-1', 'OpenAI', 'OPENAI', 'created', 'updated')`,
    ).run();
    db.prepare(
      `INSERT INTO runtime_profiles
        (id, name, provider_id, model_id, created_at, updated_at)
       VALUES ('runtime-1', 'Runtime', 'provider-1', 'model-1', 'created', 'updated')`,
    ).run();
    db.prepare(
      `INSERT INTO teammates (id, name, created_at, updated_at)
       VALUES ('teammate-1', 'Test', 'created', 'updated')`,
    ).run();
    db.prepare(
      `INSERT INTO missions
        (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
         mode, created_at, updated_at)
       VALUES ('mission-1', 'Mission', 'Preserve it', 'USER', 'user-1', 'teammate-1',
         'SOLO', 'created', 'updated')`,
    ).run();
    db.prepare(
      `INSERT INTO messages
        (id, mission_id, conversation_id, actor_type, actor_id, role, content, created_at)
       VALUES
         ('mission-message', 'mission-1', 'mission-thread', 'TEAMMATE', 'teammate-1',
           'ASSISTANT', 'mission history', 'created'),
         ('unscoped-message', NULL, 'legacy-thread', 'USER', 'user-1', 'USER',
           'legacy unscoped history', 'created')`,
    ).run();
    db.prepare(
      `INSERT INTO usage_records
        (id, teammate_id, runtime_profile_id, provider, model, input_tokens,
         output_tokens, created_at)
       VALUES ('usage-1', 'teammate-1', 'runtime-1', 'OPENAI', 'model-1', 4, 7, 'created')`,
    ).run();

    runMigrations(db, migrations);

    expect(
      db.prepare('SELECT id, mission_id, conversation_id, teammate_id FROM messages').all(),
    ).toEqual([
      {
        id: 'mission-message',
        mission_id: 'mission-1',
        conversation_id: 'mission-thread',
        teammate_id: null,
      },
    ]);
    expect(db.prepare('SELECT id, content FROM legacy_unscoped_messages').all()).toEqual([
      { id: 'unscoped-message', content: 'legacy unscoped history' },
    ]);
    expect(db.prepare('SELECT id, input_tokens, output_tokens FROM usage_records').all()).toEqual([
      { id: 'usage-1', input_tokens: 4, output_tokens: 7 },
    ]);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    db.close();
  });

  it('keeps credentials as BLOB ciphertext and exposes only metadata in credential lists', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const repository = new Gate1SqliteRepository(db);
    repository.saveProvider({
      id: 'provider-1',
      name: 'OpenAI',
      kind: 'OPENAI',
      baseUrl: null,
      enabled: true,
      createdAt: 'created',
      updatedAt: 'updated',
    });
    const ciphertext = Uint8Array.from([0x91, 0x03, 0xfa, 0x22]);
    repository.saveCredential({
      id: 'credential-1',
      providerId: 'provider-1',
      label: 'Production',
      createdAt: 'created',
      updatedAt: 'updated',
      ciphertext,
    });

    expect(
      db.prepare('SELECT typeof(ciphertext) AS type, ciphertext FROM provider_credentials').get(),
    ).toEqual({ type: 'blob', ciphertext: Buffer.from(ciphertext) });
    expect(repository.listCredentials()).toEqual([
      {
        id: 'credential-1',
        providerId: 'provider-1',
        label: 'Production',
        createdAt: 'created',
        updatedAt: 'updated',
      },
    ]);
    expect(repository.getCredential('credential-1')?.ciphertext).toEqual(ciphertext);
    db.close();
  });

  it('isolates chat messages by the conversation teammate and stores unknown usage as NULL', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const repository = new Gate1SqliteRepository(db);
    repository.saveProvider({
      id: 'provider-1',
      name: 'OpenAI',
      kind: 'OPENAI',
      baseUrl: null,
      enabled: true,
      createdAt: 'created',
      updatedAt: 'updated',
    });
    repository.saveRuntimeProfile({
      id: 'runtime-1',
      name: 'Runtime',
      providerId: 'provider-1',
      credentialId: null,
      modelId: 'model-1',
      parameters: {},
      capabilityOverrides: {},
      createdAt: 'created',
      updatedAt: 'updated',
    });
    for (const id of ['teammate-1', 'teammate-2']) {
      repository.saveTeammate({
        id,
        name: id,
        avatar: null,
        title: null,
        description: '',
        identityPrompt: '',
        behaviorPrompt: '',
        status: 'ACTIVE',
        realm: 'QI_REFINING',
        currentRuntimeProfileId: 'runtime-1',
        createdAt: 'created',
        updatedAt: 'updated',
      });
    }
    repository.saveConversation({
      id: 'conversation-1',
      teammateId: 'teammate-1',
      createdAt: 'created',
      updatedAt: 'updated',
    });
    repository.saveConversation({
      id: 'conversation-2',
      teammateId: 'teammate-2',
      createdAt: 'created',
      updatedAt: 'updated',
    });
    const message = (id: string, conversationId: string, content: string) => ({
      id,
      missionId: null,
      conversationId,
      actorType: 'USER' as const,
      actorId: 'user-1',
      role: 'USER' as const,
      content,
      createdAt: 'created',
    });
    repository.saveMessage(message('message-1', 'conversation-1', 'for teammate one'));
    repository.saveMessage(message('message-2', 'conversation-2', 'for teammate two'));

    expect(repository.getConversation('conversation-1')?.updatedAt).toBe('created');
    expect(repository.listMessages('teammate-1', 'conversation-1').map((item) => item.id)).toEqual([
      'message-1',
    ]);
    expect(repository.listMessages('teammate-2', 'conversation-2').map((item) => item.id)).toEqual([
      'message-2',
    ]);
    expect(repository.listMessages('teammate-2', 'conversation-1')).toEqual([]);
    expect(repository.listMessages('teammate-1', 'conversation-2')).toEqual([]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO messages
            (id, mission_id, conversation_id, teammate_id, actor_type, actor_id, role, content, created_at)
           VALUES ('crossed-message', NULL, 'conversation-1', 'teammate-2',
            'USER', 'user-1', 'USER', 'invalid', 'created')`,
        )
        .run(),
    ).toThrow();

    repository.saveUsage({
      id: 'usage-1',
      missionId: null,
      runId: null,
      teammateId: 'teammate-1',
      runtimeProfileId: 'runtime-1',
      provider: 'OPENAI',
      model: 'model-1',
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      providerMetadata: null,
      estimatedCost: null,
      currency: null,
      createdAt: 'created',
    });
    expect(repository.listUsage('teammate-1')).toEqual([
      {
        id: 'usage-1',
        missionId: null,
        runId: null,
        teammateId: 'teammate-1',
        runtimeProfileId: 'runtime-1',
        provider: 'OPENAI',
        model: 'model-1',
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
        providerMetadata: null,
        estimatedCost: null,
        currency: null,
        createdAt: 'created',
      },
    ]);
    db.close();
  });

  it('keeps Mission-scoped permissions separate for the same subject and capability', () => {
    const directory = join(
      process.cwd(),
      'packages',
      'persistence',
      '.test-data',
      `permission-${crypto.randomUUID()}`,
    );
    const db = openDatabase(databasePath(directory));
    try {
      db.prepare(
        `INSERT INTO teammates (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      ).run('teammate-1', '测试道友', 'now', 'now');
      const insertMission = db.prepare(
        `INSERT INTO missions
          (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
           mode, created_at, updated_at)
         VALUES (?, ?, ?, 'USER', 'user-1', 'teammate-1', 'SOLO', 'now', 'now')`,
      );
      insertMission.run('mission-1', '任务一', '验证作用域一');
      insertMission.run('mission-2', '任务二', '验证作用域二');

      const rules = [
        {
          id: 'rule-1',
          subjectType: 'USER',
          subjectId: 'user-1',
          capability: 'FILE_READ',
          resourcePattern: '/docs/*',
          decision: 'ALLOW',
          scope: 'MISSION',
          scopeId: 'mission-1',
        },
        {
          id: 'rule-2',
          subjectType: 'USER',
          subjectId: 'user-1',
          capability: 'FILE_READ',
          resourcePattern: '/docs/*',
          decision: 'DENY',
          scope: 'MISSION',
          scopeId: 'mission-2',
        },
      ] as const;
      const insertRule = db.prepare(
        `INSERT INTO permission_rules
          (id, subject_type, subject_id, capability, resource_pattern, decision, scope, scope_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const rule of rules) {
        insertRule.run(
          rule.id,
          rule.subjectType,
          rule.subjectId,
          rule.capability,
          rule.resourcePattern,
          rule.decision,
          rule.scope,
          rule.scopeId,
        );
      }

      const findForMission = db.prepare(
        `SELECT id, decision FROM permission_rules
         WHERE subject_type = 'USER' AND subject_id = 'user-1'
           AND capability = 'FILE_READ' AND resource_pattern = '/docs/*'
           AND scope = 'MISSION' AND scope_id = ?`,
      );
      expect(findForMission.all('mission-1')).toEqual([{ id: 'rule-1', decision: 'ALLOW' }]);
      expect(findForMission.all('mission-2')).toEqual([{ id: 'rule-2', decision: 'DENY' }]);
      expect(findForMission.all('mission-3')).toEqual([]);
      expect(() =>
        insertRule.run('bad', 'USER', 'user-1', 'FILE_READ', '/docs/*', 'ALLOW', 'MISSION', null),
      ).toThrow();
      expect(() =>
        insertRule.run(
          'bad',
          'USER',
          'user-1',
          'FILE_READ',
          '/docs/*',
          'ALLOW',
          'MISSION',
          'missing-mission',
        ),
      ).toThrow();
      expect(() => db.prepare('DELETE FROM missions WHERE id = ?').run('mission-1')).toThrow();
    } finally {
      db.close();
    }
  });
});
