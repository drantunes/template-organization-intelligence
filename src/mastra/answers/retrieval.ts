import { randomUUID } from 'node:crypto';
import type { SourceIndex } from '../workspaces/source-index.js';
import {
  boundedEvidence,
  boundedSourceStatus,
  isNativeStudioMessage,
  latestQuestionMessage,
  questionFromMessage,
} from './evidence.js';
import type { ProcessorState } from './schema.js';
import { MAX_QUESTION_CHARACTERS } from './schema.js';

export async function prepareGrounding(
  index: SourceIndex,
  messages: Parameters<typeof latestQuestionMessage>[0],
  state: ProcessorState,
): Promise<void> {
  const questionMessage = latestQuestionMessage(messages);
  state.presentation = isNativeStudioMessage(questionMessage) ? 'studio' : 'structured';
  const question = questionFromMessage(questionMessage);
  if (!question.trim() || question.length > MAX_QUESTION_CHARACTERS)
    throw new Error('Use a non-empty question of at most 4000 characters.');
  const startedAt = performance.now();
  state.startedAt = startedAt;
  state.correlationId = randomUUID();
  state.retrievalMs = Math.round(performance.now() - startedAt);
  try {
    const hits = await index.search(question, 6);
    state.sourceStatus = index.sourceStatus();
    state.promptSourceStatus = boundedSourceStatus(state.sourceStatus);
    state.evidence = boundedEvidence(hits, state.promptSourceStatus);
  } catch {
    state.operationalFailure = true;
    state.evidence = [];
    try {
      state.sourceStatus = index.sourceStatus();
      state.promptSourceStatus = boundedSourceStatus(state.sourceStatus);
    } catch {
      state.sourceStatus = [];
      state.promptSourceStatus = [];
    }
  }
  state.retrievalMs = Math.round(performance.now() - startedAt);
}
