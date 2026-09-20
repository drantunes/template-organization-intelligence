import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Agent } from '@mastra/core/agent';
import type { Config } from '@mastra/core/mastra';
import { MastraWorker } from '@mastra/core/worker';
import { LibSQLStore } from '@mastra/libsql';

import {
  createOrganizationAgent,
  createOrganizationAnswerRoute,
  createOrganizationMcpServer,
  createOrganizationTelemetryRoute,
} from './answers.js';
import { loadCatalog, validateEnvironment } from './catalog.js';
import { SourceIndex } from './source-index.js';
import type { EmbeddingFunction } from './source-index.js';
import { createSourceRuntime } from './sources.js';
import type { SourceRuntime } from './sources.js';
import { createSourceInspectionWorkflow } from './workflows/source-inspection.js';
import { createSourceSearchWorkflow, createSourceSyncWorkflow } from './workflows/source-sync.js';

export function openAIEmbedder(apiKey: string, request: typeof fetch = fetch): EmbeddingFunction {
  return async text => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: text,
          encoding_format: 'float',
          dimensions: 1536,
        }),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Embedding request failed. Check OpenAI credentials and provider availability.');
      }
      const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const vector = body.data?.[0]?.embedding;
      if (!vector || vector.length !== 1536 || !vector.every(Number.isFinite))
        throw new Error('Embedding provider returned an invalid vector.');
      return vector;
    }
    throw new Error('Embedding provider is unavailable.');
  };
}

/** Definitions exist at import time; workers initialize derived search state only when the server starts. */
export async function createOrganizationApplication(options: {
  projectRoot: string;
  environment?: NodeJS.ProcessEnv;
  embed?: EmbeddingFunction;
  sources?: SourceRuntime;
  answerModel?: ConstructorParameters<typeof Agent>[0]['model'];
  now?: () => Date;
}) {
  const environment = options.environment ?? process.env;
  const catalogPath = resolve(options.projectRoot, 'source-catalog.json');
  const catalog = options.sources?.catalog ?? (await loadCatalog(catalogPath));
  const issues = validateEnvironment(catalog, environment);
  if (issues.length) throw new Error(issues.join(' '));
  const sources =
    options.sources ??
    (await createSourceRuntime({
      catalog,
      catalogPath,
      ledgerPath: resolve(options.projectRoot, '.mastra/source-identities.json'),
      environment,
    }));
  await mkdir(resolve(options.projectRoot, '.mastra'), { recursive: true });
  const databaseUrl = 'file:' + resolve(options.projectRoot, '.mastra/organization-intelligence.db');
  const storage = new LibSQLStore({ id: 'organization-intelligence-state', url: databaseUrl });
  const index = new SourceIndex({
    sources,
    databaseUrl,
    embed: options.embed ?? openAIEmbedder(environment.OPENAI_API_KEY!),
    now: options.now,
  });
  const sourceInspectionWorkflow = createSourceInspectionWorkflow(sources);
  const sourceSyncWorkflow = createSourceSyncWorkflow(index);
  const sourceSearchWorkflow = createSourceSearchWorkflow(index);
  const organizationAgent = createOrganizationAgent(index, options.answerModel);
  const answerRoute = createOrganizationAnswerRoute(organizationAgent);
  const telemetryRoute = createOrganizationTelemetryRoute(index);
  const mcpServer = createOrganizationMcpServer(organizationAgent);
  class InitialSynchronization extends MastraWorker {
    readonly name = 'organization-initial-sync';
    #running = false;
    async start(): Promise<void> {
      if (this.#running) return;
      await index.initialize();
      const schedules = await storage.getStore('schedules');
      const now = Date.now();
      for (const schedule of (await schedules?.listSchedules()) ?? [])
        if (
          schedule.target.type === 'workflow' &&
          schedule.target.workflowId === sourceSyncWorkflow.id &&
          schedule.nextFireAt <= now
        ) {
          await schedules?.updateSchedule(schedule.id, {
            nextFireAt: (Math.floor(now / 300_000) + 1) * 300_000,
          });
        }
      const run = await sourceSyncWorkflow.createRun();
      await run.start({ inputData: { trigger: 'startup' } });
      this.#running = true;
    }
    async stop(): Promise<void> {
      this.#running = false;
    }
    get isRunning(): boolean {
      return this.#running;
    }
  }
  const config = {
    logger: false,
    storage,
    workspace: sources.workspace,
    agents: { organizationAgent },
    mcpServers: { organizationIntelligence: mcpServer },
    server: { host: '127.0.0.1', apiRoutes: [answerRoute, telemetryRoute] },
    workflows: { sourceInspectionWorkflow, sourceSyncWorkflow, sourceSearchWorkflow },
    workers: [new InitialSynchronization()],
  } satisfies Config;
  return {
    config,
    index,
    organizationAgent,
    mcpServer,
    storage,
    sources,
    close: async () => {
      await index.close();
      await storage.close();
    },
  };
}
