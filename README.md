# XHS Platform (小红书)

> A custom XHS social platform for curated content sharing with OAuth 2.0 API for cross-platform posting.

## Overview

XHS is a lightweight social platform built to enable programmatic posting through Connect Hub. It provides:

- **User-facing web app** for creating and viewing text + image notes
- **OAuth 2.0 server** for third-party integrations (Connect Hub)
- **REST API** for note creation, retrieval, and management
- **Public feed** with chronological timeline

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Database:** PostgreSQL (Vercel Postgres)
- **Auth:** Cloudflare Access for operators + legacy JWT/OAuth for existing API clients
- **Storage:** Cloudflare R2 (images)
- **Deployment:** Vercel

## Features

### MVP (Phase 0)

- Create text + image notes
- Public chronological feed
- User profiles
- OAuth 2.0 authorization server
- REST API with token authentication
- Image upload via Cloudflare R2

## Development

### Prerequisites

- Node.js 20.9+
- Vercel Postgres database
- Cloudflare R2 bucket
- Vercel account

### Setup

```bash
git clone https://github.com/noonotnow/xhs-platform.git
cd xhs-platform
npm install
cp .env.example .env.local
# Edit .env.local with your credentials
npm run dev
```

### Environment Variables

See `.env.example` for required variables.

The operator-only `/admin` and `/api/xhs/*` routes require a valid Cloudflare
Access application assertion for an allowlisted email. Configure these values
in Vercel:

| Variable | Description |
| --- | --- |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Access team domain, such as `team.cloudflareaccess.com`; the verified JWT issuer is `https://<team-domain>` |
| `CLOUDFLARE_ACCESS_AUDIENCE` | Access application audience (`aud`) for the XHS admin application |
| `CLOUDFLARE_ACCESS_OPERATOR_EMAILS` | Comma-separated operator email allowlist |
| `UPLOAD_TOKEN_SECRET` | Long random secret shared with the XHS microservice for two-minute upload grants |
| `PLAN_SECRET` | At least 32 random characters shared with Vibe Atlas for integration media uploads |
| `NOTION_API_KEY` | Server-only Notion integration token with read/write access to the canonical Posts DB |
| `NOTION_POSTS_DB_ID` | Canonical Posts database ID shared with the production CREATE workflow |
| `LOCAL_PUBLISH_WORKER_TOKEN` | At least 32 random characters shared only with the trusted Mac-local browser worker |
| `LOCAL_PUBLISH_JOB_LEASE_SECONDS` | Optional worker claim lease; defaults to 7200 seconds and is clamped to 60–86400 |

`XHS_API_KEY` remains server-only and is used for Vercel-to-microservice
login, session, and publish requests. Browser uploads use
`Authorization: Upload <token>`; the token payload is compact JSON containing
`exp`, `method`, `path`, and `nonce`, signed as
`base64url(payload).base64url(HMAC-SHA256(payload_segment))` without padding.

Deploy the microservice upload-token verifier and shared
`UPLOAD_TOKEN_SECRET` first. Then configure the Cloudflare Access application
and Vercel variables, deploy this application, and finally route the production
admin hostname through Access. This avoids switching the browser to upload
grants before the microservice accepts them.

### Mac-local publishing for CREATE packets

The protected admin loads unpublished RedNote records whose canonical
`Publish packet ready` property is checked. The server re-reads the selected
Notion page when an operator queues it, confirms that it is still RedNote-ready
and not `Published`, and builds an immutable snapshot from canonical HTTPS media.
Client-provided media URLs and Notion metadata are never accepted. The operator
can edit only the final reviewed title, caption, tags, and trusted media choice.

Trusted canonical MEDIA `.mov` registrations remain compatibility-unverified and
are not added to the normal ready video set. Admin exposes a separate warning and
staging-trial action only for these MOV assets. Queueing that lane requires a
second explicit compatibility-trial confirmation; the server re-reads Notion and
accepts only a reviewed packet whose blockers are limited to `Needs media` and
the absence of certified canonical media. Missing title/caption, incomplete
packet review, untrusted media, schema ambiguity, and every unrelated blocker
still fail closed. Normal MP4 and image readiness rules are unchanged.

Apply the required queue migration before deploying the publishing pipeline:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/003_local_publish_jobs.sql
```

External-post reconciliation is an isolated follow-up surface. Apply its migration
before enabling that worker endpoint and audit; a reconciliation audit failure does
not disable or change the local publishing queue:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/004_external_post_reconciliations.sql
```

Set `LOCAL_PUBLISH_WORKER_TOKEN` to a new random server-only value of at least
32 characters in Vercel and in the Mac worker. The optional
`LOCAL_PUBLISH_JOB_LEASE_SECONDS` defaults to two hours. A stale claimed job can
be recovered by a later worker, which rotates the claim token so the previous
worker can no longer report a result.

The local worker contract is:

1. `GET /api/local-publish-jobs/next` with
   `Authorization: Bearer <LOCAL_PUBLISH_WORKER_TOKEN>`. HTTP 204 means the queue
   is empty. A claim returns the immutable publish fields plus `claimToken` and
   `claimExpiresAt`. An unverified MOV trial additionally returns
   `"compatibilityTrial":"unverified_mov"`; normal jobs omit this field.
