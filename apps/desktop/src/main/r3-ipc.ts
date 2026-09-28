import { clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { DecisionReceipt } from '@cultivation/domain';
import type { R3ShadowObservationView } from '../preload/preload.js';
import { R3DecisionConfigController } from './r3-config.js';

interface StoredReceipt extends DecisionReceipt {
  actualAction: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
}

interface StoredAttempt {
  id: string;
  missionId: string | null;
  runId: string | null;
  decisionType: string;
  provider: 'TYPESAFE';
  model: 'jev-1.13.0';
  status: 'SUCCESS' | 'ERROR' | 'SKIPPED';
  receiptId: string | null;
  actualAction: string | null;
  errorCode: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  createdAt: string;
}

export interface R3ObservationStore {
  listDecisionReceipts(missionId?: string): StoredReceipt[];
  listShadowAttempts(missionId?: string): StoredAttempt[];
  getShadowPolicyConfig(): { questionVersion: string; policyVersion: string };
}

function overallConfidence(receipt: StoredReceipt): number | null {
  if (receipt.decisionType === 'TASK_CAPABILITY') return null;
  const values = Object.values(receipt.confidenceJson).filter(
    (value): value is number => typeof value === 'number' && value >= 0 && value <= 1,
  );
  return values.length === 1 ? (values[0] ?? null) : null;
}

export function registerR3Ipc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  config: R3DecisionConfigController,
  store: R3ObservationStore,
): void {
  const register = (
    channel: string,
    handler: (args: unknown[]) => unknown | Promise<unknown>,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      return handler(args);
    });
  };
  const noArgs = (args: unknown[]): void => {
    if (args.length !== 0) throw new Error('请求参数无效');
  };
  register('r3:getConfig', (args) => {
    noArgs(args);
    return config.getConfigView();
  });
  register('r3:saveKeyFromClipboard', async (args) => {
    noArgs(args);
    const key = await clipboard.readText();
    clipboard.clear();
    return config.saveKey(key);
  });
  register('r3:setEnabled', (args) => {
    if (args.length !== 1) throw new Error('请求参数无效');
    return config.setEnabled(z.boolean().parse(args[0]));
  });
  register('r3:testConnection', (args) => {
    noArgs(args);
    return config.testConnection();
  });
  register('r3:listObservations', (args): R3ShadowObservationView[] => {
    if (args.length !== 1) throw new Error('请求参数无效');
    const missionId = z.string().min(1).max(128).optional().parse(args[0]);
    const policy = store.getShadowPolicyConfig();
    const receiptById = new Map(
      store.listDecisionReceipts(missionId).map((receipt) => [receipt.id, receipt]),
    );
    return store
      .listShadowAttempts(missionId)
      .slice(0, 100)
      .map((attempt) => {
        const receipt = attempt.receiptId ? receiptById.get(attempt.receiptId) : undefined;
        return {
          id: attempt.id,
          missionId: attempt.missionId,
          runId: attempt.runId,
          decisionType: attempt.decisionType,
          recommendation: receipt?.selectedAction ?? null,
          actualAction: receipt?.actualAction ?? attempt.actualAction,
          confidence: receipt ? overallConfidence(receipt) : null,
          provider: attempt.provider,
          model: receipt?.model ?? attempt.model,
          questionVersion: receipt?.questionVersion ?? policy.questionVersion,
          policyVersion: receipt?.policyVersion ?? policy.policyVersion,
          latencyMs: attempt.latencyMs,
          inputTokens: attempt.inputTokens,
          status: attempt.status,
          errorCode: attempt.errorCode,
          createdAt: attempt.createdAt,
        };
      });
  });
}
