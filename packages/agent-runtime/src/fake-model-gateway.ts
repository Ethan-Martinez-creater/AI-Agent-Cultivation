import type { ModelGateway, ModelRequest, ModelResponse } from '@cultivation/application';

/** Stable test double: no API credentials, network requests or hidden state. */
export class FakeModelGateway implements ModelGateway {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const prompt = request.messages.at(-1)?.content ?? '';
    const text = prompt.trim() === 'PING' ? 'PONG' : `FAKE: ${prompt}`;
    return {
      text,
      usage: {
        inputTokens: request.messages.reduce((total, message) => total + message.content.length, 0),
        outputTokens: text.length,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    };
  }

  async *stream(request: ModelRequest) {
    const { text, usage } = await this.generate(request);
    for (const delta of text.split(/(\s+)/).filter(Boolean)) {
      yield { type: 'text-delta', text: delta } as const;
    }
    yield { type: 'finish', usage } as const;
  }

  async testConnection(runtimeProfileId: string): Promise<{ ok: boolean; message: string }> {
    return runtimeProfileId.trim().length > 0
      ? { ok: true, message: 'Fake model connection succeeded.' }
      : { ok: false, message: 'Runtime profile ID is required.' };
  }
}
