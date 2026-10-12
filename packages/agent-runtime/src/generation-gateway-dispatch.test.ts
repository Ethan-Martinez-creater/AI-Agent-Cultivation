import { describe, expect, it } from 'vitest';
import type { GenerationGateway } from '@cultivation/application/g1-generation';
import type { GenerationAdapterId } from '@cultivation/domain';
import { GENERATION_ADAPTER_IDS } from '@cultivation/domain';
import { GenerationGatewayDispatch } from './generation-gateway-dispatch.js';

describe('trusted production generation adapter dispatch', () => {
  it('keeps legacy H3 distinct and dispatches each code-owned adapter without a plugin path', async () => {
    const calls: string[] = [];
    const gateways = Object.fromEntries(
      GENERATION_ADAPTER_IDS.map((id) => [
        id,
        {
          getDescriptor: async () => {
            calls.push(id);
            return { modelId: id };
          },
        },
      ]),
    ) as unknown as Record<GenerationAdapterId, GenerationGateway>;
    const dispatch = new GenerationGatewayDispatch((runtime) => runtime, gateways);
    for (const id of GENERATION_ADAPTER_IDS)
      expect((await dispatch.getDescriptor(id)).modelId).toBe(id);
    expect(calls).toEqual([...GENERATION_ADAPTER_IDS]);
  });
  it('fails closed for a renderer-supplied unknown adapter, with zero provider operation', () => {
    let calls = 0;
    const gateways = Object.fromEntries(
      GENERATION_ADAPTER_IDS.map((id) => [
        id,
        {
          getDescriptor: () => {
            calls++;
          },
        },
      ]),
    ) as unknown as Record<GenerationAdapterId, GenerationGateway>;
    const dispatch = new GenerationGatewayDispatch(() => 'arbitrary-rest-script', gateways);
    expect(() => dispatch.getDescriptor('runtime')).toThrow();
    expect(calls).toBe(0);
  });
});
