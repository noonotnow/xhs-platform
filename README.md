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
- **Database:** PostgreSQL (Neon)
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
- PostgreSQL database
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
| `XHS_DATABASE_URL` | Preferred server-only PostgreSQL connection string for XHS; overrides managed integration variables |
| `XHS_DATABASE_POSTGRES_URL` | Pooled PostgreSQL connection string exported by the managed XHS Neon integration |
| `XHS_DATABASE_POSTGRES_URL_NON_POOLING` | Unpooled managed Neon connection string for migrations and other direct database operations; not used by the application pool |
| `DATABASE_URL` | Backward-compatible PostgreSQL connection fallback when XHS-specific variables are unset |
| `POSTGRES_URL` | Legacy PostgreSQL connection fallback when all variables above are unset |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Access team domain, such as `team.cloudflareaccess.com`; the verified JWT issuer is `https://<team-domain>` |
| `CLOUDFLARE_ACCESS_AUDIENCE` | Access application audience (`aud`) for the XHS admin application |
| `CLOUDFLARE_ACCESS_OPERATOR_EMAILS` | Comma-separated operator email allowlist |
| `UPLOAD_TOKEN_SECRET` | Long random secret shared with the XHS microservice for two-minute upload grants |
| `PLAN_SECRET` | At least 32 random characters shared with Vibe Atlas for integration media uploads |
| `NOTION_API_KEY` | Server-only Notion integration token with read/write access to the canonical Posts DB |
| `NOTION_POSTS_DB_ID` | Canonical Posts database ID shared with the production CREATE workflow |
| `LOCAL_PUBLISH_WORKER_TOKEN` | At least 32 random characters shared only with the trusted Mac-local browser worker |
| `LOCAL_PUBLISH_JOB_LEASE_SECONDS` | Optional worker claim lease; defaults to 7200 seconds and is clamped to 60–86400 |
| `LOCAL_PUBLISH_VERIFICATION_BACKOFF_SECONDS` | Optional four-value retry schedule; defaults to `900,3600,21600,86400` seconds (15m, 1h, 6h, 24h) |

Database connections are selected in the order `XHS_DATABASE_URL`,
`XHS_DATABASE_POSTGRES_URL`, `DATABASE_URL`, then `POSTGRES_URL`. The managed
XHS Neon integration supplies `XHS_DATABASE_POSTGRES_URL`; set
`XHS_DATABASE_URL` only when an explicit manual override is needed. These
variables are server-only and health reporting exposes only whether each
variable is configured, never its value.

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
Notion page before creating a queue job, confirms that it is still RedNote-ready
and not `Published`, and builds an immutable snapshot from canonical HTTPS media.
Client-provided media URLs and Notion metadata are never accepted. The operator
can edit only the final reviewed title, caption, tags, and trusted media choice.
`Weibo text` supplies the body-only caption, native multi-select `Final Tags`
supplies tag names directly as a string array, and
`ScheduledDate` is the only scheduling property; generic Tags, Topics, Hashtags,
Publish Date, and spaced Scheduled Date properties are not queue sources. When
Final Tags is absent or empty, legacy trailing hashtags may be split from Weibo
text; rich-text tag strings are never parsed, and hashtags elsewhere in the body
are preserved.

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
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/005_local_publish_job_lifecycle.sql
```

External-post reconciliation is an isolated follow-up surface. Apply its migration
before enabling that worker endpoint and audit; a reconciliation audit failure does
not disable or change the local publishing queue:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/004_external_post_reconciliations.sql
```

Set `LOCAL_PUBLISH_WORKER_TOKEN` to a new random server-only value of at least
32 characters in Vercel and in the Mac worker. The optional
`LOCAL_PUBLISH_JOB_LEASE_SECONDS` defaults to two hours. A stale claimed or staged
job can be recovered by a later worker, which rotates the claim token so the
previous worker can no longer report a result. Verification retries default to
15 minutes, 1 hour, 6 hours, and 24 hours; set exactly four comma-separated
values in `LOCAL_PUBLISH_VERIFICATION_BACKOFF_SECONDS` to override them.

The local worker contract is:

1. `GET /api/local-publish-jobs/next` with
   `Authorization: Bearer <LOCAL_PUBLISH_WORKER_TOKEN>`. HTTP 204 means the queue
   is empty. A claim returns `id`, `notionPageId`, `headline`, `title`, `caption`,
   `tags`, `platform`, `mediaType`, `mediaUrl`, optional `thumbnailUrl`, optional
   canonical UTC `publishAt`, `claimToken`, `claimExpiresAt`, and `status`.
   `publishAt` is present exactly when Notion has `ScheduledDate`; its absence
   means immediate mode after human approval. An unverified MOV trial additionally
   returns `"compatibilityTrial":"unverified_mov"`; normal jobs omit this field.
2. A claim with `status` `claimed` or `staged` is dispatch work. Stage the asset
   and reviewed copy at `https://creator.rednote.com`, report `staged`, wait for
   explicit human approval, submit or schedule, and capture the exact stable note
   ID and URL from authenticated Creator.
   For `unverified_mov`, a Creator staging rejection must be reported as failed
   without clicking Publish. If staging succeeds, the worker must still wait for
   the existing exact `PUBLISH <jobId>` human approval before any Publish click;
   it must never auto-publish.
