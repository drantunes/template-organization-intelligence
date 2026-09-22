import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { OrganizationAnswer } from '../src/answers.js';
import { createEvaluationRuntime, evaluationFixtureVersion } from '../src/evaluation-fixtures.js';
import { EVALUATION_CASES, evaluateInstitutionalKnowledge } from '../src/evaluation.js';
import type { JudgeResult } from '../src/evaluation.js';
import {
  assertIsolatedEvaluationState,
  calibrationSummary,
  createEvaluationExperimentRuntime,
  inspectNativeExperiments,
  inspectPersistedExperiments,
  nativeAgentEvaluationReport,
  nativeRetrievalSummary,
  operationalEvaluationExclusions,
  readPersistedNativeAgentEvaluationReport,
  runNativeExperiment,
  seedExperimentDatasets,
} from '../src/experiments.js';
import type { EvaluationJudge } from '../src/experiments.js';
import { SourceIndex } from '../src/source-index.js';
import { fixedLanguageModel } from './model-fixture.js';

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value) return Object.values(value).flatMap(strings);
  return [];
}

const execFileAsync = promisify(execFile);

async function evaluationRunnerFixture(
  directory: string,
  mode: 'expired' | 'retryable-answer' | 'retryable-judge' | 'success' | 'timeout',
) {
  const injector = join(directory, `openai-${mode}-fixture.mjs`);
  const log = join(directory, `openai-${mode}-requests.jsonl`);
  await writeFile(
    injector,
    `import { appendFile } from 'node:fs/promises';

const mode = process.env.EVALUATION_FIXTURE_MODE;
const log = process.env.EVALUATION_FIXTURE_LOG;
const record = value => appendFile(log, JSON.stringify(value) + '\\n');
if (mode === 'timeout') {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = () => timeout(1);
}
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const body = init.body ? JSON.parse(String(init.body)) : {};
  const request = { body, path: new URL(url).pathname };
  if (mode === 'timeout' && request.path.endsWith('/embeddings')) {
    await new Promise((resolve, reject) => {
      const signal = init.signal;
      if (!signal) return reject(new Error('fixture request was not abortable'));
      const abort = async () => {
        clearTimeout(fallback);
        await record({ ...request, aborted: true });
        reject(signal.reason);
      };
      const fallback = setTimeout(() => reject(new Error('fixture request did not abort')), 50);
      if (signal.aborted) void abort();
      else signal.addEventListener('abort', () => void abort(), { once: true });
    });
  }
  await record(request);
  if (request.path.endsWith('/embeddings')) {
    return new Response(
      JSON.stringify({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }], usage: { total_tokens: 3 } }),
      { headers: { 'content-type': 'application/json' }, status: 200 },
    );
  }
  if (mode === 'expired') return new Response('expired', { status: 401 });
  const judge = JSON.stringify(body).includes('Judge synthetic evaluation only.');
  if ((mode === 'retryable-answer' && !judge) || (mode === 'retryable-judge' && judge))
    return new Response('retry later', { status: 503 });
  const content = judge
    ? JSON.stringify({ supportedClaims: 0, totalClaims: 1, supportedFactIds: [], unauthorizedBehavior: false })
    : JSON.stringify({ status: 'insufficient_evidence', answer: 'The records do not establish this.', citations: [] });
  if (request.path.endsWith('/responses')) {
    return new Response(
      JSON.stringify({
        created_at: 0,
        id: 'fixture-response',
        model: 'fixture-model',
        object: 'response',
        output: [
          {
            content: [{ annotations: [], text: content, type: 'output_text' }],
            id: 'fixture-message',
            role: 'assistant',
            status: 'completed',
            type: 'message',
          },
        ],
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      }),
      { headers: { 'content-type': 'application/json' }, status: 200 },
    );
  }
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', index: 0, message: { content, role: 'assistant' } }],
      created: 0,
      id: 'fixture-response',
      model: 'fixture-model',
      object: 'chat.completion',
      usage: { completion_tokens: 4, prompt_tokens: 3, total_tokens: 7 },
    }),
    { headers: { 'content-type': 'application/json' }, status: 200 },
  );
};
`,
  );
  return {
    env: {
      ...process.env,
      EVALUATION_FIXTURE_LOG: log,
      EVALUATION_FIXTURE_MODE: mode,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${injector}`.trim(),
      OPENAI_API_KEY: 'fixture-key',
    },
    log,
  };
}

function answerModel(
  options: {
    error?: Error | (() => Error);
    invalidFor?: string;
    onCall?: (call: { abortSignal?: AbortSignal; maxOutputTokens?: number; prompt: string }) => void;
    waitForAbort?: boolean;
  } = {},
) {
  return fixedLanguageModel('', {
    error: options.error,
    onCall: call => {
      options.onCall?.({
        abortSignal: call.abortSignal,
        maxOutputTokens: call.maxOutputTokens,
        prompt: strings(call.prompt).join('\n'),
      });
    },
    waitForAbort: options.waitForAbort,
    textForCall: call => {
      const prompt = strings(call.prompt).join('\n');
      if (options.invalidFor && prompt.includes(options.invalidFor))
        return JSON.stringify({ status: 'draft', answer: 'unsafe unpublished draft', citations: [] });
      const payload = JSON.parse(prompt.split('\n').find(line => line.includes('"evidence"')) ?? '{}') as {
        evidence?: Array<{ recordId: string; locator: string; excerpt: string }>;
      };
      const evidence = payload.evidence ?? [];
      const status = prompt.includes('What is the unrecorded')
        ? 'insufficient_evidence'
        : prompt.includes('What do conflicting')
          ? 'conflicting_evidence'
          : 'answered';
      return JSON.stringify({
        status,
        answer:
          status === 'insufficient_evidence'
            ? 'The records do not establish this.'
            : status === 'conflicting_evidence'
              ? 'The retrieved records conflict and do not establish one rule.'
              : prompt.includes('Read the malicious')
                ? 'The document instruction does not authorize an action.'
                : (evidence[0]?.excerpt ?? 'The records do not establish this.'),
        citations:
          status === 'insufficient_evidence'
            ? []
            : evidence.slice(0, status === 'conflicting_evidence' ? 2 : 1).map(hit => ({
                recordId: hit.recordId,
                locator: hit.locator,
              })),
      });
    },
  });
}

const judge: EvaluationJudge = async ({ evaluationCase, answer }) => {
  const unsupported =
    answer.status === 'operational_error' ||
    evaluationCase.kind === 'malicious' ||
    answer.answer.includes('chief executive');
  const totalClaims = evaluationCase.kind === 'malicious' ? 0 : 1;
  return {
    supportedClaims: unsupported ? 0 : 1,
    totalClaims,
    supportedFactIds: unsupported ? [] : evaluationCase.requiredFacts.slice(0, 1),
    unauthorizedBehavior: false,
  };
};

async function openRuntime(
  options: {
    answerError?: Error | (() => Error);
    judge?: EvaluationJudge;
    invalidAnswerFor?: string;
    onAnswerDispatch?: () => void;
    onAnswerUsage?: (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined) => void;
    providerTimeoutMs?: number;
    stateDirectory?: string;
    waitForAnswerAbort?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'organization-experiment-'));
  const sources = await createEvaluationRuntime(join(root, 'fixtures'), {});
  const index = new SourceIndex({
    databaseUrl: `file:${join(root, 'synthetic-index.db')}`,
    sources,
    embed: async text => [Number(/invoice|retain|retention|kept/.test(text.toLowerCase())), 0.01],
  });
  await index.initialize();
  expect((await index.sync()).status).toBe('success');
  const counters = {
    answer: 0,
    answerRequests: [] as Array<{ abortSignal?: AbortSignal; maxOutputTokens?: number; prompt: string }>,
    judge: 0,
    prompts: [] as string[],
  };
  const runtime = await createEvaluationExperimentRuntime({
    stateDirectory: options.stateDirectory ?? join(root, 'experiments'),
    index,
    answerModel: answerModel({
      error: options.answerError,
      invalidFor: options.invalidAnswerFor,
      onCall: request => {
        counters.answer++;
        counters.answerRequests.push(request);
        counters.prompts.push(request.prompt);
      },
      waitForAbort: options.waitForAnswerAbort,
    }) as never,
    fixtureVersion: evaluationFixtureVersion(sources),
    provenance: {
      indexSnapshotVersion: index.lastRun()!.runId,
      answerModel: 'controlled-test-model',
      judgeModel: 'controlled-test-judge',
      rubricVersion: 'test-rubric-v1',
    },
    judge: async input => {
      counters.judge++;
      return (options.judge ?? judge)(input);
    },
    onAnswerDispatch: options.onAnswerDispatch,
    onAnswerUsage: options.onAnswerUsage,
    providerTimeoutMs: options.providerTimeoutMs,
  });
  return {
    root,
    runtime,
    counters,
    close: async () => {
      await runtime.close();
      await index.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('F5 native comparable experiments', () => {
  it('experiment_datasets_are_idempotent_and_versioned', async () => {
    const fixture = await openRuntime();
    try {
      const first = await seedExperimentDatasets(fixture.runtime);
      const second = await seedExperimentDatasets(fixture.runtime);
      expect(second).toEqual(first);
      expect((await fixture.runtime.agentDataset.listVersions()).versions).toHaveLength(1);
      expect(await fixture.runtime.agentDataset.listItems({ version: first.agentVersion })).toHaveLength(30);
      const versioned = await fixture.runtime.agentDataset.listItems({ version: first.agentVersion });
      const item = (Array.isArray(versioned) ? versioned : versioned.items)[0]!;
      await fixture.runtime.agentDataset.updateItem({
        itemId: item.id,
        input: `${String(item.input)} (revised)`,
        groundTruth: item.groundTruth ?? {},
        metadata: item.metadata ?? {},
      });
      const changedVersion = (await fixture.runtime.agentDataset.getDetails()).version;
      expect(changedVersion).toBeGreaterThan(first.agentVersion);
      const original = await fixture.runtime.agentDataset.listItems({ version: first.agentVersion });
      const changed = await fixture.runtime.agentDataset.listItems({ version: changedVersion });
      expect((Array.isArray(original) ? original : original.items)[0]!.input).toBe(item.input);
      expect((Array.isArray(changed) ? changed : changed.items)[0]!.input).toContain('(revised)');
      expect((await fixture.runtime.agentDataset.listVersions()).versions).toHaveLength(2);
      const changedItem = (Array.isArray(changed) ? changed : changed.items)[0]!;
      await fixture.runtime.agentDataset.updateItem({
        itemId: changedItem.id,
        input: changedItem.input,
        groundTruth: changedItem.groundTruth,
        metadata: { ...(changedItem.metadata ?? {}), fixtureVersion: 'mismatched-fixture' },
      });
      await expect(
        runNativeExperiment(fixture.runtime, {
          family: 'agent',
          version: (await fixture.runtime.agentDataset.getDetails()).version,
        }),
      ).rejects.toThrow('fixture version');
      const originalListItems = fixture.runtime.agentDataset.listItems.bind(fixture.runtime.agentDataset);
      const mutableAgentDataset = fixture.runtime.agentDataset as unknown as {
        listItems: typeof fixture.runtime.agentDataset.listItems;
      };
      mutableAgentDataset.listItems = async () => [];
      await expect(
        runNativeExperiment(fixture.runtime, { family: 'agent', version: first.agentVersion }),
      ).rejects.toThrow('one to 30 cases');
      mutableAgentDataset.listItems = async () => Array.from({ length: 31 }, () => item) as never;
      await expect(
        runNativeExperiment(fixture.runtime, { family: 'agent', version: first.agentVersion }),
      ).rejects.toThrow('one to 30 cases');
      mutableAgentDataset.listItems = async () => [{ ...item, input: '' }] as never;
      await expect(
        runNativeExperiment(fixture.runtime, { family: 'agent', version: first.agentVersion }),
      ).rejects.toThrow('dataset item is invalid');
      mutableAgentDataset.listItems = originalListItems;
      const originalCalibrationItems = fixture.runtime.calibrationDataset.listItems.bind(
        fixture.runtime.calibrationDataset,
      );
      const mutableCalibrationDataset = fixture.runtime.calibrationDataset as unknown as {
        listItems: typeof fixture.runtime.calibrationDataset.listItems;
      };
      mutableCalibrationDataset.listItems = async () => [{ input: {}, metadata: item.metadata }] as never;
      await expect(
        runNativeExperiment(fixture.runtime, { family: 'calibration', version: first.calibrationVersion }),
      ).rejects.toThrow();
      mutableCalibrationDataset.listItems = originalCalibrationItems;
      expect(fixture.counters).toMatchObject({ answer: 0, judge: 0 });
    } finally {
      await fixture.close();
    }
  });

  it('agent_experiments_preserve_grounded_answer_contract', async () => {
    let answerDispatches = 0;
    const answerUsage: Array<{ inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined> = [];
    const fixture = await openRuntime({
      onAnswerDispatch: () => {
        answerDispatches++;
      },
      onAnswerUsage: usage => {
        answerUsage.push(usage);
      },
    });
    try {
      const seeded = await seedExperimentDatasets(fixture.runtime);
      const dispatches: string[] = [];
      let created: { id: string; datasetVersion: number } | undefined;
      const run = await runNativeExperiment(fixture.runtime, {
        family: 'agent',
        version: seeded.agentVersion,
        onExperimentCreated: experiment => {
          created = experiment;
        },
        onItemDispatched: itemId => {
          dispatches.push(itemId);
        },
      });
      expect(run).toMatchObject({ status: 'completed', completedItemIds: expect.any(Array), storageComplete: true });
      expect(run.completedItemIds).toHaveLength(30);
      expect(created).toEqual({ id: run.experimentId, datasetVersion: run.datasetVersion });
      expect(dispatches).toEqual(run.completedItemIds);
      expect(fixture.counters).toMatchObject({ answer: 30, judge: 30 });
      expect(answerDispatches).toBe(30);
      expect(answerUsage).toEqual(
        Array.from({ length: 30 }, () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })),
      );
      expect(fixture.counters.answerRequests).toHaveLength(30);
      expect(fixture.counters.answerRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ abortSignal: expect.any(AbortSignal), maxOutputTokens: 4096 }),
        ]),
      );
      expect(fixture.counters.answerRequests.every(request => request.maxOutputTokens === 4096)).toBe(true);
      expect(fixture.runtime.observations.size).toBe(30);
      expect(
        [...fixture.runtime.observations.values()].filter(item => item.answer.status === 'insufficient_evidence'),
      ).toHaveLength(5);
      expect(
        [...fixture.runtime.observations.values()].filter(item => item.answer.status === 'conflicting_evidence'),
      ).toHaveLength(3);
      expect(
        [...fixture.runtime.observations.values()].filter(
          item => item.answer.status === 'answered' && item.answer.answer.includes('document instruction'),
        ),
      ).toHaveLength(2);
      expect(fixture.counters.prompts.join('\n')).not.toContain('requiredRecordIds');
      expect(fixture.counters.prompts.join('\n')).not.toContain('requiredFacts');
    } finally {
      await fixture.close();
    }
    const invalid = await openRuntime({ invalidAnswerFor: 'How long are invoices retained?' });
    try {
      const seeded = await seedExperimentDatasets(invalid.runtime);
      await expect(
        runNativeExperiment(invalid.runtime, { family: 'agent', version: seeded.agentVersion }),
      ).resolves.toMatchObject({
        status: 'completed',
      });
      const invalidAnswer = [...invalid.runtime.observations.values()].find(
        item => item.answer.metadata.validationFailure === 'invalid_status_or_draft',
      );
      expect(invalidAnswer?.answer).toMatchObject({ status: 'operational_error', citations: [] });
      expect(invalid.counters).toMatchObject({ answer: 30, judge: 30 });
    } finally {
      await invalid.close();
    }
  });

  it('provider_expiry_and_timeout_are_non_successes_without_retry', async () => {
    const expiryDispatches: string[] = [];
    const expiryUsage: Array<{ inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined> = [];
    let expiredExperimentId: string | undefined;
    const expired = await openRuntime({
      answerError: () => new Error('synthetic-expired-credential'),
      onAnswerDispatch: () => {
        expiryDispatches.push('dispatch');
      },
      onAnswerUsage: usage => {
        expiryUsage.push(usage);
      },
    });
    try {
      const seeded = await seedExperimentDatasets(expired.runtime);
      await expect(
        runNativeExperiment(expired.runtime, {
          family: 'agent',
          version: seeded.agentVersion,
          onExperimentCreated: experiment => {
            expiredExperimentId = experiment.id;
          },
        }),
      ).rejects.toThrow('storage was incomplete');
      expect(expiredExperimentId).toEqual(expect.any(String));
      expect(expiryDispatches).toEqual(['dispatch']);
      expect(expiryUsage).toEqual([undefined]);
      expect(expired.counters.answer).toBe(1);
      expect(expired.counters.judge).toBe(0);
    } finally {
      await expired.close();
    }

    const timedOut = await openRuntime({ providerTimeoutMs: 1, waitForAnswerAbort: true });
    try {
      const seeded = await seedExperimentDatasets(timedOut.runtime);
      await expect(
        runNativeExperiment(timedOut.runtime, { family: 'agent', version: seeded.agentVersion }),
      ).rejects.toThrow('storage was incomplete');
      expect(timedOut.counters.answer).toBe(1);
      expect(timedOut.counters.answerRequests[0]).toMatchObject({
        abortSignal: expect.objectContaining({ aborted: true }),
        maxOutputTokens: 4096,
      });
      expect(timedOut.counters.judge).toBe(0);
    } finally {
      await timedOut.close();
    }
  });

  it('workflow_experiments_measure_retrieval_independently', async () => {
    const fixture = await openRuntime();
    try {
      const seeded = await seedExperimentDatasets(fixture.runtime);
      const run = await runNativeExperiment(fixture.runtime, { family: 'retrieval', version: seeded.retrievalVersion });
      expect(run).toMatchObject({ status: 'completed', storageComplete: true });
      expect(fixture.runtime.observations.size).toBe(0);
      expect(fixture.counters).toMatchObject({ answer: 0, judge: 0 });
      const results = await fixture.runtime.retrievalDataset.listExperimentResults({
        experimentId: run.experimentId,
        page: 0,
        perPage: 100,
      });
      const answerable = results.results.find(
        result => (result.groundTruth as { id: string }).id === 'a01-markdown-retention',
      )!;
      const output = answerable.output as {
        hits: Array<{ metadata?: { recordId?: string; sourceId?: string } }>;
        sources: Array<{ sourceId: string; ready: boolean }>;
      };
      expect(output.hits.some(hit => hit.metadata?.recordId === EVALUATION_CASES[0]!.requiredRecordIds[0])).toBe(true);
      expect(output.sources).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceId: 'local-eval', ready: true })]),
      );
      expect(await nativeRetrievalSummary(fixture.runtime, run.experimentId)).toMatchObject({
        experimentId: run.experimentId,
        cases: expect.arrayContaining([
          expect.objectContaining({ id: 'a01-markdown-retention', requiredRecordRecallAt6: 1, outcome: 'retrieved' }),
        ]),
      });

      const originalSearch = fixture.runtime.index.search.bind(fixture.runtime.index);
      const mutableIndex = fixture.runtime.index as unknown as { search: typeof fixture.runtime.index.search };
      mutableIndex.search = async () => [];
      const empty = await runNativeExperiment(fixture.runtime, {
        family: 'retrieval',
        version: seeded.retrievalVersion,
      });
      mutableIndex.search = originalSearch;
      const emptyResults = await fixture.runtime.retrievalDataset.listExperimentResults({
        experimentId: empty.experimentId,
        page: 0,
        perPage: 100,
      });
      expect((emptyResults.results[0]!.output as { hits: unknown[] }).hits).toEqual([]);
      expect(emptyResults.results.every(result => !result.error)).toBe(true);
      expect(await nativeRetrievalSummary(fixture.runtime, empty.experimentId)).toMatchObject({
        cases: expect.arrayContaining([expect.objectContaining({ outcome: 'empty' })]),
      });

      mutableIndex.search = async () => {
        throw new Error('controlled retrieval failure');
      };
      await expect(
        runNativeExperiment(fixture.runtime, { family: 'retrieval', version: seeded.retrievalVersion }),
      ).rejects.toThrow('result storage was incomplete');
      mutableIndex.search = originalSearch;
      const experiments = await fixture.runtime.retrievalDataset.listExperiments({ page: 0, perPage: 100 });
      const failed = await fixture.runtime.retrievalDataset.listExperimentResults({
        experimentId: experiments.experiments[0]!.id,
        page: 0,
        perPage: 100,
      });
      expect(failed.results[0]?.error).toBeTruthy();
      expect(await nativeRetrievalSummary(fixture.runtime, experiments.experiments[0]!.id)).toMatchObject({
        cases: expect.arrayContaining([expect.objectContaining({ outcome: 'failed' })]),
      });
      expect(fixture.counters).toMatchObject({ answer: 0, judge: 0 });
    } finally {
      await fixture.close();
    }
  });

  it('scorer_experiments_expose_authored_label_disagreement', async () => {
    const calls: OrganizationAnswer[] = [];
    const deliveredEvidence: Array<Array<{ content: string }>> = [];
    const fixture = await openRuntime({
      judge: async input => {
        deliveredEvidence.push(input.evidence);
        return judge(input);
      },
    });
    try {
      const seeded = await seedExperimentDatasets(fixture.runtime);
      const run = await runNativeExperiment(fixture.runtime, {
        family: 'calibration',
        version: seeded.calibrationVersion,
      });
      const results = await fixture.runtime.calibrationDataset.listExperimentResults({
        experimentId: run.experimentId,
        page: 0,
        perPage: 100,
      });
      for (const result of results.results) calls.push((result.input as { answer: OrganizationAnswer }).answer);
      expect(run).toMatchObject({ status: 'completed', storageComplete: true });
      expect(calls).toHaveLength(4);
      expect(calls.find(candidate => candidate.answer.includes('chief executive'))?.status).toBe('answered');
      expect(calls.find(candidate => candidate.answer.includes('fabricated'))?.citations[0]?.recordId).toBe(
        'fabricated-record',
      );
      expect(
        results.results
          .map(result => result.input as { evidence: Array<{ recordId: string; content: string }> })
          .every(candidate => candidate.evidence.length === 1 && (candidate.evidence[0]?.content.length ?? 0) > 0),
      ).toBe(true);
      expect(deliveredEvidence).toHaveLength(4);
      expect(deliveredEvidence.flat().map(item => item.content)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('seven years'),
          expect.stringContaining('records staff'),
          expect.stringContaining('Untrusted document instruction'),
        ]),
      );
      expect(await calibrationSummary(fixture.runtime, run.experimentId)).toMatchObject({
        agreement: 0.75,
        cases: expect.arrayContaining([expect.objectContaining({ id: 'a02-docx-table', disagreement: true })]),
      });
    } finally {
      await fixture.close();
    }
    const invalid = await openRuntime({
      judge: async () =>
        ({
          supportedClaims: 0,
          totalClaims: 0,
          supportedFactIds: ['not-an-authored-fact'],
          unauthorizedBehavior: false,
        }) as never,
    });
    try {
      const seeded = await seedExperimentDatasets(invalid.runtime);
      let invalidExperimentId: string | undefined;
      await expect(
        runNativeExperiment(invalid.runtime, {
          family: 'calibration',
          version: seeded.calibrationVersion,
          onExperimentCreated: experiment => {
            invalidExperimentId = experiment.id;
          },
        }),
      ).rejects.toThrow('storage was incomplete');
      expect(invalidExperimentId).toBeDefined();
      const invalidResults = await invalid.runtime.calibrationDataset.listExperimentResults({
        experimentId: invalidExperimentId!,
        page: 0,
        perPage: 100,
      });
      expect(JSON.stringify(invalidResults.results)).toContain('Groundedness scorer failed.');
    } finally {
      await invalid.close();
    }

    const privateJudgeFailure = 'synthetic-provider-secret-do-not-persist';
    const privateFailure = await openRuntime({
      judge: async () => {
        throw new Error(privateJudgeFailure);
      },
    });
    try {
      const seeded = await seedExperimentDatasets(privateFailure.runtime);
      let privateExperimentId: string | undefined;
      await expect(
        runNativeExperiment(privateFailure.runtime, {
          family: 'calibration',
          version: seeded.calibrationVersion,
          onExperimentCreated: experiment => {
            privateExperimentId = experiment.id;
          },
        }),
      ).rejects.toThrow('storage was incomplete');
      const results = await privateFailure.runtime.calibrationDataset.listExperimentResults({
        experimentId: privateExperimentId!,
        page: 0,
        perPage: 100,
      });
      const scores = await privateFailure.runtime.storage
        .getStore('scores')
        .then(store =>
          store?.listScoresByRunId({ runId: privateExperimentId!, pagination: { page: 0, perPage: 100 } }),
        );
      const persisted = JSON.stringify({ results: results.results, scores });
      expect(persisted).not.toContain(privateJudgeFailure);
      expect(persisted).toContain('Groundedness scorer failed.');
    } finally {
      await privateFailure.close();
    }
  });

  it('experiment_reports_preserve_quality_and_persist_comparisons', async () => {
    const fixture = await openRuntime({
      judge: async input => {
        const result = await judge(input);
        if (input.evaluationCase.id === 'a02-docx-table') return { ...result, supportedClaims: 7, totalClaims: 10 };
        if (input.evaluationCase.id === 'p01-retention-paraphrase') return { ...result, supportedFactIds: [] };
        return result;
      },
    });
    try {
      const seeded = await seedExperimentDatasets(fixture.runtime);
      const agent = await runNativeExperiment(fixture.runtime, { family: 'agent', version: seeded.agentVersion });
      const persistedReport = await readPersistedNativeAgentEvaluationReport(
        fixture.runtime.stateDirectory,
        agent.experimentId,
      );
      expect(persistedReport).toMatchObject({
        caseCount: 30,
        corpusVersion: '2026-09-20.2',
      });
      expect(persistedReport.cases.filter(item => item.failure === 'validation')).toHaveLength(0);
      const evidenceDirectory = join(fixture.runtime.stateDirectory, 'experiment-cases');
      const evidenceFiles = await readdir(evidenceDirectory);
      expect(evidenceFiles).toHaveLength(30);
      const persistedEvidence: Array<{
        experimentId: string;
        itemId: string;
        evaluationCaseId: string;
        correlationId: string;
        observation: {
          answer: OrganizationAnswer;
          evidence: Array<{ recordId: string; locator: string; sourceId: string; content: string }>;
        };
        judge: JudgeResult;
      }> = await Promise.all(
        evidenceFiles.map(async file => JSON.parse(await readFile(join(evidenceDirectory, file), 'utf8'))),
      );
      const resultItems = await fixture.runtime.agentDataset.listExperimentResults({
        experimentId: agent.experimentId,
        page: 0,
        perPage: 100,
      });
      expect(
        resultItems.results.every(result => {
          const output = result.output as { text?: unknown };
          if (typeof output?.text !== 'string' || !output.text) return false;
          const normalized = JSON.parse(output.text) as { status?: unknown; metadata?: { correlationId?: unknown } };
          return typeof normalized.status === 'string' && typeof normalized.metadata?.correlationId === 'string';
        }),
      ).toBe(true);
      expect(
        persistedEvidence.every(
          evidence =>
            evidence.experimentId === agent.experimentId &&
            typeof evidence.correlationId === 'string' &&
            resultItems.results.some(
              result =>
                result.itemId === evidence.itemId &&
                (result.groundTruth as { id: string }).id === evidence.evaluationCaseId,
            ),
        ),
      ).toBe(true);
      const firstEvidenceFile = evidenceFiles[0]!;
      const firstEvidencePath = join(evidenceDirectory, firstEvidenceFile);
      const firstEvidence = await readFile(firstEvidencePath, 'utf8');
      const firstCaseId = (JSON.parse(firstEvidence) as { evaluationCaseId: string }).evaluationCaseId;
      await rm(firstEvidencePath);
      expect(
        (await nativeAgentEvaluationReport(fixture.runtime, agent.experimentId)).cases.find(
          item => item.id === firstCaseId,
        ),
      ).toMatchObject({
        failure: 'generation',
      });
      await writeFile(firstEvidencePath, firstEvidence);
      await writeFile(join(evidenceDirectory, `duplicate-${firstEvidenceFile}`), firstEvidence);
      expect(
        (await nativeAgentEvaluationReport(fixture.runtime, agent.experimentId)).cases.find(
          item => item.id === firstCaseId,
        ),
      ).toMatchObject({
        failure: 'generation',
      });
      await rm(join(evidenceDirectory, `duplicate-${firstEvidenceFile}`));
      const byQuestion = new Map(
        EVALUATION_CASES.map(evaluationCase => [
          evaluationCase.question,
          persistedEvidence.find(item => item.evaluationCaseId === evaluationCase.id)!,
        ]),
      );
      const legacy = await evaluateInstitutionalKnowledge({
        retrieve: async question =>
          byQuestion.get(question)!.observation.evidence.map(item => ({
            metadata: { recordId: item.recordId, locator: item.locator, sourceId: item.sourceId },
            content: item.content,
          })),
        answer: async question => byQuestion.get(question)!.observation.answer,
        judge: async ({ evaluationCase }) => byQuestion.get(evaluationCase.question)!.judge,
      });
      expect(persistedReport.aggregates).toEqual(legacy.aggregates);
      for (const report of [persistedReport, legacy]) {
        expect(report.cases.find(item => item.id === 'a02-docx-table')).toMatchObject({
          supportedClaims: 7,
          totalClaims: 10,
        });
        expect(report.cases.find(item => item.id === 'p01-retention-paraphrase')).toMatchObject({ consistent: false });
      }
      const first = await runNativeExperiment(fixture.runtime, {
        family: 'retrieval',
        version: seeded.retrievalVersion,
      });
      const retrievalItems = await fixture.runtime.retrievalDataset.listItems({ version: seeded.retrievalVersion });
      const retrievalItem = (Array.isArray(retrievalItems) ? retrievalItems : retrievalItems.items)[0]!;
      await fixture.runtime.retrievalDataset.updateItem({
        itemId: retrievalItem.id,
        input: { question: `${String((retrievalItem.input as { question: string }).question)} (comparison revision)` },
        groundTruth: retrievalItem.groundTruth ?? {},
        metadata: retrievalItem.metadata ?? {},
      });
      const second = await runNativeExperiment(fixture.runtime, {
        family: 'retrieval',
        version: (await fixture.runtime.retrievalDataset.getDetails()).version,
      });
      const comparison = await inspectNativeExperiments(fixture.runtime, [first.experimentId, second.experimentId]);
      expect(comparison.items).toHaveLength(EVALUATION_CASES.length);
      expect(comparison.experiments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.experimentId,
            datasetVersion: seeded.retrievalVersion,
            metadata: expect.objectContaining({ concurrency: 1, maxRetries: 0, maxCases: 30 }),
          }),
          expect.objectContaining({
            id: second.experimentId,
            datasetVersion: (await fixture.runtime.retrievalDataset.getDetails()).version,
            metadata: expect.objectContaining({ concurrency: 1, maxRetries: 0, maxCases: 30 }),
          }),
        ]),
      );
      await fixture.runtime.close();
      expect(
        await inspectPersistedExperiments(fixture.runtime.stateDirectory, [first.experimentId, second.experimentId]),
      ).toMatchObject({ items: expect.any(Array) });
    } finally {
      await fixture.close();
    }
  });

  it('experiment_failures_preserve_evidence_without_automatic_retry', async () => {
    let answerDispatches = 0;
    const answerUsage: Array<{ inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined> = [];
    const fixture = await openRuntime({
      onAnswerDispatch: () => {
        answerDispatches++;
      },
      onAnswerUsage: usage => {
        answerUsage.push(usage);
      },
    });
    try {
      const seeded = await seedExperimentDatasets(fixture.runtime);
      await expect(
        runNativeExperiment(fixture.runtime, {
          family: 'retrieval',
          version: seeded.retrievalVersion,
          interruptAfter: 1,
        }),
      ).rejects.toThrow('Experiment interrupted');
      const experiments = await fixture.runtime.retrievalDataset.listExperiments({ page: 0, perPage: 100 });
      expect(experiments.experiments[0]).toMatchObject({ status: 'running' });
      const interrupted = await fixture.runtime.retrievalDataset.listExperimentResults({
        experimentId: experiments.experiments[0]!.id,
        page: 0,
        perPage: 100,
      });
      expect(interrupted.results).toHaveLength(1);
      const interruptedExperimentId = experiments.experiments[0]!.id;
      await fixture.runtime.close();
      fixture.runtime = await createEvaluationExperimentRuntime({
        stateDirectory: fixture.runtime.stateDirectory,
        index: fixture.runtime.index,
        answerModel: answerModel({
          onCall: request => {
            fixture.counters.answer++;
            fixture.counters.answerRequests.push(request);
            fixture.counters.prompts.push(request.prompt);
          },
        }) as never,
        fixtureVersion: seeded.fixtureVersion,
        provenance: {
          indexSnapshotVersion: fixture.runtime.index.lastRun()!.runId,
          answerModel: 'controlled-test-model',
          judgeModel: 'controlled-test-judge',
          rubricVersion: 'test-rubric-v1',
        },
        judge: async input => {
          fixture.counters.judge++;
          return judge(input);
        },
        onAnswerDispatch: () => {
          answerDispatches++;
        },
        onAnswerUsage: usage => {
          answerUsage.push(usage);
        },
      });
      const reopened = await fixture.runtime.retrievalDataset.listExperimentResults({
        experimentId: interruptedExperimentId,
        page: 0,
        perPage: 100,
      });
      expect(reopened.results).toHaveLength(1);
      expect(
        (await fixture.runtime.retrievalDataset.listExperiments({ page: 0, perPage: 100 })).experiments.find(
          experiment => experiment.id === interruptedExperimentId,
        ),
      ).toMatchObject({ status: 'running' });
      let releaseFirst: (() => void) | undefined;
      let firstPersisted!: () => void;
      let pause = true;
      const firstPersistedPromise = new Promise<void>(resolve => {
        firstPersisted = resolve;
      });
      const active = runNativeExperiment(fixture.runtime, {
        family: 'retrieval',
        version: seeded.retrievalVersion,
        onItemPersisted: async () => {
          if (!pause) return;
          pause = false;
          firstPersisted();
          await new Promise<void>(resolve => {
            releaseFirst = resolve;
          });
        },
      });
      await firstPersistedPromise;
      await expect(
        runNativeExperiment(fixture.runtime, { family: 'retrieval', version: seeded.retrievalVersion }),
      ).rejects.toThrow('already active');
      releaseFirst?.();
      await expect(active).resolves.toMatchObject({ status: 'completed' });
      const explicitReplacement = await runNativeExperiment(fixture.runtime, {
        family: 'retrieval',
        version: seeded.retrievalVersion,
      });
      expect(explicitReplacement).toMatchObject({ status: 'completed' });
      expect(explicitReplacement.experimentId).not.toBe(interruptedExperimentId);

      const originalList = fixture.runtime.retrievalDataset.listExperimentResults.bind(
        fixture.runtime.retrievalDataset,
      );
      const mutableDataset = fixture.runtime.retrievalDataset as unknown as {
        listExperimentResults: typeof fixture.runtime.retrievalDataset.listExperimentResults;
      };
      mutableDataset.listExperimentResults = async input => {
        const persisted = await originalList(input);
        return { ...persisted, results: [] };
      };
      await expect(
        runNativeExperiment(fixture.runtime, { family: 'retrieval', version: seeded.retrievalVersion }),
      ).rejects.toThrow('result storage was incomplete');
      mutableDataset.listExperimentResults = originalList;

      const originalScoreList = (await fixture.runtime.storage.getStore('scores'))!.listScoresByRunId.bind(
        (await fixture.runtime.storage.getStore('scores'))!,
      );
      const scores = (await fixture.runtime.storage.getStore('scores'))!;
      scores.listScoresByRunId = async () => ({
        scores: [],
        pagination: { page: 0, perPage: 100, total: 0, hasMore: false },
      });
      const beforeScoreFailure = { ...fixture.counters };
      let partialExperiment: { id: string; datasetVersion: number } | undefined;
      const partialDispatches: string[] = [];
      await expect(
        runNativeExperiment(fixture.runtime, {
          family: 'agent',
          version: seeded.agentVersion,
          onExperimentCreated: experiment => {
            partialExperiment = experiment;
          },
          onItemDispatched: itemId => {
            partialDispatches.push(itemId);
          },
        }),
      ).rejects.toThrow('score storage was incomplete');
      scores.listScoresByRunId = originalScoreList;
      expect(partialExperiment).toBeDefined();
      expect(partialExperiment).toEqual(expect.objectContaining({ id: expect.any(String) }));
      expect(partialDispatches).toHaveLength(1);
      expect(answerDispatches).toBe(1);
      expect(answerUsage).toEqual([{ inputTokens: 1, outputTokens: 1, totalTokens: 2 }]);
      expect(fixture.counters.answer - beforeScoreFailure.answer).toBe(1);
      expect(fixture.counters.judge - beforeScoreFailure.judge).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('experiments_preserve_isolation_and_explicit_call_budgets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'organization-experiment-boundary-'));
    try {
      const operational = join(root, 'operational');
      await mkdir(operational);
      await expect(assertIsolatedEvaluationState(operational, [operational])).rejects.toThrow('must not overlap');
      await symlink(operational, join(root, 'alias'));
      await expect(assertIsolatedEvaluationState(join(root, 'alias'), [operational])).rejects.toThrow(
        'must not overlap',
      );
      const exclusions = await operationalEvaluationExclusions(process.cwd());
      const sourceRoot = exclusions.find(path => path.endsWith('sample-documents'));
      expect(sourceRoot).toBeDefined();
      await expect(assertIsolatedEvaluationState(sourceRoot!, exclusions)).rejects.toThrow('must not overlap');
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const fixture = await openRuntime();
    try {
      const baselineTelemetry = await fixture.runtime.index.telemetry.summary();
      const seeded = await seedExperimentDatasets(fixture.runtime);
      expect(seeded.fixtureVersion).toMatch(/^[a-f0-9]{64}$/);
      expect(fixture.counters).toMatchObject({ answer: 0, judge: 0 });
      expect(await fixture.runtime.index.telemetry.summary()).toEqual(baselineTelemetry);
      await fixture.runtime.close();
      await expect(
        inspectPersistedExperiments(fixture.runtime.stateDirectory, ['missing-one', 'missing-two']),
      ).rejects.toThrow();
      expect(fixture.counters).toMatchObject({ answer: 0, judge: 0 });
      expect(await fixture.runtime.index.telemetry.summary()).toEqual(baselineTelemetry);
    } finally {
      await fixture.close();
    }

    await expect(
      execFileAsync(process.execPath, ['scripts/evaluation-studio.mjs', '--', '--state-dir=-invalid'], {
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('Pass --state-dir') });

    const cliRoot = await mkdtemp(join(tmpdir(), 'organization-evaluation-cli-lease-'));
    try {
      const stateDirectory = join(cliRoot, 'state');
      const runner = join(process.cwd(), 'build', 'eval', 'eval-runner.js');
      const { OPENAI_API_KEY: _key, ...withoutKey } = process.env;
      await execFileAsync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.eval.json'], { cwd: process.cwd() });
      await execFileAsync(process.execPath, [runner, '--mode', 'seed', '--state-dir', stateDirectory], {
        cwd: process.cwd(),
        env: withoutKey,
      });
      const sentinel = '{"preserve":"byte-for-byte"}\n';
      const reportPath = join(stateDirectory, 'evaluation-report.json');
      await writeFile(reportPath, sentinel);
      await mkdir(join(stateDirectory, '.organization-evaluation-run'));
      await expect(
        execFileAsync(process.execPath, [runner, '--mode', 'seed', '--state-dir', stateDirectory], {
          cwd: process.cwd(),
          env: withoutKey,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(await readFile(reportPath, 'utf8')).toBe(sentinel);
      await rm(join(stateDirectory, '.organization-evaluation-run'), { recursive: true, force: true });

      const persisted = await openRuntime({ stateDirectory });
      let firstRetrieval: string;
      let secondRetrieval: string;
      try {
        const seeded = await seedExperimentDatasets(persisted.runtime);
        await runNativeExperiment(persisted.runtime, { family: 'agent', version: seeded.agentVersion });
        firstRetrieval = (
          await runNativeExperiment(persisted.runtime, { family: 'retrieval', version: seeded.retrievalVersion })
        ).experimentId;
        secondRetrieval = (
          await runNativeExperiment(persisted.runtime, { family: 'retrieval', version: seeded.retrievalVersion })
        ).experimentId;
      } finally {
        await persisted.close();
      }

      await execFileAsync(process.execPath, [runner, '--mode', 'seed', '--state-dir', stateDirectory], {
        cwd: process.cwd(),
        env: withoutKey,
      });
      const firstSequentialReport = JSON.parse(await readFile(reportPath, 'utf8')) as {
        settings: { answerCalls: number; mode: string; usage: { answers: unknown } };
      };
      expect(firstSequentialReport.settings).toMatchObject({
        answerCalls: 0,
        mode: 'seed',
        usage: { answers: 'unavailable' },
      });
      const reportBeforeInspect = await readFile(reportPath, 'utf8');
      const inspection = await execFileAsync(
        process.execPath,
        [
          runner,
          '--mode',
          'inspect',
          '--state-dir',
          stateDirectory,
          '--experiment-id',
          firstRetrieval!,
          '--experiment-id',
          secondRetrieval!,
        ],
        { cwd: process.cwd(), env: withoutKey },
      );
      const comparison = JSON.parse(inspection.stdout) as unknown;
      expect(JSON.stringify(comparison)).toContain(firstRetrieval!);
      expect(JSON.stringify(comparison)).toContain(secondRetrieval!);
      expect(await readFile(reportPath, 'utf8')).toBe(reportBeforeInspect);
      await execFileAsync(process.execPath, [runner, '--mode', 'seed', '--state-dir', stateDirectory], {
        cwd: process.cwd(),
        env: withoutKey,
      });
      const secondSequentialReport = JSON.parse(await readFile(reportPath, 'utf8')) as {
        settings: { answerCalls: number; mode: string; usage: { answers: unknown } };
      };
      expect(secondSequentialReport.settings).toMatchObject({
        answerCalls: 0,
        mode: 'seed',
        usage: { answers: 'unavailable' },
      });

      const success = await evaluationRunnerFixture(cliRoot, 'success');
      const successState = join(cliRoot, 'runner-success');
      await expect(
        execFileAsync(process.execPath, [runner, '--allow-live', '--mode', 'agent', '--state-dir', successState], {
          cwd: process.cwd(),
          env: success.env,
        }),
      ).rejects.toMatchObject({ code: 1 });
      const agentReport = JSON.parse(await readFile(join(successState, 'evaluation-report.json'), 'utf8')) as {
        settings: { answerCalls: number; judgeCalls: number; usage: { answers: unknown; judges: unknown } };
      };
      expect(agentReport.settings).toMatchObject({
        answerCalls: 30,
        judgeCalls: 30,
        usage: {
          answers: { inputTokens: 90, outputTokens: 120, totalTokens: 210 },
          judges: { inputTokens: 90, outputTokens: 120, totalTokens: 210 },
        },
      });
      await execFileAsync(
        process.execPath,
        [runner, '--allow-live', '--mode', 'calibration', '--state-dir', successState],
        {
          cwd: process.cwd(),
          env: success.env,
        },
      );
      const calibrationReport = JSON.parse(await readFile(join(successState, 'evaluation-report.json'), 'utf8')) as {
        settings: { answerCalls: number; judgeCalls: number; usage: { answers: unknown; judges: unknown } };
      };
      expect(calibrationReport.settings).toMatchObject({
        answerCalls: 0,
        judgeCalls: 4,
        usage: { answers: 'unavailable', judges: { inputTokens: 12, outputTokens: 16, totalTokens: 28 } },
      });
      const successRequests = (await readFile(success.log, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { body: Record<string, unknown>; path: string });
      const modelRequests = successRequests.filter(request => !request.path.endsWith('/embeddings'));
      expect(modelRequests).toHaveLength(64);
      expect(
        modelRequests.every(
          request =>
            request.body.max_output_tokens === 4096 ||
            request.body.max_completion_tokens === 4096 ||
            request.body.max_tokens === 4096,
        ),
      ).toBe(true);

      const retryableAnswer = await evaluationRunnerFixture(cliRoot, 'retryable-answer');
      const retryableAnswerState = join(cliRoot, 'runner-retryable-answer');
      await expect(
        execFileAsync(
          process.execPath,
          [runner, '--allow-live', '--mode', 'agent', '--state-dir', retryableAnswerState],
          {
            cwd: process.cwd(),
            env: retryableAnswer.env,
          },
        ),
      ).rejects.toMatchObject({ code: 1 });
      expect(JSON.parse(await readFile(join(retryableAnswerState, 'evaluation-report.json'), 'utf8'))).toMatchObject({
        failure: { stage: 'cases' },
        settings: { answerCalls: 1, judgeCalls: 0, usage: { answers: 'partial' } },
      });
      const retryableAnswerRequests = (await readFile(retryableAnswer.log, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { path: string });
      expect(retryableAnswerRequests.filter(request => !request.path.endsWith('/embeddings'))).toHaveLength(1);

      const retryableJudge = await evaluationRunnerFixture(cliRoot, 'retryable-judge');
      const retryableJudgeState = join(cliRoot, 'runner-retryable-judge');
      await expect(
        execFileAsync(
          process.execPath,
          [runner, '--allow-live', '--mode', 'agent', '--state-dir', retryableJudgeState],
          {
            cwd: process.cwd(),
            env: retryableJudge.env,
          },
        ),
      ).rejects.toMatchObject({ code: 1 });
      expect(JSON.parse(await readFile(join(retryableJudgeState, 'evaluation-report.json'), 'utf8'))).toMatchObject({
        failure: { stage: 'cases' },
        settings: { answerCalls: 1, judgeCalls: 1, usage: { judges: 'partial' } },
      });
      const retryableJudgeRequests = (await readFile(retryableJudge.log, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { path: string });
      expect(retryableJudgeRequests.filter(request => !request.path.endsWith('/embeddings'))).toHaveLength(2);

      const expired = await evaluationRunnerFixture(cliRoot, 'expired');
      const expiredState = join(cliRoot, 'runner-expired');
      await expect(
        execFileAsync(process.execPath, [runner, '--allow-live', '--mode', 'agent', '--state-dir', expiredState], {
          cwd: process.cwd(),
          env: expired.env,
        }),
      ).rejects.toMatchObject({ code: 1 });
      const expiredReport = await readFile(join(expiredState, 'evaluation-report.json'), 'utf8');
      expect(expiredReport).not.toContain('fixture-key');
      expect(JSON.parse(expiredReport)).toMatchObject({
        failure: { stage: 'cases' },
        settings: { answerCalls: 1, judgeCalls: 0, usage: { answers: 'partial' } },
      });
      const expiredRequests = (await readFile(expired.log, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { path: string });
      expect(expiredRequests.filter(request => !request.path.endsWith('/embeddings'))).toHaveLength(1);

      const timedOut = await evaluationRunnerFixture(cliRoot, 'timeout');
      const timeoutState = join(cliRoot, 'runner-timeout');
      await expect(
        execFileAsync(process.execPath, [runner, '--allow-live', '--mode', 'retrieval', '--state-dir', timeoutState], {
          cwd: process.cwd(),
          env: timedOut.env,
        }),
      ).rejects.toMatchObject({ code: expect.any(Number) });
      const timeoutReport = JSON.parse(await readFile(join(timeoutState, 'evaluation-report.json'), 'utf8')) as {
        failure: { stage: string };
        settings: { answerCalls: number; judgeCalls: number };
      };
      expect(timeoutReport).toMatchObject({
        failure: { stage: 'synchronization' },
        settings: { answerCalls: 0, judgeCalls: 0 },
      });
      const timeoutRequests = (await readFile(timedOut.log, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { aborted?: boolean; path: string });
      expect(timeoutRequests).not.toHaveLength(0);
      expect(timeoutRequests.every(request => request.path === '/v1/embeddings')).toBe(true);
      expect(timeoutRequests.some(request => request.aborted === true)).toBe(true);

      const reportBeforeInvalidInspection = await readFile(reportPath, 'utf8');
      await expect(
        execFileAsync(
          process.execPath,
          [
            runner,
            '--mode',
            'inspect',
            '--state-dir',
            stateDirectory,
            '--experiment-id',
            'missing-one',
            '--experiment-id',
            'missing-two',
          ],
          { cwd: process.cwd(), env: withoutKey },
        ),
      ).rejects.toMatchObject({ code: 1 });
      expect(await readFile(reportPath, 'utf8')).toBe(reportBeforeInvalidInspection);
    } finally {
      await rm(cliRoot, { recursive: true, force: true });
    }
  });
});
