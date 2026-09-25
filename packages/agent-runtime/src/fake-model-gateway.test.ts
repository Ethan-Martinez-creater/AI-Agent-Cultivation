import { describe, expect, it } from 'vitest';
import { FakeModelGateway } from './fake-model-gateway.js';

const request = { runtimeProfileId: 'r1', teammateId: 't1', prompt: 'PING' };

describe('FakeModelGateway', () => {
  it('returns deterministic output and usage', async () => {
    const model = new FakeModelGateway();
    expect(await model.generate(request)).toEqual({
      text: 'PONG',
      inputTokens: 4,
      outputTokens: 4,
    });
    expect(await model.generate(request)).toEqual(await model.generate(request));
  });

  it('streams the same output', async () => {
    const model = new FakeModelGateway();
    let streamed = '';
    for await (const chunk of model.stream(request)) streamed += chunk;
    expect(streamed).toBe('PONG');
  });
});