2. Stage the asset and reviewed copy at `https://creator.rednote.com`, wait for
   explicit human approval, publish, confirm `/publish/success`, find the exact
   post in `/new/note-manager`, and verify
   `https://www.rednote.com/explore/{noteId}`.
   For `unverified_mov`, a Creator staging rejection must be reported as failed
   without clicking Publish. If staging succeeds, the worker must still wait for
   the existing exact `PUBLISH <jobId>` human approval before any Publish click;
   it must never auto-publish.
3. `POST /api/local-publish-jobs/{id}/result` with the bearer token and
   `X-Local-Publish-Claim-Token: <claimToken>`. The only accepted bodies are
   `{"status":"succeeded","noteId":"...","shareUrl":"https://www.rednote.com/explore/..."}`
   and `{"status":"failed","code":"SAFE_CODE","message":"Safe operator message"}`.
   Report a discarded staging session as a failure such as
   `STAGING_DISCARDED`; never abandon a claim silently.

The success URL must exactly match the same note ID and cannot include a query,
fragment, alternate host, or trailing slash. A verified success first enters an
`ambiguous` reconciliation state, then updates Notion through the existing
aliases (`Status=Published`, `Rednote URL`, `Rednote Note ID`, and the established
published `Next action`) before the job becomes `succeeded`. If Notion backfill
fails, retry the identical success report with the same claim token; do not
publish again. Queued, claimed, failed, expired, or malformed results never mark
Notion as Published.

The compatibility marker is stored inside the immutable JSONB job snapshot and
shown in the operator audit. No additional database migration is required beyond
`003_local_publish_jobs.sql`.

Posts created outside this queue can be reconciled by the same trusted worker:

1. Verify the live post and send `POST /api/local-publish-jobs/reconcile-external`
   with the bearer token, a UUID `Idempotency-Key`, and exactly
   `{"noteId":"...","shareUrl":"https://www.rednote.com/explore/...","title":"...","caption":"...","mediaType":"image|video"}`.
2. The share URL must be the exact HTTPS `www.rednote.com/explore/{noteId}` URL.
   Unknown fields, including media URLs, are rejected.
3. The server matches the canonical Posts database by exact `Rednote Note ID`
   first, then exact `Rednote URL`. Conflicting or duplicate matches fail safely.
   A match is updated; otherwise one row is created.
4. Only a successful reconciliation writes `Status=Published`, the verified note
   ID and URL, final title/caption, RedNote platform/video flags,
   `Needs media=false`, `Needs caption=false`, and
   `Next action=Backfill URL/metrics`. It appends an external-reconciliation note
   but never invents or writes a canonical MEDIA URL.

The receipt table makes retries idempotent by UUID, note ID, and share URL. A
processing receipt can be reclaimed after five minutes if a request crashes;
failed receipts can be retried with the identical verified snapshot. Operators
can inspect the read-only receipt history in Ready from CREATE. The audit API at
`GET /admin/api/external-post-reconciliations` remains behind the same
Cloudflare Access protection as the rest of Admin.

The legacy cloud cookie publisher remains disabled in the Ready-from-CREATE
panel. Manual download, copy, Creator, and Notion handoff controls remain
available as a fallback. Keep `migrations/002_xhs_publish_receipts.sql` for
historical cloud publish receipts.

## API Usage

### Vibe Atlas media upload

`POST /api/integrations/media` stores a decoded, static PNG, JPEG, or WebP file
(maximum 4 MB and 16 megapixels) in the configured R2 bucket. Browser requests
and preflight are allowed only from `https://fandom.justlikekatie.com`.

```bash
curl -X POST https://xhs.justlikekatie.com/api/integrations/media \
  -H "Authorization: Bearer $PLAN_SECRET" \
  -F "file=@share-card.png"
```

A successful upload returns HTTP 201 with the durable CDN URL:

```json
{ "url": "https://images.xhs.justlikekatie.com/uploads/..." }
```

The deployment requires `PLAN_SECRET` plus the existing `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and
`R2_PUBLIC_URL` values.

### Authentication

All protected endpoints require Bearer token:

```bash
curl -H "Authorization: Bearer <token>" https://xhs.justlikekatie.com/api/notes
```

### Create Note

```bash
POST /api/notes
Authorization: Bearer <token>
Content-Type: application/json

{
  "content": "My first XHS note!",
  "image_url": "https://images.xhs.justlikekatie.com/uploads/abc123.jpg"
}
```

### Get Feed

```bash
GET /api/notes?limit=20&page=1
```

Full API documentation: `docs/PLATFORM_SPEC.md`

## Project Status

**Current Phase:** Week 1 MVP (Core Posting)

**Domain:** xhs.justlikekatie.com

## Related Projects

- **Connect Hub** — Cross-platform posting cockpit (integration target)
- **CREATE** — Content creation pipeline
- **PLAN** — Content scheduling queue

## License

MIT
