import type { ModelGateway, ModelRequest, ModelResponse } from '@cultivation/application';

/** Stable test double: no API credentials, network requests or hidden state. */
export class FakeModelGateway implements ModelGateway {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const text = request.prompt.trim() === 'PING' ? 'PONG' : `FAKE: ${request.prompt}`;
    return { text, inputTokens: request.prompt.length, outputTokens: text.length };
  }

  async *stream(request: ModelRequest): AsyncIterable<string> {
    const { text } = await this.generate(request);
    for (const token of text.split(/(\s+)/).filter(Boolean)) yield token;
  }
}
