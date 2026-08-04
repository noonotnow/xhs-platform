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
| `MEDIA_API_BASE_URL` | HTTPS base URL for the server-to-server MEDIA descriptor API |
| `MEDIA_ASSETS_READ_CREDENTIAL` | Server-only complete MEDIA `Authorization` value for a credential scoped only to `assets:read` |
| `MEDIA_DESCRIPTOR_TIMEOUT_MS` | Optional per-descriptor timeout; defaults to 3000 ms and is clamped to 250–10000 |
| `LOCAL_PUBLISH_WORKER_TOKEN` | At least 32 random characters shared only with the trusted Mac-local browser worker |
| `LOCAL_PUBLISH_JOB_LEASE_SECONDS` | Optional worker claim lease; defaults to 7200 seconds and is clamped to 60–86400 |
| `LOCAL_PUBLISH_VERIFICATION_BACKOFF_SECONDS` | Optional four-value retry schedule; defaults to `900,3600,21600,86400` seconds (15m, 1h, 6h, 24h) |
| `MANUAL_RECONCILIATION_LEASE_SECONDS` | Optional existing-post verification lease; defaults to 1800 seconds and is clamped to 60–7200 |
| `MANUAL_RECONCILIATION_BACKOFF_SECONDS` | Optional four-value existing-post retry schedule; defaults to `900,3600,21600,86400` |
| `CRON_SECRET` | Bearer secret used by the RedNote sweep endpoint and matching GitHub Actions repository secret |

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

For manual Creator login, sign in at `creator.rednote.com`, then use browser
DevTools Network to select a newly authenticated `creator.rednote.com` request.
Under Request Headers, right-click the `cookie` request-header value and choose
**Copy value**. Do not use **Copy all**, **Copy request headers**,
**Copy as cURL**, or the Application cookie table or export. The browser sends
the pasted value only to the protected platform route; `XHS_API_KEY` remains
server-only, and neither service returns the submitted cookie.

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
`Caption` is the canonical platform-neutral and language-neutral post body. It
may contain draft or final copy, but publishing uses it only after the existing
status and readiness gates pass. Migrate with a direct Notion property rename
from `Weibo text` to `Caption`; the rename preserves existing values, so do not
create or backfill a parallel Caption property. Before the live rename, deploy
Caption-compatible schema lookup to PLAN's writer. XHS current main already
accepts Caption as a fallback, and this version prefers it. The temporary
`Caption text`, `Weibo text`, `Weibo Text`, and `Weibo` aliases remain
read-compatible only for rollback and older schemas. If a transition leaves
both canonical and legacy properties present, an explicitly empty Caption
blocks publishing instead of borrowing potentially stale legacy copy. Treat
that state as duplicate-schema quarantine, not as the normal migration path.
Native multi-select `Final Tags` supplies tag names directly as a string array,
and `ScheduledDate` is the only scheduling property; generic Tags, Topics,
Hashtags, Publish Date, and spaced Scheduled Date properties are not queue
sources. When Final Tags is absent or empty, trailing hashtags may be split from
Caption as a legacy fallback; rich-text tag strings are never parsed, and
hashtags elsewhere in the body are preserved. Do not add separate Chinese Draft
or Final Caption properties.

Trusted canonical MEDIA `.mov` registrations enter the normal ready video set only
after XHS fetches the asset descriptor server-to-server with an `assets:read`
credential. The URL must exactly match the canonical
`/videos/assets/<shard>/<uuid>.mov` shape, and the descriptor must return that UUID
and exact delivery URL with `mediaType=video`, `mimeType=video/quicktime`,
`containerFormat=quicktime`, `processingState=ready`,
`compatibility.xhsPublishing=compatible`, and `compatibility.reason=null`.
Configuration, authentication, timeout, fetch, JSON, URL, identity, and verdict
failures leave the existing MOV media blocker in place. The credential is never
returned to the browser. Unqualified MOV assets retain the separate warning and
staging-trial lane; normal MP4 and image readiness rules are unchanged.

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
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/007_manual_reconciliation_requests.sql
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
   canonical UTC `publishAt`, `claimToken`, `claimExpiresAt`,
   and `status`. Unscheduled records can never enter a batch. An
   unverified MOV trial additionally
   returns `"compatibilityTrial":"unverified_mov"`; normal jobs omit this field.