3. A claim with `status` `submitted`, `scheduled`, or `verification_pending`
   is verification-only work and includes durable `noteId`, `shareUrl`,
   `verificationAttempts`, and `nextVerificationAt`. Never click Publish for
   these states. Query-free public error `300031`, processing, indexing delay, or
   any other post-dispatch uncertainty must be reported as
   `verification_pending`, not failed. A scheduled job's first check is anchored
   after its frozen `publishAt`; an immediate submission's first check starts
   after the initial 15-minute delay.
4. A claim with `status` `verified` is reconciliation-only work. It includes the
   durable identifiers and must be re-reported as `verified` without dispatching
   or creating another post. This makes a Notion outage recoverable even after
   the original worker exits.
5. `POST /api/local-publish-jobs/{id}/result` with the bearer token and
   `X-Local-Publish-Claim-Token: <claimToken>`. Accepted bodies are:
   - `{"status":"staged"}`
   - `{"status":"submitted","noteId":"...","shareUrl":"https://www.rednote.com/explore/..."}`
   - `{"status":"scheduled","noteId":"...","shareUrl":"https://www.rednote.com/explore/..."}`
   - `{"status":"verification_pending","noteId":"...","shareUrl":"https://www.rednote.com/explore/...","code":"REDNOTE_300031","message":"Safe operator message"}`
   - `{"status":"verified","noteId":"...","shareUrl":"https://www.rednote.com/explore/..."}`
   - `{"status":"failed","code":"SAFE_CODE","message":"Safe operator message"}`,
     only before dispatch while the durable state is `claimed` or `staged`.

The lifecycle is `queued -> claimed -> staged -> submitted|scheduled ->
verification_pending -> verified -> reconciled`; a verified result may skip
intermediate reporting but is always persisted before reconciliation. The
success URL must exactly match the same note ID and cannot include a query,
fragment, alternate host, or trailing slash. Only `verified` updates Notion
through the existing aliases (`Status=Published`, `Rednote URL`, `Rednote Note
ID`, and the established published `Next action`), and only successful Notion
backfill advances the job to `reconciled`. If backfill fails, the row remains
`verified` and is reclaimable for idempotent reconciliation. The legacy worker
body `status:"succeeded"` remains accepted as a `verified` alias during rollout.
`metrics_available` is a later sync concern and is not a publication-verification
state.

### Quiet worker lanes and metrics

A persistent worker should drain independent lanes instead of consuming one
combined lifecycle transition per wake:

- `GET /api/local-publish-jobs/next?lane=dispatch` atomically claims one
  `queued`, expired `claimed`, or expired `staged` job.
- `GET /api/local-publish-jobs/next?lane=verification` atomically claims one
  due `submitted`, `scheduled`, or `verification_pending` job, or one
  reclaimable `verified` reconciliation. Dispatch work cannot consume this
  lane's capacity, and verification work cannot consume dispatch capacity.
- Omitting `lane` preserves the existing combined single-claim behavior for
  older workers. Every response still has its own rotating `claimToken` and
  `claimExpiresAt`; result contracts and human Publish approval are unchanged.

Metrics use a separate bounded batch because they are read-only collection work:

1. `GET /api/rednote-metrics/due?limit=20` claims at most 20 reconciled posts.
   The default and maximum are both 20. Add `onDemand=true` to include posts
   older than 90 days. Every item has its own claim token and lease.
2. Cadence is derived from the durable publication time: through 48 hours every
   6 hours, through day 14 daily, through day 90 weekly, then manual/on-demand.
3. Submit one consolidated request to `POST /api/rednote-metrics/observations`:

   ```json
   {
     "observations": [{
       "notionPageId": "canonical-post-page-id",
       "claimToken": "11111111-1111-4111-8111-111111111111",
       "observedAt": "2026-08-02T12:00:00.000Z",
       "metrics": {
         "views": 120,
         "likes": 12,
         "comments": 3,
         "saves": 4,
         "shares": 1
       }
     }]
   }
   ```

The metrics service writes `post_performance_snapshots` only when values changed
or a cadence checkpoint is due. Exact retries coalesce without writes, and an
empty due batch performs no writes. Responses contain one run summary with
`claimed`, `verified`, `measured`, `snapshotsWritten`, and `failures`; there are
no field-level updates. These endpoints persist observation history only and do
not mutate the canonical Notion Posts database or add CONNECT-owned behavior.

The compatibility marker is stored inside the immutable JSONB job snapshot and
shown in the operator audit. Queue snapshots remain JSONB: new rows store
`publishAt` and never store `scheduledDate`, while existing snapshots normalize
legacy `scheduledDate` to canonical UTC `publishAt` in memory. Migration `005`
adds lifecycle timestamps and retry state without rewriting snapshots, maps
legacy `ambiguous` rows to `verified`, and maps legacy `succeeded` rows to
`reconciled`. The worker must consume the frozen snapshot and must never read
Notion.

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

The endpoint verifies that the storage helper returned a URL under the configured
`R2_PUBLIC_URL`, then returns the same object path on the canonical
`images.xhs.justlikekatie.com` media domain. `R2_PUBLIC_URL` may therefore be
either that custom domain or the bucket's raw `*.r2.dev` public origin.

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
