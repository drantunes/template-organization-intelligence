import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Mastra } from '@mastra/core/mastra';
import { describe, expect, it, vi } from 'vitest';

import type { OrganizationAnswer } from '../src/answers.js';
import {
  askOrganizationAgent,
  createOrganizationAgent,
  createOrganizationAnswerRoute,
  createOrganizationTelemetryRoute,
} from '../src/answers.js';
import { createOrganizationApplication } from '../src/application.js';
import { createEvaluationRuntime } from '../src/evaluation-fixtures.js';
import { EVALUATION_CASES, evaluateInstitutionalKnowledge } from '../src/evaluation.js';
import { SourceIndex } from '../src/source-index.js';
import { TELEMETRY_RETENTION_MS } from '../src/telemetry.js';
import { fixedLanguageModel } from './model-fixture.js';

const command = promisify(execFile);
const answerFor = (id: string, status: OrganizationAnswer['status'] = 'answered'): OrganizationAnswer => ({
  status,
  answer: status === 'insufficient_evidence' ? 'The records do not establish this.' : `Synthetic ${id} answer.`,
  citations:
    status === 'insufficient_evidence'
      ? []
      : [
          {
            recordId: id,
            sourceId: 'synthetic',
            path: '/synthetic',
            title: 'Synthetic',
            locator: 'Fact',
            revision: 'v1',
            indexedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
  sourceStatus: [],
  metadata: { correlationId: '00000000-0000-4000-8000-000000000001', retrievalMs: 1, sourceIds: ['synthetic'] },
});

describe('F4 quality, telemetry and repeatability integration', () => {
  it('institutional_knowledge_quality_dimensions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'organization-quality-'));
    const index = new SourceIndex({
      databaseUrl: `file:${join(directory, 'index.db')}`,
      sources: await createEvaluationRuntime(directory, {}),
      embed: async text => {
        const groups = [
          /invoice|retain|retention|kept/,
          /archive|archival|approval|board|records staff|sign off/,
          /travel|receipt/,
          /handbook|tab|weekly|cadence/,
          /invoice|table|owner|capital|second/,
          /budget|worksheet|capital|operating|finance|expense|training/,
          /procurement/,
          /leave|form/,
          /security|incident/,
          /onboarding|people|guide/,
          /c01/,
          /c02/,
          /c03/,
          /malicious|m01/,
          /malicious|m02/,
        ];
        return [...groups.map(group => Number(group.test(text.toLowerCase()))), 0.01];
      },
    });
    await index.initialize();
    expect((await index.sync()).status).toBe('success');
    const ownerField = (await index.search('What is the invoice table owner?')).find(
      hit => hit.metadata.locator === 'Summary!A3:B3',
    );
    expect(ownerField?.content).toContain('A3: Invoice table owner | B3: finance operations');
    const secondWorksheetBudget = (await index.search('What is the budget on worksheet two?')).find(
      hit => hit.metadata.locator === 'Details!A2:B2',
    );
    expect(secondWorksheetBudget?.content).toContain('A2: Budget | B2: Capital plan');
    const strings = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(strings)
          : typeof value === 'object' && value
            ? Object.values(value).flatMap(strings)
            : [];
    const agent = createOrganizationAgent(
      index,
      fixedLanguageModel('', {
        textForCall: call => {
          const text = strings(call.prompt).join('\n');
          const item = EVALUATION_CASES.find(candidate => text.includes(candidate.question));
          const payload = JSON.parse(text.split('\n').find(line => line.includes('"evidence"')) ?? '{}') as {
            evidence?: Array<{ recordId: string; locator: string }>;
          };
          if (!item || item.kind === 'unknown')
            return JSON.stringify({ status: 'insufficient_evidence', answer: 'No evidence.', citations: [] });
          const citations = (payload.evidence ?? [])
            .filter(hit => item.requiredRecordIds.includes(hit.recordId))
            .map(hit => ({ recordId: hit.recordId, locator: hit.locator }));
          return JSON.stringify({
            status: item.kind === 'conflict' ? 'conflicting_evidence' : 'answered',
            answer: item.requiredFacts.join(' '),
            citations,
          });
        },
      }) as never,
      { maxRetries: 0 },
    );
    let judges = 0;
    const report = await evaluateInstitutionalKnowledge({
      retrieve: question => index.search(question),
      answer: question => askOrganizationAgent(agent, question),
      judge: async ({ evaluationCase }) => {
        judges++;
        return {
          supportedClaims: 1,
          totalClaims: 1,
          supportedFactIds: evaluationCase.requiredFacts,
          unauthorizedBehavior: false,
        };
      },
    });
    expect(EVALUATION_CASES).toHaveLength(30);
    expect(judges).toBe(30);
    if (!report.aggregates.passed)
      throw new Error(
        JSON.stringify({
          aggregates: report.aggregates,
          cases: report.cases.filter(
            item => item.failure || !item.citationsResolve || (item.requiredRecordRecallAt6 ?? 1) < 1,
          ),
        }),
      );
    expect(report.aggregates).toMatchObject({
      passed: true,
      unknownAbstention: '5/5',
      conflicts: '3/3',
      maliciousWithoutUnauthorizedBehavior: '2/2',
      consistentParaphrasePairs: 5,
    });
    const invalid = await evaluateInstitutionalKnowledge({
      retrieve: async () => [],
      answer: async () => answerFor('none', 'operational_error'),
      judge: async () => ({
        supportedClaims: 'yes' as never,
        totalClaims: 1,
        supportedFactIds: [],
        unauthorizedBehavior: false,
      }),
    });
    expect(invalid.aggregates.passed).toBe(false);
    expect(invalid.cases.some(item => item.failure === 'validation')).toBe(true);
    const negative = await evaluateInstitutionalKnowledge({
      retrieve: async question => {
        const item = EVALUATION_CASES.find(candidate => candidate.question === question)!;
        return item.requiredRecordIds.map(recordId => ({
          content: 'Retrieved evidence.',
          metadata: { recordId, locator: 'actual', sourceId: 'source' },
        }));
      },
      answer: async question => {
        const item = EVALUATION_CASES.find(candidate => candidate.question === question)!;
        if (item.kind === 'unknown') return answerFor('wrong', 'answered');
        if (item.kind === 'conflict')
          return {
            ...answerFor(item.requiredRecordIds[0]!),
            citations: [
              { ...answerFor(item.requiredRecordIds[0]!).citations[0]!, sourceId: 'source', locator: 'actual' },
            ],
          };
        return {
          ...answerFor(item.requiredRecordIds[0] ?? 'wrong'),
          citations: item.requiredRecordIds.length
            ? [{ ...answerFor(item.requiredRecordIds[0]!).citations[0]!, sourceId: 'source', locator: 'fabricated' }]
            : [],
        };
      },
      judge: async ({ evaluationCase }) => ({
        supportedClaims: 0,
        totalClaims: 1,
        supportedFactIds: evaluationCase.id.startsWith('p') ? ['different fact'] : [],
        unauthorizedBehavior: evaluationCase.kind === 'malicious',
      }),
    });
    expect(negative.aggregates.passed).toBe(false);
    expect(negative.cases.some(item => !item.citationsResolve)).toBe(true);
    expect(negative.cases.find(item => item.kind === 'conflict')?.conflictExplicit).toBe(false);
    expect(negative.cases.find(item => item.kind === 'unknown')?.abstained).toBe(false);
    expect(negative.cases.find(item => item.kind === 'malicious')?.failure).toBe('validation');
    const retrievedForCase = async (question: string) => {
      const item = EVALUATION_CASES.find(candidate => candidate.question === question)!;
      return item.requiredRecordIds.map(recordId => ({
        content: 'Retrieved authored evidence.',
        metadata: { recordId, locator: 'actual', sourceId: 'source' },
      }));
    };
    const completeAnswer = async (question: string): Promise<OrganizationAnswer> => {
      const item = EVALUATION_CASES.find(candidate => candidate.question === question)!;
      if (item.kind === 'unknown') return answerFor('none', 'insufficient_evidence');
      return {
        ...answerFor(item.requiredRecordIds[0]!),
        status: item.kind === 'conflict' ? 'conflicting_evidence' : 'answered',
        citations: item.requiredRecordIds.map(recordId => ({
          ...answerFor(recordId).citations[0]!,
          recordId,
          sourceId: 'source',
          locator: 'actual',
        })),
      };
    };
    const groundedJudge = async ({ evaluationCase }: { evaluationCase: (typeof EVALUATION_CASES)[number] }) => ({
      supportedClaims: 1,
      totalClaims: 1,
      supportedFactIds: evaluationCase.requiredFacts,
      unauthorizedBehavior: false,
    });
    const incompleteConflict = await evaluateInstitutionalKnowledge({
      retrieve: retrievedForCase,
      answer: async question => {
        const result = await completeAnswer(question);
        return result.status === 'conflicting_evidence'
          ? { ...result, citations: result.citations.slice(0, 1) }
          : result;
      },
      judge: groundedJudge,
    });
    expect(incompleteConflict.aggregates.passed).toBe(false);
    expect(
      incompleteConflict.cases.filter(item => item.kind === 'conflict').every(item => !item.conflictExplicit),
    ).toBe(true);
    const unsupportedExtraClaim = await evaluateInstitutionalKnowledge({
      retrieve: retrievedForCase,
      answer: completeAnswer,
      judge: async input => ({
        ...(await groundedJudge(input)),
        ...(input.evaluationCase.id === 'a01-markdown-retention' ? { supportedClaims: 1, totalClaims: 2 } : {}),
      }),
    });
    expect(unsupportedExtraClaim.cases.find(item => item.id === 'a01-markdown-retention')).toMatchObject({
      supportedClaims: 1,
      totalClaims: 2,
    });
    const partiallySupportedParaphrases = await evaluateInstitutionalKnowledge({
      retrieve: retrievedForCase,
      answer: completeAnswer,
      judge: async input => ({
        ...(await groundedJudge(input)),
        ...(input.evaluationCase.kind === 'paraphrase' ? { totalClaims: 2 } : {}),
      }),
    });
    expect(partiallySupportedParaphrases.aggregates).toMatchObject({
      consistentParaphrasePairs: 5,
      supportedClaimFraction: 0.8,
      passed: false,
    });
    const contradictoryJudge = await evaluateInstitutionalKnowledge({
      retrieve: retrievedForCase,
      answer: completeAnswer,
      judge: async input =>
        input.evaluationCase.id === 'p05-sheet-paraphrase'
          ? {
              supportedClaims: 0,
              totalClaims: 1,
              supportedFactIds: input.evaluationCase.requiredFacts,
              unauthorizedBehavior: false,
            }
          : groundedJudge(input),
    });
    expect(contradictoryJudge.cases.find(item => item.id === 'p05-sheet-paraphrase')).toMatchObject({
      failure: 'validation',
    });
    const multiFactSingleClaim = await evaluateInstitutionalKnowledge({
      retrieve: retrievedForCase,
      answer: completeAnswer,
      judge: groundedJudge,
    });
    expect(multiFactSingleClaim.cases.find(item => item.id === 'a07-cross-source')).toMatchObject({
      supportedClaims: 1,
      supportedFactIds: ['board approval', 'records staff approval'],
    });
    expect(multiFactSingleClaim.cases.find(item => item.id === 'a07-cross-source')?.failure).toBeUndefined();
    const operational = await evaluateInstitutionalKnowledge({
      retrieve: retrievedForCase,
      answer: async question =>
        question === EVALUATION_CASES[0]!.question ? answerFor('none', 'operational_error') : completeAnswer(question),
      judge: groundedJudge,
    });
    expect(operational.cases[0]).toMatchObject({ failure: 'validation' });
    expect(operational.aggregates.passed).toBe(false);
    const safeRefusal = await evaluateInstitutionalKnowledge({
      retrieve: retrievedForCase,
      answer: completeAnswer,
      judge: async input =>
        input.evaluationCase.kind === 'malicious'
          ? { supportedClaims: 0, totalClaims: 0, supportedFactIds: [], unauthorizedBehavior: false }
          : groundedJudge(input),
    });
    expect(safeRefusal.aggregates).toMatchObject({ maliciousWithoutUnauthorizedBehavior: '2/2', passed: true });
    const unauthorized = await evaluateInstitutionalKnowledge({
      retrieve: retrievedForCase,
      answer: completeAnswer,
      judge: async input =>
        input.evaluationCase.kind === 'malicious'
          ? { supportedClaims: 0, totalClaims: 0, supportedFactIds: [], unauthorizedBehavior: true }
          : groundedJudge(input),
    });
    expect(unauthorized.aggregates.passed).toBe(false);
    expect(
      unauthorized.cases.filter(item => item.kind === 'malicious').every(item => item.failure === 'validation'),
    ).toBe(true);
    const unrelatedParaphraseFacts = await evaluateInstitutionalKnowledge({
      retrieve: retrievedForCase,
      answer: completeAnswer,
      judge: async input =>
        input.evaluationCase.kind === 'paraphrase'
          ? { supportedClaims: 1, totalClaims: 1, supportedFactIds: [], unauthorizedBehavior: false }
          : groundedJudge(input),
    });
    expect(unrelatedParaphraseFacts.aggregates).toMatchObject({ consistentParaphrasePairs: 0, passed: false });
    await index.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('telemetry_omits_credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'organization-telemetry-'));
    let now = new Date('2026-01-01T00:00:00.000Z');
    const runtime = await createEvaluationRuntime(directory, {});
    await writeFile(
      join(directory, 'corpus', 'local', 'private.md'),
      'PRIVATE_EXCERPT_SENTINEL: retain this document.',
    );
    const strings = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(strings)
          : typeof value === 'object' && value
            ? Object.values(value).flatMap(strings)
            : [];
    const answerModel = fixedLanguageModel('', {
      textForCall: call => {
        const text = strings(call.prompt).join('\n');
        const payload = JSON.parse(text.split('\n').find(line => line.includes('"evidence"')) ?? '{}') as {
          evidence?: Array<{ recordId: string; locator: string }>;
        };
        return JSON.stringify({
          status: 'answered',
          answer: 'PRIVATE_ANSWER_SENTINEL: invoices are retained for seven years.',
          citations: (payload.evidence ?? [])
            .slice(0, 2)
            .map(hit => ({ recordId: hit.recordId, locator: hit.locator })),
        });
      },
    });
    const app = await createOrganizationApplication({
      projectRoot: directory,
      environment: {
        OPENAI_API_KEY: 'PRIVATE_OPENAI_KEY_SENTINEL',
        GOOGLE_DRIVE_CLIENT_EMAIL: 'PRIVATE_EMAIL_SENTINEL',
        GOOGLE_DRIVE_PRIVATE_KEY: 'PRIVATE_KEY_SENTINEL',
      },
      sources: runtime,
      embed: async text => [Number(/invoice|retain|retention|kept/.test(text.toLowerCase())), 0.01],
      answerModel: answerModel as never,
      now: () => now,
    });
    expect(app.config).not.toHaveProperty('observability');
    const nativeMastra = new Mastra(app.config);
    expect(nativeMastra.observability.getDefaultInstance()).toBeUndefined();
    expect(nativeMastra.observability.listInstances().size).toBe(0);
    await app.index.initialize();
    expect((await app.index.sync()).status).toBe('success');
    const question = 'How long are invoices retained? PRIVATE_QUESTION_SENTINEL';
    expect((await askOrganizationAgent(app.organizationAgent, question)).status).toBe('answered');
    await app.organizationAgent.generate(question, { maxSteps: 1, toolChoice: 'none' });
    const stream = await app.organizationAgent.stream(question, { maxSteps: 1, toolChoice: 'none' });
    for await (const _part of stream.fullStream) {
      // Drain the native stream so the finish processor records the query.
    }
    expect(
      await app.mcpServer.executeTool('answerOrganizationQuestion', {
        question,
      }),
    ).toMatchObject({ status: 'answered' });
    const answerRoute = createOrganizationAnswerRoute(app.organizationAgent) as unknown as {
      handler: (context: {
        req: { json: () => Promise<unknown> };
        json: (body: unknown, status?: number) => Response;
      }) => Promise<Response>;
    };
    expect(
      await (
        await answerRoute.handler({
          req: { json: async () => ({ question }) },
          json: (body, status) => Response.json(body, { status }),
        })
      ).json(),
    ).toMatchObject({ status: 'answered' });
    const unknown = createOrganizationAgent(
      app.index,
      fixedLanguageModel(JSON.stringify({ status: 'insufficient_evidence', answer: 'No evidence.', citations: [] }), {
        usage: {},
      }) as never,
      { maxRetries: 0 },
    );
    expect((await askOrganizationAgent(unknown, 'Unknown PRIVATE_QUESTION_SENTINEL')).status).toBe(
      'insufficient_evidence',
    );
    const failing = createOrganizationAgent(
      app.index,
      fixedLanguageModel('', { error: new Error('PRIVATE_PROVIDER_ERROR_SENTINEL') }) as never,
      { maxRetries: 0 },
    );
    expect((await askOrganizationAgent(failing, question)).status).toBe('operational_error');
    const telemetryRoute = createOrganizationTelemetryRoute(app.index) as unknown as {
      handler: (context: { json: (body: unknown, status?: number) => Response }) => Promise<Response>;
    };
    const summary = await (
      await telemetryRoute.handler({ json: (body, status) => Response.json(body, { status }) })
    ).json();
    expect(summary).toMatchObject({
      completedQuestions: 6,
      insufficientEvidence: 1,
      operationalErrors: 1,
      usage: 'partial',
      cost: 'unavailable',
      sourceUtilization: expect.objectContaining({ 'local-eval': expect.any(Number) }),
      syncRuns: [expect.objectContaining({ status: 'success', sources: expect.any(Array) })],
    });
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url: 'file:' + join(directory, '.mastra', 'organization-intelligence.db') });
    const queryRows = await client.execute('SELECT data FROM oi_query_telemetry ORDER BY recorded_at');
    const runRows = await client.execute('SELECT data FROM oi_runs ORDER BY finished_at');
    const persisted = JSON.stringify({ queries: queryRows.rows, runs: runRows.rows });
    expect(queryRows.rows).toHaveLength(7);
    const events = queryRows.rows.map(row => JSON.parse(String(row.data)) as Record<string, unknown>);
    expect(new Set(events.map(event => event.correlationId))).toHaveLength(7);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'answered', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
        expect.objectContaining({ status: 'insufficient_evidence', usage: 'unavailable' }),
        expect.objectContaining({ status: 'operational_error', usage: 'unavailable' }),
      ]),
    );
    for (const sentinel of [
      'PRIVATE_OPENAI_KEY_SENTINEL',
      'PRIVATE_EMAIL_SENTINEL',
      'PRIVATE_KEY_SENTINEL',
      'PRIVATE_QUESTION_SENTINEL',
      'PRIVATE_ANSWER_SENTINEL',
      'PRIVATE_EXCERPT_SENTINEL',
      'PRIVATE_PROVIDER_ERROR_SENTINEL',
      'synthetic-access-token',
    ])
      expect(persisted).not.toContain(sentinel);
    expect(runRows.rows).toHaveLength(1);
    expect(JSON.parse(String(runRows.rows[0]!.data))).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ sourceId: 'local-eval', discovered: expect.any(Number) }),
        expect.objectContaining({ sourceId: 'drive-eval', discovered: expect.any(Number) }),
      ]),
    });
    client.close();
    const originalRecord = app.index.telemetry.recordQuery.bind(app.index.telemetry);
    app.index.telemetry.recordQuery = async () => {
      throw new Error('recorder unavailable');
    };
    expect((await askOrganizationAgent(app.organizationAgent, question)).status).toBe('answered');
    app.index.telemetry.recordQuery = originalRecord;
    const originalCleanup = app.index.telemetry.cleanup.bind(app.index.telemetry);
    app.index.telemetry.cleanup = async () => {
      throw new Error('cleanup unavailable');
    };
    expect((await app.index.sync()).status).toBe('success');
    app.index.telemetry.cleanup = originalCleanup;
    now = new Date(now.getTime() + TELEMETRY_RETENTION_MS + 1);
    expect(await app.index.telemetry.summary()).toMatchObject({ completedQuestions: 0, syncRuns: [] });
    expect((await app.index.sync()).status).toBe('success');
    expect((await app.index.telemetry.summary()).syncRuns).toHaveLength(1);
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('tutorial_source_replacement_preserves_query_contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'organization-tutorial-'));
    const retained = join(directory, 'retained');
    const retired = join(directory, 'retired');
    const replacement = join(directory, 'replacement');
    await Promise.all([mkdir(retained), mkdir(retired), mkdir(replacement)]);
    await Promise.all([
      writeFile(join(retained, 'retained.md'), 'Retained policy: manager review takes seven days.'),
      writeFile(join(retired, 'retired.md'), 'Retired policy: archive approval is obsolete.'),
      writeFile(join(replacement, 'replacement.md'), 'Replacement policy: procurement review takes two days.'),
    ]);
    const environment = { OPENAI_API_KEY: 'controlled-tutorial-key' };
    const catalogPath = join(directory, 'source-catalog.json');
    const writeCatalog = async (sources: Array<{ id: string; mountPath: string; root: string }>) =>
      writeFile(
        catalogPath,
        JSON.stringify({
          version: 1,
          sources: sources.map(source => ({ ...source, provider: 'local', enabled: true })),
        }),
      );
    const strings = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(strings)
          : typeof value === 'object' && value
            ? Object.values(value).flatMap(strings)
            : [];
    const answerModel = fixedLanguageModel('', {
      textForCall: call => {
        const prompt = strings(call.prompt).join('\n');
        const payload = JSON.parse(prompt.split('\n').find(line => line.includes('"evidence"')) ?? '{}') as {
          evidence?: Array<{ recordId: string; locator: string; excerpt: string }>;
        };
        const evidence = payload.evidence ?? [];
        return JSON.stringify({
          status: evidence.length ? 'answered' : 'insufficient_evidence',
          answer: evidence[0]?.excerpt ?? 'No evidence.',
          citations: evidence.slice(0, 1).map(hit => ({ recordId: hit.recordId, locator: hit.locator })),
        });
      },
    });
    const embed = async (text: string) => [
      Number(/retained|manager|seven|eight/.test(text.toLowerCase())),
      Number(/retired|archive|obsolete/.test(text.toLowerCase())),
      Number(/replacement|procurement|two/.test(text.toLowerCase())),
      0.01,
    ];
    await writeCatalog([
      { id: 'retained', mountPath: '/retained', root: retained },
      { id: 'retired', mountPath: '/retired', root: retired },
    ]);
    const app1 = await createOrganizationApplication({
      projectRoot: directory,
      environment,
      embed,
      answerModel: answerModel as never,
    });
    const mastra1 = new Mastra(app1.config);
    await mastra1.startWorkers();
    expect(await mastra1.schedules.list()).toHaveLength(1);
    expect((await askOrganizationAgent(app1.organizationAgent, 'archive obsolete')).citations[0]).toMatchObject({
      sourceId: 'retired',
    });
    const retainedBefore = (await askOrganizationAgent(app1.organizationAgent, 'manager seven')).citations[0]!;
    await mastra1.stopWorkers();
    await app1.close();
    await writeCatalog([
      { id: 'retained', mountPath: '/retained', root: retained },
      { id: 'replacement', mountPath: '/replacement', root: replacement },
    ]);
    const app2 = await createOrganizationApplication({
      projectRoot: directory,
      environment,
      embed,
      answerModel: answerModel as never,
    });
    const mastra2 = new Mastra(app2.config);
    await mastra2.startWorkers();
    expect(await mastra2.schedules.list()).toHaveLength(1);
    expect((await app2.index.search('archive obsolete')).some(hit => hit.metadata.sourceId === 'retired')).toBe(false);
    const retainedAfter = (await askOrganizationAgent(app2.organizationAgent, 'manager seven')).citations[0]!;
    expect(retainedAfter).toMatchObject({ sourceId: 'retained' });
    expect(retainedAfter).toMatchObject({ recordId: retainedBefore.recordId, locator: retainedBefore.locator });
    expect((await askOrganizationAgent(app2.organizationAgent, 'procurement two')).citations[0]).toMatchObject({
      sourceId: 'replacement',
    });
    const mcp = await app2.mcpServer.executeTool('answerOrganizationQuestion', { question: 'procurement two' });
    expect(mcp).toMatchObject({ citations: [expect.objectContaining({ sourceId: 'replacement' })] });
    const route = createOrganizationAnswerRoute(app2.organizationAgent) as unknown as {
      handler: (context: {
        req: { json: () => Promise<unknown> };
        json: (body: unknown, status?: number) => Response;
      }) => Promise<Response>;
    };
    expect(
      await (
        await route.handler({
          req: { json: async () => ({ question: 'procurement two' }) },
          json: (body, status) => Response.json(body, { status }),
        })
      ).json(),
    ).toMatchObject({ citations: [expect.objectContaining({ sourceId: 'replacement' })] });
    const runId = app2.index.lastRun()?.runId;
    const schedule = (await mastra2.schedules.list())[0]!;
    await writeFile(join(retained, 'retained.md'), 'Retained policy: manager review takes eight days.');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(schedule.nextFireAt + 1);
    await mastra2.scheduler!.tick();
    await vi.waitFor(() => expect(app2.index.lastRun()?.runId).not.toBe(runId));
    vi.useRealTimers();
    expect((await app2.index.search('manager eight')).some(hit => hit.content.includes('eight days'))).toBe(true);
    await mastra2.stopWorkers();
    await app2.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('local_bootstrap_and_checks_are_reproducible', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'organization-bootstrap-'));
    const bin = join(directory, 'bin');
    const log = join(directory, 'calls.log');
    await mkdir(join(directory, '.mastra'), { recursive: true });
    await mkdir(bin);
    await Promise.all([
      writeFile(join(directory, '.env'), 'BOOTSTRAP_ENV_SENTINEL=yes\n'),
      writeFile(join(directory, 'source-catalog.json'), '{"sentinel":"BOOTSTRAP_CATALOG_SENTINEL"}\n'),
      writeFile(join(directory, '.mastra', 'state'), 'BOOTSTRAP_STATE_SENTINEL\n'),
    ]);
    const fakePnpm = join(bin, 'pnpm');
    await writeFile(
      fakePnpm,
      `#!/bin/sh\nprintf '%s\\n' \"$*\" >> '${log}'\nif [ \"$BOOTSTRAP_FAIL\" = install ] && [ \"$1\" = install ]; then exit 17; fi\nif [ \"$BOOTSTRAP_FAIL\" = dev ] && [ \"$1\" = dev ]; then exit 19; fi\nexit 0\n`,
    );
    await chmod(fakePnpm, 0o755);
    const script = fileURLToPath(new URL('../scripts/bootstrap.mjs', import.meta.url));
    const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    await command(process.execPath, [script], { cwd: directory, env: environment });
    await command(process.execPath, [script], { cwd: directory, env: environment });
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
      'install --frozen-lockfile',
      'dev',
      'install --frozen-lockfile',
      'dev',
    ]);
    await expect(readFile(join(directory, '.env'), 'utf8')).resolves.toContain('BOOTSTRAP_ENV_SENTINEL');
    await expect(readFile(join(directory, 'source-catalog.json'), 'utf8')).resolves.toContain(
      'BOOTSTRAP_CATALOG_SENTINEL',
    );
    await expect(readFile(join(directory, '.mastra', 'state'), 'utf8')).resolves.toContain('BOOTSTRAP_STATE_SENTINEL');
    await writeFile(log, '');
    await expect(
      command(process.execPath, [script], { cwd: directory, env: { ...environment, BOOTSTRAP_FAIL: 'install' } }),
    ).rejects.toMatchObject({ code: 17 });
    expect(await readFile(log, 'utf8')).toBe('install --frozen-lockfile\n');
    await writeFile(log, '');
    await expect(
      command(process.execPath, [script], { cwd: directory, env: { ...environment, BOOTSTRAP_FAIL: 'dev' } }),
    ).rejects.toMatchObject({ code: 19 });
    expect(await readFile(log, 'utf8')).toBe('install --frozen-lockfile\ndev\n');
    const checkDirectory = join(directory, 'check');
    const checkBin = join(checkDirectory, 'bin');
    const checkLog = join(checkDirectory, 'stages.log');
    await mkdir(checkBin, { recursive: true });
    const packageJson = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };
    await writeFile(
      join(checkDirectory, 'package.json'),
      JSON.stringify({ name: 'controlled-check', version: '0.0.0', scripts: packageJson.scripts }),
    );
    const stageScript = `#!/bin/sh\nstage=$(basename \"$0\")\nprintf '%s\\n' \"$stage\" >> '${checkLog}'\nif [ \"$CHECK_FAIL_STAGE\" = \"$stage\" ]; then exit 23; fi\n`;
    const stages = ['oxfmt', 'oxlint', 'eslint', 'tsc', 'vitest', 'mastra'];
    await Promise.all(
      stages.map(async stage => {
        const executable = join(checkBin, stage);
        await writeFile(executable, stageScript);
        await chmod(executable, 0o755);
      }),
    );
    const pnpmCli = (await command('which', ['pnpm'])).stdout.trim();
    const checkEnvironment = { ...process.env, PATH: `${checkBin}:${process.env.PATH}` };
    await command(pnpmCli, ['--dir', checkDirectory, 'check'], { env: checkEnvironment });
    expect((await readFile(checkLog, 'utf8')).trim().split('\n')).toEqual(stages);
    for (const [index, stage] of stages.entries()) {
      await writeFile(checkLog, '');
      await expect(
        command(pnpmCli, ['--dir', checkDirectory, 'check'], {
          env: { ...checkEnvironment, CHECK_FAIL_STAGE: stage },
        }),
      ).rejects.toMatchObject({ code: 23 });
      expect((await readFile(checkLog, 'utf8')).trim().split('\n')).toEqual(stages.slice(0, index + 1));
    }
    await rm(directory, { recursive: true, force: true });
  });

  it('evaluation_cli_rejects_invalid_arguments_without_provider_access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'organization-eval-cli-'));
    await command('pnpm', ['exec', 'tsc', '-p', 'tsconfig.eval.json']);
    const runner = fileURLToPath(new URL('../build/eval/eval-runner.js', import.meta.url));
    const { OPENAI_API_KEY: _key, ...withoutKey } = process.env;
    await expect(
      command(process.execPath, [runner, '--allow-live', '--state-dir'], { env: withoutKey }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      command(process.execPath, [runner, '--allow-live', '--state-dir=--not-a-directory'], { env: withoutKey }),
    ).rejects.toMatchObject({ code: 1 });
    const stateDirectory = join(directory, 'state');
    await expect(
      command(process.execPath, [runner, '--', '--allow-live', '--state-dir', stateDirectory], { env: withoutKey }),
    ).rejects.toMatchObject({ code: 1 });
    const report = JSON.parse(await readFile(join(stateDirectory, 'evaluation-report.json'), 'utf8')) as {
      settings: { answerCalls: number; judgeCalls: number; embeddingCalls: number };
      failure: { stage: string; reason: string };
    };
    expect(report.settings).toMatchObject({ answerCalls: 0, judgeCalls: 0, embeddingCalls: 0 });
    expect(report.failure).toEqual({ stage: 'environment', reason: 'Evaluation environment did not complete.' });
    await rm(directory, { recursive: true, force: true });
  });
});
