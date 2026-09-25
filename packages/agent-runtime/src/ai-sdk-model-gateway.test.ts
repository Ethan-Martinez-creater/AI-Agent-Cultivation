import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '@cultivation/application';
import { AiSdkModelGateway, type RuntimeProviderKind } from './ai-sdk-model-gateway.js';

const request: ModelRequest = {
  runtimeProfileId: 'runtime-1',
  teammateId: 'teammate-1',
  messages: [
    { role: 'system', content: 'Answer briefly.' },
    { role: 'user', content: 'PING' },
  ],
};

function responseFor(kind: RuntimeProviderKind): Record<string, unknown> {
  if (kind === 'ANTHROPIC') {
    return {
      id: 'message-test',
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [{ type: 'text', text: 'PONG' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 2 },
    };
  }

  if (kind === 'GOOGLE') {
    return {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'PONG' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 7,
        candidatesTokenCount: 2,
        totalTokenCount: 9,
      },
    };
  }

  return {
    id: 'completion-test',
    object: 'chat.completion',
    created: 1,
    model: 'fixture-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'PONG' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  };
}

describe('AiSdkModelGateway', () => {
  it.each<RuntimeProviderKind>(['OPENAI', 'ANTHROPIC', 'GOOGLE', 'DEEPSEEK', 'OPENAI_COMPATIBLE'])(
    'tests %s connection with a non-generating models request',
    async (kind) => {
      let seen: Request | undefined;
      const gateway = new AiSdkModelGateway(
        async () => ({
          kind,
          baseUrl: 'https://provider.example/v1',
          modelId: 'manually-entered-model',
          apiKey: 'test-secret',
        }),
        {
          fetch: async (input, init) => {
            seen = new Request(input, init);
            return new Response('{}', { status: 200 });
          },
        },
      );
      await expect(gateway.testConnection('runtime-1')).resolves.toEqual({
        ok: true,
        message: 'Provider connection succeeded.',
      });
      expect(seen?.method).toBe('GET');
      expect(seen?.url).toBe('https://provider.example/v1/models');
      expect(
        seen?.headers.get(
          kind === 'GOOGLE'
            ? 'x-goog-api-key'
            : kind === 'ANTHROPIC'
              ? 'x-api-key'
              : 'authorization',
        ),
      ).toBe(kind === 'GOOGLE' || kind === 'ANTHROPIC' ? 'test-secret' : 'Bearer test-secret');
    },
  );

  it('supports a local OpenAI-Compatible endpoint without a credential', async () => {
    let authorization: string | null = null;
    const gateway = new AiSdkModelGateway(
      async () => ({
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://localhost:1234/v1',
        modelId: 'local-model',
        apiKey: '',
      }),
      {
        fetch: async (input, init) => {
          authorization = new Request(input, init).headers.get('authorization');
          return new Response(JSON.stringify(responseFor('OPENAI_COMPATIBLE')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );
    await expect(gateway.generate(request)).resolves.toMatchObject({ text: 'PONG' });
    expect(authorization).toBeNull();
  });

  it.each<RuntimeProviderKind>(['OPENAI', 'ANTHROPIC', 'GOOGLE', 'DEEPSEEK', 'OPENAI_COMPATIBLE'])(
    'routes %s through its pinned AI SDK adapter',
    async (kind) => {
      const seenUrls: string[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        seenUrls.push(request.url);
        return new Response(JSON.stringify(responseFor(kind)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      const gateway = new AiSdkModelGateway(
        async (runtimeProfileId) => {
          expect(runtimeProfileId).toBe('runtime-1');
          return {
            kind,
            baseUrl: kind === 'DEEPSEEK' ? null : 'https://provider.example/v1',
            modelId: 'fixture-model',
            apiKey: 'test-secret-never-logged',
          };
        },
        { fetch: fetcher },
      );

      await expect(gateway.generate(request)).resolves.toEqual({
        text: 'PONG',
        usage: {
          inputTokens: 7,
          outputTokens: 2,
          cachedInputTokens: null,
          reasoningTokens: null,
        },
      });
      expect(seenUrls).toHaveLength(1);
    },
  );

  it('does not invent token usage omitted by the provider', async () => {
    const response = responseFor('OPENAI');
    delete response.usage;
    const fetcher: typeof fetch = async () => {
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const gateway = new AiSdkModelGateway(
      async () => ({
        kind: 'OPENAI',
        baseUrl: null,
        modelId: 'fixture-model',
        apiKey: 'test-secret',
      }),
      { fetch: fetcher },
    );

    await expect(gateway.generate(request)).resolves.toEqual({
      text: 'PONG',
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    });
  });

  it('streams provider deltas followed by normalized usage', async () => {
    const chunks = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'PON' }, finish_reason: null }],
      },
      {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta: { content: 'G' }, finish_reason: null }],
      },
      {
        id: 'chunk-3',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 2,
          total_tokens: 9,
          prompt_tokens_details: { cached_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      },
    ];
    const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
    const gateway = new AiSdkModelGateway(
      async () => ({
        kind: 'OPENAI',
        baseUrl: null,
        modelId: 'fixture-model',
        apiKey: 'test-secret',
      }),
      {
        fetch: async () =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      },
    );

    const events = [];
    for await (const event of gateway.stream(request)) events.push(event);
    expect(events).toEqual([
      { type: 'text-delta', text: 'PON' },
      { type: 'text-delta', text: 'G' },
      {
        type: 'finish',
        usage: {
          inputTokens: 7,
          outputTokens: 2,
          cachedInputTokens: 1,
          reasoningTokens: 1,
        },
      },
    ]);
  });

  it('returns only a sanitized failure message for provider errors', async () => {
    const secret = 'provider-secret-do-not-leak';
    const runtimeIds: string[] = [];
    const gateway = new AiSdkModelGateway(
      async (runtimeProfileId) => {
        runtimeIds.push(runtimeProfileId);
        return {
          kind: 'OPENAI',
          baseUrl: null,
          modelId: 'fixture-model',
          apiKey: secret,
        };
      },
      {
        fetch: async () => {
          throw new Error(`Rejected key: ${secret}`);
        },
      },
    );

    const result = await gateway.testConnection('runtime-1');
    expect(runtimeIds).toEqual(['runtime-1']);
    expect(result).toEqual({
      ok: false,
      message: 'Provider request failed. Check provider settings and connectivity.',
    });
    expect(result.message).not.toContain(secret);
  });
});
