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
  ModelToolResponse,
} from '@cultivation/application';

function contentCharacters(content: unknown): number {
  return typeof content === 'string' ? content.length : JSON.stringify(content).length;
}

function inspectTranscript(messages: ModelRequest['messages']) {
  const callIds = messages.flatMap((message) =>
    message.role === 'assistant' && Array.isArray(message.content)
      ? message.content
          .filter((part) => part.type === 'tool-call')
          .map((part) => ({ id: part.toolCallId, name: part.toolName }))
      : [],
  );
  const resultIds = messages.flatMap((message) =>
    message.role === 'tool'
      ? message.content
          .filter((part) => part.type === 'tool-result')
          .map((part) => ({ id: part.toolCallId, name: part.toolName }))
      : [],
  );
  const toolOutputText = messages.flatMap((message) =>
    message.role === 'tool' ? message.content.map((part) => part.output.value.content) : [],
  );
  const userMessagesWithToolOutput = messages.filter(
    (message) =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      toolOutputText.some((content) => content.length > 0 && message.content.includes(content)),
  ).length;
  return {
    messages: messages.map((message) => ({
      role: message.role,
      toolCallIds:
        message.role === 'assistant' && Array.isArray(message.content)
          ? message.content
              .filter((part) => part.type === 'tool-call')
              .map((part) => part.toolCallId)
          : [],
      toolResultIds:
        message.role === 'tool'
          ? message.content
              .filter((part) => part.type === 'tool-result')
              .map((part) => part.toolCallId)
          : [],
    })),
    toolCallIdsMatch:
      callIds.length === resultIds.length &&
      callIds.every(
        (call, index) => call.id === resultIds[index]?.id && call.name === resultIds[index]?.name,
      ),
    userMessagesWithToolOutput,
  };
}

/** Stable test double: no API credentials, network requests or hidden state. */
export class FakeModelGateway implements ModelGateway, MemoryCandidateExtractor, EmbeddingGateway {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const lastText = [...request.messages]
      .reverse()
      .find(
        (message): message is Extract<(typeof request.messages)[number], { content: string }> =>
          typeof message.content === 'string',
      );
    const prompt = lastText?.content ?? '';
    const toolResults = request.messages.flatMap((message) =>
      message.role === 'tool' ? message.content.map((part) => part.output.value) : [],
    );
    const text =
      prompt.trim() === '__GATE2_PROMPT_INSPECT__'
        ? request.messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content)
            .join('\n')
        : toolResults.length > 0
          ? `FAKE_TOOL_RESULT:${JSON.stringify(toolResults)}`
          : prompt.trim() === 'PING'
            ? 'PONG'
            : `FAKE: ${prompt}`;
    return {
      text,
      usage: {
        inputTokens: request.messages.reduce(
          (total, message) => total + contentCharacters(message.content),
          0,
        ),
        outputTokens: text.length,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    };
  }

  async generateWithTools(
    request: Parameters<NonNullable<ModelGateway['generateWithTools']>>[0],
  ): Promise<ModelToolResponse> {
    const objective = request.messages.find(
      (
        message,
      ): message is Extract<(typeof request.messages)[number], { role: 'user' }> & {
        content: string;
      } => message.role === 'user' && typeof message.content === 'string',
    )?.content;
    const callCount = request.messages.reduce(
      (total, message) =>
        total +
        (message.role === 'assistant' && Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'tool-call').length
          : 0),
      0,
    );
    const resultCount = request.messages.reduce(
      (total, message) =>
        total +
        (message.role === 'tool'
          ? message.content.filter((part) => part.type === 'tool-result').length
          : 0),
      0,
    );
    const transcriptFixture = objective?.startsWith('__GATE4_TRANSCRIPT_INSPECT__:') ?? false;
    const sequenceFixture = objective?.startsWith('__GATE4_SEQUENCE_TOOL__:') ?? false;
    const repeatFixture = objective?.startsWith('__GATE4_REPEAT_TOOL__:') ?? false;
    const singleFixture = objective?.startsWith('__GATE4_TOOL__:') ?? false;
    let sequence: Array<{ toolId: string; input: unknown }> = [];
    if (sequenceFixture) {
      try {
        sequence = JSON.parse(objective!.slice('__GATE4_SEQUENCE_TOOL__:'.length)) as Array<{
          toolId: string;
          input: unknown;
        }>;
      } catch {
        sequence = [];
      }
    }
    let single: { toolId: string; input: unknown } | null = null;
    if (transcriptFixture || repeatFixture || singleFixture) {
      const marker = transcriptFixture
        ? '__GATE4_TRANSCRIPT_INSPECT__:'
        : repeatFixture
          ? '__GATE4_REPEAT_TOOL__:'
          : '__GATE4_TOOL__:';
      try {
        single = JSON.parse(objective!.slice(marker.length)) as {
          toolId: string;
          input: unknown;
        };
      } catch {
        single = { toolId: '', input: {} };
      }
    }

    let requested: { toolId: string; input: unknown } | undefined;
    if (sequenceFixture) {
      if (callCount < sequence.length) requested = sequence[callCount];
    } else if (repeatFixture) {
      requested = single ?? { toolId: '', input: {} };
    } else if (singleFixture || transcriptFixture) {
      if (callCount === 0) requested = single ?? { toolId: '', input: {} };
    }

    if (requested) {
      const toolId = requested.toolId;
      return {
        text: '',
        toolCalls: [{ id: `fake-call-${request.messages.length}`, toolId, input: requested.input }],
        usage: {
          inputTokens: request.messages.reduce(
            (total, message) => total + contentCharacters(message.content),
            0,
          ),
          outputTokens: 1,
          cachedInputTokens: null,
          reasoningTokens: null,
        },
      };
    }

    if ((transcriptFixture || sequenceFixture) && resultCount > 0) {
      const diagnostics = inspectTranscript(request.messages);
      const text = JSON.stringify(diagnostics);
      return {
        text,
        toolCalls: [],
        usage: {
          inputTokens: request.messages.reduce(
            (total, message) => total + contentCharacters(message.content),
            0,
          ),
          outputTokens: text.length,
          cachedInputTokens: null,
          reasoningTokens: null,
        },
      };
    }
    const response = await this.generate(request);
    return { ...response, toolCalls: [] };
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
