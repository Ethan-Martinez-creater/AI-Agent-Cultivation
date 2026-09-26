import type {
  MemoryCandidateExtractor,
  MemoryCandidateRequest,
  MemoryCandidateResult,
  EmbeddingGateway,
  EmbeddingRequest,
  EmbeddingResult,
  ModelGateway,
  ModelRequest,
  ModelResponse,
} from '@cultivation/application';

/** Stable test double: no API credentials, network requests or hidden state. */
export class FakeModelGateway implements ModelGateway, MemoryCandidateExtractor, EmbeddingGateway {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const prompt = request.messages.at(-1)?.content ?? '';
    const text =
      prompt.trim() === '__GATE2_PROMPT_INSPECT__'
        ? request.messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content)
            .join('\n')
        : prompt.trim() === 'PING'
          ? 'PONG'
          : `FAKE: ${prompt}`;
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

  async extractCandidates(request: MemoryCandidateRequest): Promise<MemoryCandidateResult> {
    const evidence = request.evidence.trim().slice(0, 1_000);
    return {
      candidates: evidence
        ? [
            {
              memoryType: 'FACT',
              content: evidence,
              summary: evidence.slice(0, 120),
              importance: 0.5,
              confidence: 0.5,
            },
          ]
        : [],
      usage: {
        inputTokens: evidence.length,
        outputTokens: evidence.length,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const vector = Array<number>(16).fill(0);
    for (const character of request.text) {
      const index = (character.codePointAt(0) ?? 0) % vector.length;
      vector[index] = (vector[index] ?? 0) + 1;
    }
    if (request.text.length === 0) vector[0] = 1;
    return {
      vector,
      usage: {
        inputTokens: request.text.length,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    };
  }
}
