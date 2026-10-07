import type { MissionEvent } from '@cultivation/domain';
import { parseParticipantOutcome } from '@cultivation/domain/g3-execution';
import type {
  CompletionAdvisoryContext,
  CompletionAdvisoryPort,
  CompletionAdvisoryReceipt,
} from './r5-5-completion-advisory.js';
import {
  COMPLETION_ADVISORY_POLICY,
  CompletionAdvisoryService,
} from './r5-5-completion-advisory.js';

/** Optional metadata/decision failures cannot become execution failures. */
export async function assessCompletionCandidate(
  port: CompletionAdvisoryPort,
  base: CompletionAdvisoryContext,
  load: (base: CompletionAdvisoryContext) => CompletionAdvisoryContext,
  canDispatch?: () => boolean,
): Promise<CompletionAdvisoryReceipt> {
  try {
    return await port.assess(load(base), canDispatch);
  } catch {
    const receipt = await new CompletionAdvisoryService(async () => null).assess(base);
    return { ...receipt, reason: 'INVALID_CONTEXT', errorCode: 'INVALID_REQUEST' };
  }
}

/** Only actor/run-owned public tool metadata crosses this boundary; no result bodies or resources. */
export function completionToolSummary(
  events: readonly MissionEvent[],
  runId: string,
  actorId: string,
): NonNullable<CompletionAdvisoryContext['toolUsage']> {
  const owned = events.filter((event) => event.runId === runId && event.actorId === actorId);
  const results = owned.filter((event) => event.eventType === 'tool.result');
  return {
    toolCallCount: results.length,
    successfulToolCallCount: results.filter((event) => event.payloadJson.success === true).length,
    usedToolIds: [
      ...new Set(
        results.flatMap((event) =>
          typeof event.payloadJson.toolId === 'string' ? [event.payloadJson.toolId] : [],
        ),
      ),
    ].slice(0, COMPLETION_ADVISORY_POLICY.maxToolIds),
    failureCodes: [
      ...new Set(
        results.flatMap((event) =>
          event.payloadJson.success === false &&
          typeof event.payloadJson.code === 'string' &&
          /^[A-Z][A-Z0-9_]{0,31}$/.test(event.payloadJson.code)
            ? [event.payloadJson.code]
            : [],
        ),
      ),
    ].slice(0, COMPLETION_ADVISORY_POLICY.maxFailureCodes),
    approvalOccurred: owned.some((event) => event.eventType === 'tool.approval_requested'),
  };
}

/** G3's structured control plane remains local. Never cloud-serialize requirements/reasons/inputs. */
export function completionPublicResult(text: string, structured: boolean): string | null {
  if (!structured) return text;
  try {
    const outcome = parseParticipantOutcome(JSON.parse(text));
    return outcome.kind === 'RESULT' ? (outcome.publicResult ?? 'RESULT') : outcome.kind;
  } catch {
    // Invalid structured output is rejected by G3; it is not an advisory candidate.
    return null;
  }
}
