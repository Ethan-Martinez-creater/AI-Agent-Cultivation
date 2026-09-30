import { describe, expect, it } from 'vitest';
import {
  AiSdkModelAvailabilityProbe,
  type ModelAvailabilityProbeResult,
} from './ai-sdk-model-availability-probe.js';
import type { ResolvedRuntime, RuntimeProviderKind } from './ai-sdk-model-gateway.js';

const secret = 'probe-secret-must-not-escape';

function runtime(
  kind: RuntimeProviderKind,
  overrides: Partial<ResolvedRuntime> = {},
): ResolvedRuntime {
  return {
    kind,
    baseUrl: kind === 'GOOGLE' ? 'https://google.example/v1beta' : 'https://provider.example/v1',
    modelId: kind === 'GOOGLE' ? 'gemini-test' : 'fixture-model',
    apiKey: secret,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AiSdkModelAvailabilityProbe', () => {
  it.each([
    ['OPENAI', 'https://provider.example/v1/models/fixture-model', 'id'],
    ['ANTHROPIC', 'https://provider.example/v1/models/fixture-model', 'id'],
    ['GOOGLE', 'https://google.example/v1beta/models/gemini-test', 'name'],
  ] as const)(
    'checks the configured %s model through its metadata endpoint without exposing the key',
    async (kind, expectedUrl, modelField) => {
      const seen: Request[] = [];
      const configured = runtime(kind, {
        modelId: kind === 'GOOGLE' ? 'gemini-test' : 'fixture-model',
      });
      const probe = new AiSdkModelAvailabilityProbe(async () => configured, {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          seen.push(request);
          const id = kind === 'GOOGLE' ? 'models/gemini-test' : 'fixture-model';
          return jsonResponse({
            [modelField]: id,
            ...(kind === 'ANTHROPIC' ? { type: 'model' } : {}),
          });
        },
      });

      await expect(probe.probe('runtime-1')).resolves.toEqual({
        kind: 'SUCCESS',
        code: 'MODEL_AVAILABLE',
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe('GET');
      expect(seen[0]?.url).toBe(expectedUrl);
      expect(seen[0]?.url).not.toContain(secret);
      expect(
        seen[0]?.headers.get('x-goog-api-key') ??
          seen[0]?.headers.get('x-api-key') ??
          seen[0]?.headers.get('authorization'),
      ).toContain(secret);
    },
  );

  it.each<RuntimeProviderKind>(['DEEPSEEK', 'OPENAI_COMPATIBLE'])(
    'verifies %s against its exact model id in the provider catalog',
    async (kind) => {
      const seen: Request[] = [];
      const probe = new AiSdkModelAvailabilityProbe(
        async () =>
          runtime(kind, {
            baseUrl: kind === 'DEEPSEEK' ? null : 'https://compatible.example/v1',
            modelId: 'catalog-model',
          }),
        {
          fetch: async (input, init) => {
            seen.push(new Request(input, init));
            return jsonResponse({ data: [{ id: 'another-model' }, { id: 'catalog-model' }] });
          },
        },
      );

      await expect(probe.probe('runtime-1')).resolves.toEqual({
        kind: 'SUCCESS',
        code: 'MODEL_AVAILABLE',
      });
      expect(seen[0]?.url).toBe(
        kind === 'DEEPSEEK'
          ? 'https://api.deepseek.com/models'
          : 'https://compatible.example/v1/models',
      );
    },
  );

  it('treats a valid provider catalog that omits the configured model as hard unavailable', async () => {
    const probe = new AiSdkModelAvailabilityProbe(
      async () => runtime('OPENAI_COMPATIBLE', { modelId: 'missing-model' }),
      {
        fetch: async () => jsonResponse({ data: [{ id: 'available-model' }] }),
      },
    );

    await expect(probe.probe('runtime-1')).resolves.toEqual({
      kind: 'HARD_FAILURE',
      code: 'MODEL_NOT_FOUND',
    });
  });

  it('accepts Anthropic model aliases resolved to a canonical model id', async () => {
    let requestedUrl: string | undefined;
    const probe = new AiSdkModelAvailabilityProbe(
      async () => runtime('ANTHROPIC', { modelId: 'claude-latest-alias' }),
      {
        fetch: async (input) => {
          requestedUrl = String(input);
          return jsonResponse({ id: 'claude-canonical-model', type: 'model' });
        },
      },
    );

    await expect(probe.probe('runtime-1')).resolves.toEqual({
      kind: 'SUCCESS',
      code: 'MODEL_AVAILABLE',
    });
    expect(requestedUrl).toBe('https://provider.example/v1/models/claude-latest-alias');
  });

  it('does not infer an absent model from a bounded partial catalog', async () => {
    const probe = new AiSdkModelAvailabilityProbe(
      async () => runtime('OPENAI_COMPATIBLE', { modelId: 'next-page-model' }),
      { fetch: async () => jsonResponse({ data: [{ id: 'first-page-model' }], has_more: true }) },
    );
    await expect(probe.probe('runtime-1')).resolves.toEqual({
      kind: 'TRANSIENT_FAILURE',
      code: 'MODEL_METADATA_INCOMPLETE',
    });
  });

  it.each([400, 404, 405, 501])(
    'does not infer model unavailability from compatible metadata HTTP %s',
    async (status) => {
      const probe = new AiSdkModelAvailabilityProbe(async () => runtime('OPENAI_COMPATIBLE'), {
        fetch: async () => new Response('metadata route unavailable', { status }),
      });

      await expect(probe.probe('runtime-1')).resolves.toEqual({
        kind: 'TRANSIENT_FAILURE',
        code: 'MODEL_METADATA_UNAVAILABLE',
      });
    },
  );

  it.each([401, 403])(
    'keeps compatible metadata authentication HTTP %s as a hard failure',
    async (status) => {
      const probe = new AiSdkModelAvailabilityProbe(async () => runtime('OPENAI_COMPATIBLE'), {
        fetch: async () => new Response('sensitive auth response', { status }),
      });

      await expect(probe.probe('runtime-1')).resolves.toEqual({
        kind: 'HARD_FAILURE',
        code: 'AUTHENTICATION_REJECTED',
      });
    },
  );

  it('still treats a complete valid compatible catalog that omits the configured model as hard unavailable', async () => {
    const probe = new AiSdkModelAvailabilityProbe(
      async () => runtime('OPENAI_COMPATIBLE', { modelId: 'missing-model' }),
      {
        fetch: async () => jsonResponse({ data: [{ id: 'available-model' }] }),
      },
    );

    await expect(probe.probe('runtime-1')).resolves.toEqual({
      kind: 'HARD_FAILURE',
      code: 'MODEL_NOT_FOUND',
    });
  });

  it.each([
    [401, 'HARD_FAILURE', 'AUTHENTICATION_REJECTED'],
    [403, 'HARD_FAILURE', 'AUTHENTICATION_REJECTED'],
    [404, 'HARD_FAILURE', 'MODEL_NOT_FOUND'],
    [429, 'TRANSIENT_FAILURE', 'RATE_LIMITED'],
    [503, 'TRANSIENT_FAILURE', 'PROVIDER_TEMPORARY_FAILURE'],
  ] as const)(
    'classifies HTTP %s without preserving provider response text',
    async (status, kind, code) => {
      const probe = new AiSdkModelAvailabilityProbe(async () => runtime('OPENAI'), {
        fetch: async () => new Response(`sensitive response ${secret}`, { status }),
      });

      const result: ModelAvailabilityProbeResult = await probe.probe('runtime-1');
      expect(result).toEqual({ kind, code });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('sensitive response');
    },
  );

  it('classifies a refused connection as hard unavailable without exposing the exception', async () => {
    const probe = new AiSdkModelAvailabilityProbe(async () => runtime('OPENAI'), {
      fetch: async () => {
        const cause = Object.assign(new Error('secret endpoint and key'), { code: 'ECONNREFUSED' });
        throw Object.assign(new TypeError(`request failed: ${secret}`), { cause });
      },
    });

    const result = await probe.probe('runtime-1');
    expect(result).toEqual({ kind: 'HARD_FAILURE', code: 'CONNECTION_REFUSED' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('treats timeout and malformed metadata as transient failures', async () => {
    const timeoutProbe = new AiSdkModelAvailabilityProbe(async () => runtime('OPENAI'), {
      fetch: async () => {
        throw new DOMException(secret, 'TimeoutError');
      },
    });
    const malformedProbe = new AiSdkModelAvailabilityProbe(
      async () => runtime('OPENAI_COMPATIBLE'),
      { fetch: async () => jsonResponse({ unexpected: [] }) },
    );

    await expect(timeoutProbe.probe('runtime-1')).resolves.toEqual({
      kind: 'TRANSIENT_FAILURE',
      code: 'REQUEST_TIMEOUT',
    });
    await expect(malformedProbe.probe('runtime-1')).resolves.toEqual({
      kind: 'TRANSIENT_FAILURE',
      code: 'MODEL_METADATA_UNAVAILABLE',
    });
  });

  it('turns resolver failures into safe structured results', async () => {
    const secretError = Object.assign(new Error(secret), { code: 'NOT_FOUND' });
    const probe = new AiSdkModelAvailabilityProbe(async () => {
      throw secretError;
    });

    const result = await probe.probe('missing-runtime');
    expect(result.kind).toBe('HARD_FAILURE');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('NOT_FOUND');
  });

  it('does not attempt a request for a malformed runtime or an unconfigured compatible endpoint', async () => {
    let calls = 0;
    const probe = new AiSdkModelAvailabilityProbe(
      async () => runtime('OPENAI_COMPATIBLE', { baseUrl: null }),
      {
        fetch: async () => {
          calls += 1;
          return jsonResponse({ data: [{ id: 'fixture-model' }] });
        },
      },
    );

    await expect(probe.probe('runtime-1')).resolves.toEqual({
      kind: 'HARD_FAILURE',
      code: 'RUNTIME_INVALID',
    });
    expect(calls).toBe(0);
  });
});
