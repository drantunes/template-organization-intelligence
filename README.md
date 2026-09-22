# Organization Intelligence

Search local folders, Google Drive, and private S3-compatible object storage as distinct sources, then return an institutional answer with exact citations, source readiness, and freshness. One Mastra Workspace exposes the configured mounts while one index and one answer contract serve Studio, HTTP, and MCP consumers.

## Why we built this

Policies, procedures, and operational records commonly live in different folders and systems. Keeping source identities and mounted locators intact makes an answer inspectable and lets a refresh update changed records without turning every source into one anonymous knowledge base.

## Prerequisites

- **[OpenAI API key](https://platform.openai.com/api-keys)**: set `OPENAI_API_KEY` in `.env`. Normalized document text and query embeddings use `text-embedding-3-small`; questions and retrieved excerpts go to the default `gpt-5.6-terra` model. These operations incur provider usage.
- **[Google service-account credentials](https://docs.cloud.google.com/iam/docs/keys-create-delete)**: required for enabled Google Drive sources. Set `GOOGLE_DRIVE_CLIENT_EMAIL` and `GOOGLE_DRIVE_PRIVATE_KEY` from the credential file, enable the Drive and Docs APIs, and share each configured folder with that service account as Viewer.
- **[Cloudflare R2 API token](https://developers.cloudflare.com/r2/api/tokens/)**: required for enabled S3 sources. Set `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` from a bucket-scoped Object Read token. The supported reference configuration uses a private R2 bucket, region `auto`, and a catalog endpoint such as `https://<account-id>.r2.cloudflarestorage.com`.
- **Source catalog**: configure stable source IDs, mounts, provider roots, and R2 endpoint/bucket/prefix in `source-catalog.json`. Credentials stay in `.env`. `source-catalog.example.json` shows a combined local, Drive, and R2 layout. Disable remote entries for a local-only run.

## Quickstart 🚀

1. **Create the template**
   - Run `npx create-mastra@latest --template https://github.com/drantunes/template-organization-intelligence` and change into the generated directory.
2. **Configure credentials**
   - Run `cp .env.example .env` and add the values described in Prerequisites.
   - Start with the existing `source-catalog.json`, or adapt `source-catalog.example.json` with your stable mounts and roots.
3. **Start Mastra**
   - Run `pnpm dev:local`.
   - Open [Mastra Studio](http://localhost:4111), select **Organization Agent**, and ask “How long are invoices retained?” The answer includes a source citation and freshness status.

## Try it out

- Ask “How long are invoices retained and who approves archive access?” after adding one record to Drive and one record to R2. The answer can cite both mounted sources instead of flattening them into one result.
- Ask an unrecorded policy question. The agent returns `insufficient_evidence` with no invented citation.
- Edit a local record, then run the `sync-organization-sources` workflow with `{"trigger":"manual"}`. The changed revision becomes searchable without restarting; the scheduled refresh also runs every five minutes.
- Add a native Google Doc with a nested tab or a Google Sheet with multiple nonempty worksheets. Search results retain the originating Drive link and tab or worksheet locator.
- Change an R2 object with separate operator write authority, then run `sync-organization-sources` with `{"trigger":"manual"}`. The next answer uses the committed changed revision. Private R2 citations use the mounted path and do not invent a download URL.

## Customization

- Ask a coding agent to explore the project and propose a plan before changing it. For example: “Add a read-only source while preserving source identity, citations, and containment tests.”
- Replace the sample catalog entries with company folders or a private R2 prefix. A changed R2 endpoint, bucket, or prefix requires a new source ID or a derived-state rebuild because existing cached evidence remains bound to the original root.

## Multiple Source Setup

Local, Drive, and R2 mounts share `workspace.filesystem`. A configured S3 source uses `provider: "s3"`, a distinct `mountPath`, its private R2 `endpoint`, `bucket`, `region: "auto"`, and an optional contained `prefix`. The runtime accepts only HTTPS R2 account endpoints, requires explicitly supplied credentials, and denies application writes. Configure the R2 token itself with bucket-scoped Object Read permission so it can list and read only the intended bucket. It does not discover ambient AWS credentials or generate signed URLs.

```ts
const filesystem = application.sources.workspace.filesystem!;
const [driveNames, archiveNames, archiveRecord] = await Promise.all([
  filesystem.readdir('/drive/policies'),
  filesystem.readdir('/archive'),
  filesystem.readFile('/archive/retention.md', { encoding: 'utf8' }),
]);
console.log(driveNames, archiveNames, archiveRecord);
```

S3 scans accept Markdown, text-bearing PDF, and DOCX. Drive keeps its native Docs and Sheets export path. Each S3 scan limits listing to 1,000 entries, depth 32, and 100 pages; bounded reads reject input above 20 MiB and inspection above 64 KiB. A complete scan is required before missing objects are removed. Failed or incomplete remote refreshes leave prior evidence available with a stale status.

For a real simultaneous Drive/R2 smoke, prepare a private operator fixture JSON outside this repository. It names an isolated state directory, the mounted Drive and R2 files to inspect, an authored cross-provider question, its required source IDs and facts, and one `initial` or `changed` stage. The changed fixture uses the same catalog and state directory after the operator changes the R2 object with separate write authority.

```json
{
  "catalogPath": "./simultaneous-catalog.json",
  "stateDirectory": "./smoke-state",
  "stage": "initial",
  "question": "What do the Drive policy and archive record require?",
  "driveMountedPath": "/drive/policies/retention.md",
  "s3MountedPath": "/archive/retention.md",
  "expected": {
    "sources": ["policies", "archive"],
    "facts": ["seven years", "records staff"],
    "absentFacts": [],
    "mounted": {
      "driveContent": "Drive policy: records staff approve archive access.",
      "s3Content": "R2 archive: retain invoices for seven years.",
      "s3Revision": "\"operator-recorded-r2-etag\""
    }
  },
  "maximumEmbeddings": 20
}
```

Run `S3_R2_SMOKE_FIXTURE_PATH=/absolute/path/initial.json pnpm test:s3-r2:smoke`. For the next stage, change the same R2 object using separate operator write authority, record its new ETag and exact content in a second fixture with `"stage": "changed"`, add the old fact to `absentFacts`, then run `S3_R2_SMOKE_FIXTURE_PATH=/absolute/path/changed.json pnpm test:s3-r2:smoke`. The changed stage requires the initial marker, the same catalog/root/path, and different R2 revision and content. The command validates the common File API list/stat/read values before model work; it makes at most 20 one-attempt embedding requests and three answer calls with zero model retries and a 4,096-token output bound. It writes observed revision, citations, answer/embedding counts, and provider usage metadata under the isolated fixture state directory. Missing setup fails before paid calls. This repository does not claim a live smoke result.

For example, keep the Drive text unchanged and change only the R2 fields below in `changed.json`; replace the illustrative ETag with the exact ETag returned by R2.

```json
{
  "catalogPath": "./simultaneous-catalog.json",
  "stateDirectory": "./smoke-state",
  "stage": "changed",
  "question": "What do the Drive policy and archive record require now?",
  "driveMountedPath": "/drive/policies/retention.md",
  "s3MountedPath": "/archive/retention.md",
  "expected": {
    "sources": ["policies", "archive"],
    "facts": ["nine years", "records staff"],
    "absentFacts": ["seven years"],
    "mounted": {
      "driveContent": "Drive policy: records staff approve archive access.",
      "s3Content": "R2 archive: retain invoices for nine years.",
      "s3Revision": "\"operator-recorded-new-r2-etag\""
    }
  },
  "maximumEmbeddings": 20
}
```

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

## Evaluation Experiments

Experiments use the same Organization Agent, retrieval workflow, and groundedness judge as the quality run. Each run uses a versioned synthetic dataset in the supplied state directory. The runner evaluates one target family at a time, dispatches one item at a time, allows no automatic retries, and verifies persisted results and scores before dispatching the next item.

- Run `pnpm eval -- --mode seed --state-dir /tmp/organization-experiments` to create or reuse versioned synthetic datasets without model, embedding, source-provider, or scheduled work.
- Run `pnpm eval -- --allow-live --mode agent --state-dir /tmp/organization-experiments` for the bounded C-07 answer experiment. The default mode is `agent`, so the existing `pnpm eval -- --allow-live --state-dir ...` command remains valid.
- Run `pnpm eval -- --allow-live --mode retrieval --state-dir /tmp/organization-experiments` to measure the registered search workflow without answer or judge generation. Run `pnpm eval -- --allow-live --mode calibration --state-dir /tmp/organization-experiments` to score the versioned stored candidates without regenerating answers.
- Run `pnpm eval -- --mode inspect --state-dir /tmp/organization-experiments --experiment-id <first-id> --experiment-id <second-id>` to compare two persisted native experiment records. This mode opens no sources and makes no provider calls.
- Run `pnpm dev:experiments -- --state-dir /tmp/organization-experiments` to open the isolated native Studio inspection surface. It registers no agent, workflow, worker, schedule, source, or executable target, so use it to review persisted datasets and compare runs rather than launch an evaluation.

Use an evaluation directory that is separate from `.mastra` and every configured local source root. The runner resolves symlinks before it writes fixtures or contacts a provider, and it rejects an overlapping directory. Synthetic reports, candidate answers, safe evidence, judgments, and native result metadata remain in that operator-owned directory until it is removed manually. Repeated explicit runs accumulate stored history.

The deterministic suite uses controlled native Drive and R2 transport. The separate `pnpm test:integration` command contacts real Drive sources: enable two synthetic folders and place `f1-drive-smoke.txt` in each with `source=<configured-source-id>`. Missing setup or failed access fails the test. The separate R2 smoke command is intentionally not part of that Drive selector and is required for simultaneous remote evidence.

Indexing supports Markdown, textual PDF, DOCX, and native Google Docs/Sheets, including nested tabs and nonempty worksheets. R2 supports the first three formats; native Docs and Sheets remain Drive-specific. Image-only PDF pages, optical character recognition (OCR), spreadsheet recalculation, and source writes are outside this template’s scope.

Use a source ID only while its provider and root remain the same. When replacing a root, assign a new ID, update `source-catalog.json`, and restart; disabled and removed catalog sources are excluded from search even when cached records remain. If a Drive refresh becomes incomplete after a successful scan, cached evidence remains searchable with a stale warning and last-success time. Only a complete scan reconciles deletions.

The shipped application factory uses fixed local file-backed libSQL state under `.mastra/`. Adapting it for shared durable state, including Turso, requires code changes and verification of the one-writer sync rule, persisted schedules, and BM25/vector rebuild behavior. It is not enabled by `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN` alone.

`pnpm dev:local` performs a frozen-lockfile install, validates configuration, and starts the local server. It preserves `.env`, `source-catalog.json`, and existing derived state across reruns; an install failure prevents the dev server from starting. `pnpm check:env` validates configuration without remote access. `pnpm test` runs deterministic tests, and `pnpm check` runs formatting, linting, type checking, tests, and the build.

To rebuild local derived state, stop every running instance, then remove only `.mastra/organization-intelligence.db` and its `-wal` and `-shm` sidecars plus `.mastra/source-identities.json`. Restart with `pnpm dev`. Preserve `.env`, `source-catalog.json`, and every source folder. Rebuilding discards cached records, embeddings, and schedule/run state and requires a fresh scan and paid embeddings.

## About Mastra templates

This standalone repository uses Mastra workflows, agents, and read-only Workspace mounts to search institutional records from local folders, Google Drive, and private R2 storage. Publication and template-directory attribution have not been established.