2. Only batch-approved claims include `batchAuthorization`:
   `{"batchId","manifestHash","itemHash","snapshotRevision",
   "approvedState":"approved","approvedAt","media":{"url","type","identity"},
   "publishAt","lateAction"}`. Hashes and `media.identity` are lowercase SHA-256;
   the identity hashes canonical JSON `{type,url}`. `publishAt` always retains the
   original exact canonical UTC minute. `lateAction:"post_now"` authorizes immediate
   submission only when the approved preview recorded lateness of at most 24 hours;
   `"schedule"` uses `publishAt`. Legacy claims omit `batchAuthorization` and retain
   exact `PUBLISH <jobId>` approval.
3. Before staging and immediately before clicking Publish, call
   `GET /api/local-publish-jobs/<id>/authorization` with the worker bearer token and
   `X-Local-Publish-Claim-Token`. It returns `{"job":<current strict claim>}` only
   while the token, lease, source revision, hashes, approval, and frozen fields are
   current. Treat 404 as unknown and 409 as stale, expired, revoked, drifted, or
   unauthorized; do not publish. The check on a staged job durably consumes its
   dispatch permit. If the worker exits after that point, the job is never
   automatically dispatched again and must proceed through receipt recovery or
   manual reconciliation.
4. A claim with `status` `claimed` or `staged` is dispatch work. Stage the asset
   and reviewed copy at `https://creator.rednote.com`, report `staged`, then submit
   or schedule only after the required approval and second authorization check.
   A valid bounded batch is that approval; a legacy claim still requires exact
   `PUBLISH <jobId>`. Capture the stable note ID and URL from authenticated Creator.
   For `unverified_mov`, a Creator staging rejection must be reported as failed
   without clicking Publish.
5. A claim with `status` `submitted`, `scheduled`, or `verification_pending`
   is verification-only work and includes durable `noteId`, `shareUrl`,
   `verificationAttempts`, and `nextVerificationAt`. Never click Publish for
   these states. Query-free public error `300031`, processing, indexing delay, or
   any other post-dispatch uncertainty must be reported as
   `verification_pending`, not failed. A scheduled job's first check is anchored
   after its frozen `publishAt`; an immediate submission's first check starts
   after the initial 15-minute delay.
6. A claim with `status` `verified` is reconciliation-only work. It includes the
   durable identifiers and must be re-reported as `verified` without dispatching
   or creating another post. This makes a Notion outage recoverable even after
   the original worker exits.
7. `POST /api/local-publish-jobs/{id}/result` with the bearer token and
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

### Bounded batch approval and sweeps

Apply `migrations/008_rednote_publish_batches.sql` before deploying code that
serves batch APIs or worker claims. Apply the additive, idempotent
`migrations/009_superseded_rednote_publish_batches.sql` before deploying support
for safely rebuilding a pending bootstrap. These create immutable batch/item audit
tables, link batch items to existing jobs, persist blocked-candidate accounting,
add the durable sweep ledger, and record explicit supersession. They do not touch
Notion and must not be run automatically by the application.

The admin batch preview shows every frozen title, caption, tags, canonical media
URL/type, exact ScheduledDate instant, source revision, item hash, dispatch mode,
and aggregate manifest hash. Approval stores the Cloudflare Access actor and
timestamp. A source change invalidates only that item. Active unpublished records
remain visible as `Needs publish time`, `Needs batch approval`, or their job state;
an absent or date-only ScheduledDate is never interpreted as immediate publish.

The hourly `.github/workflows/rednote-sweep.yml` workflow calls
`/api/cron/rednote-sweep` using the `XHS_PLATFORM_URL` and `CRON_SECRET`
repository secrets. The application uses
`America/New_York`, not a fixed UTC offset, to run the daily 08:00 operational
sweep and Sunday 18:00 weekly candidate for the following Monday-Sunday window.
Sweeps never approve. Daily runs recover known receipts into verification,
continue post-dispatch jobs through the existing verification lane, and create
one catch-up candidate. Verification remains 15m, 1h, 6h, and 24h; RedNote
`300031` stays `verification_pending` and is never dispatchable.

For the one-time bootstrap after the migration and application deploy:

1. Open `/admin`, refresh posts, and select **Build bootstrap batch**.
2. Review every item and confirm each explicit `Post now — Nh late` conversion.
   Items over 24 hours late, records without an exact time, and uncertified MOV
   records remain visible in the preview as blocked and are not part of the
   authorized manifest.
3. Copy the displayed manifest hash into the change record, then select
   **Approve this exact manifest** once. Rebuild only when the displayed pending
   preview must be explicitly superseded; never approve an older hash.

Rebuilding a still-pending bootstrap explicitly supersedes the old immutable
manifest and invalidates only its unapproved item states so they release batch
ownership. The old hash and frozen snapshots remain visible for audit and can
never be approved; review and approve only the replacement manifest.

