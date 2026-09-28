import type { CapabilityDimension, ModelCapabilityBenchmark } from '@cultivation/domain';

const PRIORITY: Record<ModelCapabilityBenchmark['provenanceType'], number> = {
  USER_OVERRIDE: 0,
  CATALOG: 1,
  USER_ESTIMATE: 2,
};

/**
 * Selects one prior using a fixed, auditable order. An unsupported winner is
 * returned as-is and masks all lower-priority entries for the same model and
 * dimension.
 */
export class BenchmarkPriorResolver {
  resolve(input: {
    benchmarks: readonly ModelCapabilityBenchmark[];
    runtimeProfileId: string;
    modelAlias: string;
    dimension: CapabilityDimension;
  }): ModelCapabilityBenchmark | null {
    const candidates = input.benchmarks.filter(
      (item) =>
        item.runtimeProfileId === input.runtimeProfileId &&
        item.modelAlias === input.modelAlias &&
        item.dimension === input.dimension,
    );
    candidates.sort(comparePrior);
    return candidates[0] ?? null;
  }
}

function comparePrior(left: ModelCapabilityBenchmark, right: ModelCapabilityBenchmark): number {
  const priorityDifference = PRIORITY[left.provenanceType] - PRIORITY[right.provenanceType];
  if (priorityDifference !== 0) return priorityDifference;
  const snapshotDifference = compareDateDesc(left.snapshotDate, right.snapshotDate);
  if (snapshotDifference !== 0) return snapshotDifference;
  const createdDifference = compareDateDesc(left.createdAt, right.createdAt);
  if (createdDifference !== 0) return createdDifference;
  return left.id.localeCompare(right.id);
}

function compareDateDesc(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return right.localeCompare(left);
}
