import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import type { SourceIndex } from '../source-index.js';

const input = z.object({ trigger: z.enum(['startup', 'manual', 'scheduled']).default('manual') });
const output = z.object({
  runId: z.string(),
  status: z.enum(['success', 'partial', 'failed', 'skipped']),
  startedAt: z.string(),
  finishedAt: z.string(),
  sources: z.array(
    z.object({
      sourceId: z.string(),
      discovered: z.number(),
      indexed: z.number(),
      changed: z.number(),
      unchanged: z.number(),
      skipped: z.number(),
      failed: z.number(),
      removed: z.number(),
      status: z.enum(['success', 'partial', 'failed']),
      errors: z.array(z.string()),
    }),
  ),
});

export function createSourceSyncWorkflow(index: SourceIndex) {
  const sync = createStep({
    id: 'sync-organization-sources',
    inputSchema: input,
    outputSchema: output,
    execute: async () => index.sync(),
  });
  return createWorkflow({
    id: 'sync-organization-sources',
    options: { autoRestartActiveRuns: false, shouldPersistSnapshot: () => false },
    description: 'Refreshes configured sources and reports indexed, changed, skipped and failed records.',
    inputSchema: input,
    outputSchema: output,
    schedule: { cron: '*/5 * * * *', timezone: 'UTC', inputData: { trigger: 'scheduled' } },
  })
    .then(sync)
    .commit();
}

export function createSourceSearchWorkflow(index: SourceIndex) {
  const searchInput = z.object({ question: z.string().trim().min(1).max(4_000) });
  const searchOutput = z.object({
    hits: z.array(
      z.object({
        id: z.string(),
        content: z.string(),
        score: z.number(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    sources: z.array(
      z.object({
        sourceId: z.string(),
        ready: z.boolean(),
        stale: z.boolean(),
        lastSuccessAt: z.string().nullable(),
        error: z.string().nullable(),
        records: z.number(),
      }),
    ),
  });
  return createWorkflow({
    id: 'search-organization-records',
    options: { shouldPersistSnapshot: () => false },
    description: 'Searches indexed source evidence without generating an answer.',
    inputSchema: searchInput,
    outputSchema: searchOutput,
  })
    .then(
      createStep({
        id: 'search-indexed-records',
        inputSchema: searchInput,
        outputSchema: searchOutput,
        execute: async ({ inputData }) => ({
          hits: await index.search(inputData.question),
          sources: index.sourceStatus(),
        }),
      }),
    )
    .commit();
}