Deploy order: migrations 008 and 009, this platform release plus `CRON_SECRET`, configure
the workflow's `XHS_PLATFORM_URL` and matching `CRON_SECRET` repository secrets,
then deploy worker support for strict `batchAuthorization` and reauthorization
with bounded-batch bypass still disabled. Enable bypass only after both
reauthorization checks succeed against production. Finally perform the bootstrap
steps above.

#### Recovering a bypass-disabled approved job

`migrations/010_rednote_publish_job_recoveries.sql` adds the append-only recovery
audit and `migrations/011_generation_aware_rednote_publish_job_recoveries.sql`
scopes its uniqueness to each terminal claim generation. This is the only
supported recovery for a bounded job that terminal-failed
with exact error `BOUNDED_BATCH_BYPASS_DISABLED` before staging or dispatch. It
updates the original `local_publish_jobs` row back to `queued`; it does not create
a job, replace an item, rebuild or approve a manifest, change the frozen snapshot
or publish time, or change the original batch approval.

Use this deployment and operator sequence exactly:

1. Unload the worker LaunchAgent, then confirm the worker is stopped and no claim
   or drain remains active. Leave bounded-batch bypass disabled. Do not recover
   while a worker can claim queued work.
2. Apply the additive migrations to the application database with the unpooled
   migration connection:

   ```bash
   psql "$XHS_DATABASE_POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 \
     -f migrations/010_rednote_publish_job_recoveries.sql
   psql "$XHS_DATABASE_POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 \
     -f migrations/011_generation_aware_rednote_publish_job_recoveries.sql
   ```

3. Deploy the platform release containing the recovery API and UI. Do not rebuild,
   supersede, or approve a batch and do not create a replacement job.
4. In `/admin`, refresh **Bounded batch approval**. **Eligible pre-dispatch
   recovery** appears only when the approved batch, two-way item/job linkage,
   immutable snapshots, manifest/item hashes, source revision, exact error,
   pre-dispatch null evidence, and absence of alternate ownership still match.
5. Confirm the Day 5 job remains safely queued and do not recover or otherwise
   mutate it. Compare every displayed Vibe Atlas job, batch, item, manifest hash,
   item hash, source revision, and original publish time with the approved change
   record. Select
   **Confirm exact-job recovery** once for the proven later failure generation and
   accept the confirmation that no second approval or replacement job is created.
6. A created response writes one immutable audit row for that claim generation and
   moves the same job and item to `queued`. An exact repeated request is idempotent
   only while that job is
   still safely queued at the latest audited generation. A later recovery is
   allowed only after a distinct greater claim attempt has later exact claimed and
   completed timestamps and independently satisfies every original precondition.
   Unchanged generations, changed evidence, or a job claimed by a worker fail closed.
7. Confirm both the Vibe Atlas and Day 5 rows are queued. Keep the worker unloaded.
   Enable the bounded-batch bypass in a separately controlled change, confirm it,
   and only then start the worker in a separately controlled start step.

The authenticated action is
`POST /admin/api/publish-job-recoveries` with exactly:

```json
{
  "batchId": "uuid",
  "manifestHash": "64-character lowercase SHA-256",
  "itemId": "uuid",
  "jobId": "uuid",
  "itemHash": "64-character lowercase SHA-256",
  "snapshotRevision": "canonical UTC timestamp",
  "confirmed": true
}
```

The action accepts only an allowlisted Cloudflare Access operator. It records that
operator and the recovery time in `rednote_publish_job_recoveries`. Never call it
for a different error, after staging/authorization/dispatch/publication evidence,
for an unapproved or superseded batch, or while another publish or reconciliation
lifecycle owns the post. Because an in-flight external reconciliation has no
canonical page ID until it succeeds, any `processing` external reconciliation
conservatively blocks recovery until it finishes.

### Already-published manual reconciliation

XHS Admin owns reconciliation for a post that an operator published manually.
On an unpublished canonical row with no active local publish job, choose
**Already published? Reconcile**, enter the exact public RedNote URL or bare note
ID, confirm that the post is already public, and queue verification. A terminal
failed local publish job is eligible and remains unchanged as audit history.
Queued or verifying manual reconciliation blocks another local publish job for
the same canonical row.

The server accepts only a bare ID containing letters, numbers, `_`, or `-`, or
the exact query-free URL
`https://www.rednote.com/explore/<noteId>`. It re-reads the canonical Notion
record and freezes title, caption, and media type; the browser cannot submit
those claims. Published rows, active local jobs, alternate hosts, query strings,
fragments, trailing slashes, and conflicting identities fail closed.

