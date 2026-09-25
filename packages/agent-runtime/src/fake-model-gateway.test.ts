import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '@cultivation/application';
import { FakeModelGateway } from './fake-model-gateway.js';

const request: ModelRequest = {
  runtimeProfileId: 'r1',
  teammateId: 't1',
  messages: [{ role: 'user', content: 'PING' }],
};

describe('FakeModelGateway', () => {
  it('returns deterministic output and usage', async () => {
    const model = new FakeModelGateway();
    expect(await model.generate(request)).toEqual({
      text: 'PONG',
      usage: {
        inputTokens: 4,
        outputTokens: 4,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    });
    expect(await model.generate(request)).toEqual(await model.generate(request));
  });

  it('streams the same output', async () => {
    const model = new FakeModelGateway();
    const events = [];
    for await (const event of model.stream(request)) events.push(event);

    const streamed = events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.text)
      .join('');
    expect(streamed).toBe('PONG');
    expect(events.at(-1)).toEqual({
      type: 'finish',
      usage: {
        inputTokens: 4,
        outputTokens: 4,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    });
  });

  it('returns a deterministic offline connection result', async () => {
    const model = new FakeModelGateway();
    await expect(model.testConnection('r1')).resolves.toEqual({
      ok: true,
      message: 'Fake model connection succeeded.',
    });
    await expect(model.testConnection('')).resolves.toEqual({
      ok: false,
      message: 'Runtime profile ID is required.',
    });
  });
});
