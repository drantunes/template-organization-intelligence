type ModelCall = { prompt: unknown; tools?: unknown };
type FixtureOptions = {
  error?: Error | (() => Error);
  finishReason?: string;
  onCall?: (call: ModelCall) => void;
  textForCall?: (call: ModelCall) => string;
};

export function fixedLanguageModel(text: string, options: FixtureOptions = {}) {
  const errorForCall = () => (typeof options.error === 'function' ? options.error() : options.error);
  const textForCall = (call: ModelCall) => options.textForCall?.(call) ?? text;
  return {
    specificationVersion: 'v2' as const,
    provider: 'controlled-test-provider',
    modelId: 'controlled-test-model',
    supportedUrls: async () => ({}),
    doGenerate: async (call: ModelCall) => {
      options.onCall?.(call);
      const error = errorForCall();
      if (error) throw error;
      return {
        content: [{ type: 'text', text: textForCall(call) }],
        finishReason: options.finishReason ?? 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
        response: { id: 'controlled-response', timestamp: new Date(0), modelId: 'controlled-test-model' },
      };
    },
    doStream: async (call: ModelCall) => {
      options.onCall?.(call);
      const error = errorForCall();
      if (error) throw error;
      const responseText = textForCall(call);
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({
              type: 'response-metadata',
              id: 'controlled-response',
              modelId: 'controlled-test-model',
              timestamp: new Date(0),
            });
            controller.enqueue({ type: 'text-start', id: 'controlled-text' });
            controller.enqueue({ type: 'text-delta', id: 'controlled-text', delta: responseText });
            controller.enqueue({ type: 'text-end', id: 'controlled-text' });
            controller.enqueue({
              type: 'finish',
              finishReason: options.finishReason ?? 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  };
}