The Mac worker uses a separate lane:

1. `GET /api/manual-reconciliations/due?limit=10` with the worker bearer token.
   The default is 10 and maximum is 20. It always returns HTTP 200:

   ```json
   {
     "items": [{
       "id": "request-uuid",
       "notionPageId": "canonical-page-id",
       "noteId": "note_123",
       "shareUrl": "https://www.rednote.com/explore/note_123",
       "expected": {
         "title": "Canonical title",
         "caption": "Canonical caption",
         "mediaType": "video"
       },
       "verificationAttempts": 0,
       "claimToken": "claim-uuid",
       "claimExpiresAt": "2026-08-03T13:00:00.000Z"
     }]
   }
   ```

   Every item has an independent rotating lease. The worker must open
   Creator/Notes Manager, locate the exact note ID, verify the exact canonical
   URL, title, caption, and media type, and **never click Publish**.
2. Submit one result to `POST /api/manual-reconciliations/{id}/result` with
   `X-Manual-Reconciliation-Claim-Token: <claimToken>`:

   ```json
   {
     "status": "verified",
     "snapshot": {
       "noteId": "note_123",
       "shareUrl": "https://www.rednote.com/explore/note_123",
       "title": "Canonical title",
       "caption": "Canonical caption",
       "mediaType": "video"
     }
   }
   ```

   Retryable uncertainty uses
   `{"status":"verification_pending","code":"SAFE_CODE","message":"Safe operator guidance"}`.
   A definitive mismatch uses
   `{"status":"failed","code":"SAFE_CODE","message":"Safe operator guidance"}`.
   Messages containing URLs or credential-like data are rejected.
3. A verified snapshot must exactly equal the durable request. XHS then reuses
   the external reconciliation receipt, checks that the RedNote identity does
   not belong to another canonical row, updates only the request's
   `notionPageId`, and writes the established Published fields. A Notion outage
   requeues the same request and receipt idempotently; it never creates a second
   canonical row or audit receipt.

Admin displays `queued`, `verifying`, `reconciled`, or `failed`. Failed requests
are retried in place after eligibility is rechecked. Manual reconciliation is
publication verification, not metrics scraping: it does not use
`/api/rednote-metrics/*`, the local dispatch lane, or the local verification
lane.

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
  A lane with no due job returns HTTP 204 with no response body.

Metrics use a separate bounded batch because they are read-only collection work:

1. `GET /api/rednote-metrics/due?limit=20` claims at most 20 reconciled posts.
   The default and maximum are both 20. Add `onDemand=true` to include posts
   older than 90 days. It always returns HTTP 200 with
   `{"items":[],"summary":...}` when empty. Every item has its own claim token
   and lease:

   ```json
   {
     "notionPageId": "canonical-post-page-id",
     "noteId": "rednote-id",
     "shareUrl": "https://www.rednote.com/explore/rednote-id",
     "publishedAt": "2026-08-01T12:00:00.000Z",
     "claimToken": "11111111-1111-4111-8111-111111111111",
     "claimExpiresAt": "2026-08-02T12:30:00.000Z",
     "previousMetrics": {
       "views": 100,
       "likes": 10,
       "comments": 2,
       "saves": 3,
       "shares": 1
     },
     "lastObservedAt": "2026-08-02T06:00:00.000Z"
   }
   ```

   `previousMetrics` is an optional server baseline from the last accepted
   observation. It is not a scrape target; the worker must scrape fresh current
   values. `lastObservedAt` has the same baseline meaning.
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

   The bearer token remains in `Authorization`; each metrics claim token is
   placed on its own observation as `claimToken`, not in a shared header.

The metrics service writes `post_performance_snapshots` only when values changed
or a cadence checkpoint is due. Exact retries coalesce without writes, and an
empty due batch performs no writes. Responses contain one run summary with
`claimed`, `verified`, `measured`, `snapshotsWritten`, and `failures`; there are
no field-level updates. These endpoints persist observation history only and do
not mutate the canonical Notion Posts database or add CONNECT-owned behavior.
Within a structurally valid batch, an expired or superseded item token increments
`failures` while other current items still commit; the endpoint still returns
HTTP 200 with the one summary. An exact replay of the same token, timestamp, and
metrics is accepted after lease expiry and performs no writes. A changed replay
after expiry is stale and counted as a failure. Invalid JSON/schema or bounds
return 400, invalid bearer auth returns 401, and unexpected storage failures
return 500.

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
