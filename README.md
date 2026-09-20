# Organization Intelligence

Search local folders and Google Drive records as distinct sources, then return an institutional answer with exact citations, source readiness, and freshness. It gives teams a bounded way to ask policy questions without turning the answer path into a document-writing tool.

## Why we built this

Policies, procedures, and operational records commonly live in separate folders. Keeping those source identities and locators intact makes it possible to inspect why an answer was returned and to refresh records without treating every folder as one anonymous knowledge base.

## Prerequisites

- **[OpenAI API key](https://platform.openai.com/api-keys)**: set `OPENAI_API_KEY` in `.env`. Normalized document text and query embeddings use `text-embedding-3-small`; questions and retrieved excerpts go to the default `gpt-5.6-terra` model. These operations incur provider usage.
- **[Google service-account credentials](https://docs.cloud.google.com/iam/docs/keys-create-delete)**: required for enabled Google Drive sources. Set `GOOGLE_DRIVE_CLIENT_EMAIL` and `GOOGLE_DRIVE_PRIVATE_KEY` from the credential file, enable the Drive and Docs APIs, and share each configured folder with that service account as Viewer.
- **Source catalog**: configure stable source IDs, mounts, and folders in `source-catalog.json`. Folder IDs belong in this catalog, not in `.env`. Disable Drive entries for a local-only run.

## Quickstart 🚀

1. **Create the template**
   - Run `npx create-mastra@latest --template https://github.com/drantunes/template-organization-intelligence` and change into the generated directory.
2. **Configure credentials**
   - Run `cp .env.example .env` and add the values described in Prerequisites.
3. **Start Mastra**
   - Run `pnpm dev:local`.
   - Open [Mastra Studio](http://localhost:4111), select **Organization Agent**, and ask “How long are invoices retained?” The answer includes a source citation and freshness status.

## Try it out

- Ask “How long are invoices retained and who approves archive access?” after adding one record to each of two mounts. The answer can cite both sources instead of flattening them into one result.
- Ask an unrecorded policy question. The agent returns `insufficient_evidence` with no invented citation.
- Edit a local record, then run the `sync-organization-sources` workflow with `{"trigger":"manual"}`. The changed revision becomes searchable without restarting; the scheduled refresh also runs every five minutes.
- Add a native Google Doc with a nested tab or a Google Sheet with multiple nonempty worksheets. Search results retain the originating Drive link and tab or worksheet locator.

## Customization

- Ask a coding agent to explore the project and propose a plan before changing it. For example: “Add a read-only Notion source while preserving source identity, citations, and the containment tests.”
- Replace the sample catalog entries with company folders, or add a provider by extending the catalog schema, identity rule, credential handling, and deterministic source tests.

## API, MCP, and Operations

The Studio agent, HTTP route, and MCP tool use the same grounded answer contract. With the server running:

```sh
curl -sS http://localhost:4111/organization-answer \
-H 'content-type: application/json' \
-d '{"question":"How long are invoices retained?"}'
```

Connect a native Mastra MCP client to `http://localhost:4111/api/mcp/organization-intelligence/mcp` and call `organization_answerOrganizationQuestion`:

```ts
import { MCPClient } from '@mastra/mcp';
import { noopObserve } from '@mastra/core/tools';

const client = new MCPClient({
  servers: {
    organization: {
      url: new URL('http://localhost:4111/api/mcp/organization-intelligence/mcp'),
    },
  },
});
try {
  const tools = await client.listTools();
  const tool = tools.organization_answerOrganizationQuestion;
  if (!tool?.execute) throw new Error('Organization MCP tool is unavailable.');
  const result = await tool.execute({ question: 'How long are invoices retained?' }, { observe: noopObserve });
  console.log(result);
} finally {
  await client.disconnect();
}
```

`GET /organization-telemetry` reports seven days of metadata-only operations. `sourceUtilization` counts sources represented in retrieved answer evidence. The unanswered rate uses completed questions as its denominator, while operational errors are reported separately. Usage is `unavailable` when the provider did not report it and `partial` when only some events reported it. The application does not configure an external span exporter. Questions, answers, excerpts, credentials, and native provider payloads are not stored in this telemetry.

`pnpm eval -- --allow-live --state-dir /tmp/organization-eval` is an explicit bounded live quality run. It creates an isolated synthetic corpus and writes `evaluation-report.json` under the supplied state directory. It permits no more than 30 answer calls and 30 judge calls, both configured with zero retries, plus the embeddings needed for the corpus and questions. The report contains aggregates and settings; its pass criteria are mean required-record recall at least 0.85, supported-claim fraction at least 0.90, every citation resolvable, 5/5 unknown abstentions, 3/3 explicit conflicts, 2/2 safe malicious-document results, and at least 4 consistent paraphrase pairs. It exits nonzero for a failed report or pre-case failure. Live evaluation must meet all listed criteria; deterministic tests do not establish live quality.

The deterministic suite uses controlled native Drive Docs and Sheets transport. The separate `pnpm test:integration` command contacts real Drive sources: enable two synthetic folders and place `f1-drive-smoke.txt` in each with `source=<configured-source-id>`. Missing setup or failed access fails the test. A remote Drive smoke verified inspection of the configured folders; it does not establish native Docs/Sheets extraction or model-quality behavior against remote content.

Indexing supports Markdown, textual PDF, DOCX, and native Google Docs/Sheets, including nested tabs and nonempty worksheets. Each scan is bounded to 1,000 entries per source and depth 32; records, native exports, normalized text, archive inflation, PDF pages, worksheets, cells, and search results also have explicit limits. Image-only PDF pages, OCR, spreadsheet recalculation, and source writes are outside this template’s scope.

Use a source ID only while its provider and root remain the same. When replacing a root, assign a new ID, update `source-catalog.json`, and restart; disabled and removed catalog sources are excluded from search even when cached records remain. If a Drive refresh becomes incomplete after a successful scan, cached evidence remains searchable with a stale warning and last-success time. Only a complete scan reconciles deletions.

The shipped application factory uses fixed local file-backed libSQL state under `.mastra/`. Adapting it for shared durable state, including Turso, requires code changes and verification of the one-writer sync rule, persisted schedules, and BM25/vector rebuild behavior. It is not enabled by `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN` alone.

`pnpm dev:local` performs a frozen-lockfile install, validates configuration, and starts the local server. It preserves `.env`, `source-catalog.json`, and existing derived state across reruns; an install failure prevents the dev server from starting. `pnpm check:env` validates configuration without remote access. `pnpm test` runs deterministic tests, and `pnpm check` runs formatting, linting, type checking, tests, and the build.

To rebuild local derived state, stop every running instance, then remove only `.mastra/organization-intelligence.db` and its `-wal` and `-shm` sidecars plus `.mastra/source-identities.json`. Restart with `pnpm dev`. Preserve `.env`, `source-catalog.json`, and every source folder. Rebuilding discards cached records, embeddings, and schedule/run state and requires a fresh scan and paid embeddings.

## About Mastra templates

This standalone repository uses Mastra workflows, agents, read-only Workspace mounts, and Google Drive ingestion for institutional search. Publication and template-directory attribution have not been established.
