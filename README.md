# Organization Intelligence

A company’s knowledge rarely lives in one place. Policies might be in Google Drive, reports in an S3 bucket, and PDFs or spreadsheets on a local system. Organization intelligence brings that scattered knowledge into reach: people can ask a question about their company and get an answer backed by its documents, with citations they can follow.

This starter kit shows how to build that experience with Mastra. It connects local files, Google Drive, and S3-compatible storage through a shared Workspace, then indexes the documents so you can ask questions across them. Start with the included sample documents, connect your own sources, and adapt the providers, document formats, and workflows to the way your company works.

## Why we built this

Finding an answer often starts with another question: where is the right document? Even when you find it, you may need to check another source or work out which version is current. We built this template to make that process easier, while keeping the source and freshness of each result visible so people can check the answer and spot outdated or conflicting information.

You can use the same search and answer flow in Mastra Studio, over HTTP, or through MCP. The template supports Markdown, text-bearing PDFs, DOCX, and native Google Docs and Sheets, and gives you a starting point for adding the formats and integrations your team needs.

## Prerequisites

- **[OpenAI API key](https://platform.openai.com/api-keys)**: set `OPENAI_API_KEY` in `.env`. This is the only credential needed for the default local setup. Normalized text and query embeddings use `text-embedding-3-small`; questions and retrieved excerpts go to `gpt-5.6-terra`. These operations incur provider usage.
- **Optional remote sources**: follow the [Mastra Google Drive setup](https://mastra.ai/integrations/file-storage/google-drive#service-account) or [Mastra S3 and Cloudflare R2 setup](https://mastra.ai/integrations/file-storage/amazon-s3). Both integrations are already installed. Keep the template-specific settings described below.

## Quickstart 🚀

1. **Create the template**
   - Run `npx create-mastra@latest --template organization-intelligence` and choose `organization-intelligence` as the project directory when prompted.
   - Run `cd organization-intelligence`, then `npm ci` to install the locked dependencies.
2. **Add your API key**
   - Run `cp .env.example .env` and set `OPENAI_API_KEY` as described in Prerequisites.
   - Keep the supplied `source-catalog.json`. Only the local source is enabled; no Drive or R2 account is needed.
3. **Start the dev server**
   - Run `npm run dev`.
   - Open [Mastra Studio](http://localhost:4111), select **Organization Agent**, and ask “How long are invoices retained?” Expect seven years after the end of the fiscal year, a citation to `/sample/records-retention.md`, and source freshness.

## Try it out

- Ask an unrecorded policy question. The answer reports `insufficient_evidence` instead of inventing a policy.
- Add a Markdown, text-bearing PDF, or DOCX file to `sample-documents`. Leave the server running. The next five-minute refresh discovers it automatically; ask a question about a fact found only in that file after synchronization succeeds.
- Inspect `GET http://localhost:4111/organization-telemetry` before and after the refresh. Look for a new successful sync run and the source's indexed count. To refresh immediately, run **sync-organization-sources** in Studio with `{"trigger":"manual"}`.
- Enable Drive and R2, then ask a question that needs evidence from both. Citations preserve the remote source identity; private R2 files have mounted locators instead of invented public URLs.
- Add a native Google Doc with multiple tabs or a Google Sheet with multiple worksheets. Ask about a fact outside the first tab or worksheet and inspect its citation.

## Customization

- Ask your coding agent: “Explore the source catalog, Workspace setup, and answer contract. Propose how to add a read-only source while preserving citations and containment tests.”
- Edit `source-catalog.json` to choose sources. Catalog changes require a restart; new documents in an existing source do not.
- Start with `src/mastra/index.ts` to see the registered components. Agents, tools, workflows, and Workspace providers have their own folders under `src/mastra`.

## Optional remote sources

Follow the official [Google Drive integration](https://mastra.ai/integrations/file-storage/google-drive) or [Amazon S3 integration](https://mastra.ai/integrations/file-storage/amazon-s3) guide for provider authentication and access setup. The [filesystem mounts walkthrough](https://mastra.ai/blog/introducing-filesystem-mounts) explains how the providers share one Workspace.

Both integrations are already installed. Copy the relevant entries from `source-catalog.example.json` into `source-catalog.json`, fill in the source details, and set `enabled` to `true`. This template uses these settings:

- **Google Drive:** set `GOOGLE_DRIVE_CLIENT_EMAIL` and `GOOGLE_DRIVE_PRIVATE_KEY` in `.env`; set `folderId` in the catalog. Share the folder with the service account as a Viewer. Enable the Docs API for native document tabs.
- **S3 / R2:** set `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in `.env`; set `bucket`, `endpoint`, `region`, and `prefix` in the catalog. For R2, use the HTTPS account endpoint and `region: "auto"`, with Object Read credentials scoped to the bucket.

Restart with `npm run dev` after changing the catalog. Local, Drive, and S3 sources can remain enabled together. Source access is read-only; OCR is not included.

## API and MCP

With the server running, send an HTTP question:

```sh
curl -sS http://localhost:4111/organization-answer \
  -H 'content-type: application/json' \
  -d '{"question":"How long are invoices retained?"}'
```

Connect an MCP client to `http://localhost:4111/api/mcp/organization-intelligence/mcp`. The server tool is `answerOrganizationQuestion`; a Mastra MCP client configured with the server name `organization` exposes it as `organization_answerOrganizationQuestion`. Pass `{"question":"How long are invoices retained?"}`. See the [Mastra MCP client documentation](https://mastra.ai/reference/tools/mcp-client).

Studio renders a readable answer and citations; HTTP and MCP preserve the structured answer contract. This is a local/trusted single-organization template.

## Operations

Studio conversations persist in the configured Mastra storage. Reopen the same chat to continue with its history; the agent includes the last 20 messages in its context. Follow-up questions use recent conversation history to form a standalone document search query. The original question stays in the chat. If the reference is ambiguous, the agent asks for clarification; if contextualization fails, it searches with the original question. This adds one model call for questions with conversation history. See [Mastra memory](https://mastra.ai/docs/memory/overview) for configuration options. The custom HTTP and MCP endpoints continue to handle independent questions. Clarification responses use `clarification_required` with no citations.

Synchronization runs once at startup, manually on demand, and every five minutes while the server is running. Failed remote scans retain the last committed evidence with a stale warning; only complete scans can remove missing indexed records. Keep a source ID bound to the same provider and root. Disabling a source and restarting excludes its cached evidence.

`GET http://localhost:4111/organization-telemetry` returns seven days of metadata-only sync counts, question outcomes, retrieval timing, source use, and reported tokens. Unavailable usage or monetary cost stays unavailable. It does not store question text, answer bodies, document excerpts, or credentials, and no external trace exporter is configured.

Application state, including chat history and the document index, lives in `.mastra/organization-intelligence.db`. For an intentional full reset, stop every instance and remove only that file, `.mastra/organization-intelligence.db-wal`, `.mastra/organization-intelligence.db-shm`, and `.mastra/source-identities.json`. This also deletes saved conversations. Restart with `npm run dev`. Preserve `.env`, `source-catalog.json`, and all source documents. Rebuilding requires a new scan and paid embeddings. Hosted persistence requires a separately verified adaptation.

## About Mastra templates

Mastra templates are starting points you can run, explore, and adapt to your own projects. This template follows the [Mastra template structure](https://mastra.ai/reference/templates/overview) and combines agents, workflows, and Workspace mounts to answer questions across company documents.

Want to contribute? See [CONTRIBUTING.md](https://github.com/drantunes/template-organization-intelligence/blob/main/CONTRIBUTING.md) for setup, checks, and pull request guidance.
