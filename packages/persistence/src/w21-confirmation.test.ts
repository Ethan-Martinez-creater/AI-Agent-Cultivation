import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations, runMigrations, W1WorkflowRepository } from './index.js';
import { WorkflowService } from '@cultivation/application';
import type { WorkflowMissionPort } from '@cultivation/application';
import type { WorkflowVersion } from '@cultivation/domain';

describe('durable final user confirmation', () => {
  it('cannot complete by direct state write or restart, then explicitly confirms exactly once', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    try {
      const store = new W1WorkflowRepository(db);
      const version = {
        definition: {
          id: 'confirmation-test',
          name: '确认',
          description: '',
          category: 'TEST_ONLY',
          source: 'USER',
        },
        version: 1,
        entryStepId: 'confirm',
        createdAt: '2026-10-03T00:00:00.000Z',
        referenceBasis: [],
        steps: [
          {
            id: 'confirm',
            title: '确认交付',
            objective: '确认后交付，不发布',
            type: 'DECISION',
            routing: {},
            inputs: [],
            outputs: [],
            confirmationRequired: true,
            maxAttempts: 1,
            exitCondition: 'VALID_OUTPUTS',
            effectType: 'NONE',
          },
        ],
        edges: [
          {
            id: 'confirmed',
            fromStepId: 'confirm',
            toStepId: null,
            branch: 'CONFIRMED',
            condition: { type: 'ALWAYS' },
          },
        ],
      } as WorkflowVersion;
      store.publishVersion(version);
      const forbidden = new Proxy(
        {},
        {
          get() {
            throw new Error('Confirmation cannot execute models or tools');
          },
        },
      ) as WorkflowMissionPort;
      let service = new WorkflowService(store, forbidden);
      const id = service.createRun({ definitionId: version.definition.id, version: 1 }).run.id;
      const waiting = await service.advance(id);
      expect(waiting.run.state).toBe('WAITING');
      expect(waiting.run.waitReason).toBe('USER_CONFIRMATION');
      expect(() =>
        db
          .prepare("UPDATE workflow_step_runs SET state='COMPLETED' WHERE id=?")
          .run(waiting.steps[0]!.id),
      ).toThrow(/confirmation|Decision fact and checkpoint/i);
      expect(() =>
        store.appendEvent({
          id: 'incomplete-confirmation',
          workflowRunId: id,
          stepRunId: waiting.steps[0]!.id,
          type: 'workflow.user_confirmed',
          payload: { stepRunId: waiting.steps[0]!.id },
          createdAt: '2026-10-03T00:00:01.000Z',
        }),
      ).toThrow(/confirmation/i);
      service = new WorkflowService(new W1WorkflowRepository(db), forbidden);
      await service.recover();
      expect((await service.advance(id)).run.state).toBe('WAITING');
      expect(service.confirm(id).run.state).toBe('COMPLETED');
      service.confirm(id);
      await service.recover();
      const final = service.detail(id);
      expect(final.events.filter((event) => event.type === 'workflow.user_confirmed')).toHaveLength(
        1,
      );
      expect(final.events.some((event) => /upload|publish/.test(event.type))).toBe(false);
    } finally {
      db.close();
    }
  });
});
