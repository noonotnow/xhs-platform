# XHS Platform — Build Specification

> Full technical specification for the XHS platform MVP.

## Table of Contents

1. Goals & Constraints
2. Tech Stack
3. Database Schema
4. API Specification
5. OAuth 2.0 Flow Design
6. Frontend Architecture
7. Deployment Architecture
8. Timeline & Milestones

---

## Section 1: Goals & Constraints

### Primary Goals

- Build a custom social platform for curated CN content sharing
- Provide OAuth 2.0 API for Connect Hub cross-platform posting
- Support text + image note creation
- Enable user profiles and public feed
- Primary CN channel while Weibo is locked (风控异常)

### MVP Scope

- Text + image notes (no video)
- User registration + login
- Public chronological feed
- User profiles
- OAuth 2.0 authorization server
- REST API with token authentication
- Image upload + optimization

### Success Criteria

- User can register and log in
- User can create text + image notes via API
- Public feed displays notes chronologically
- OAuth 2.0 flow works end-to-end with Connect Hub
- Platform deployed to production at xhs.justlikekatie.com

---

## Section 2: Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 14 (App Router) | SSR + API routes |
| Database | PostgreSQL (Vercel Postgres) | Serverless-compatible |
| Auth (Users) | Custom JWT | Handles user sessions |
| Auth (3rd Party) | Custom OAuth 2.0 server | Handles Connect Hub integration |
| Storage | Cloudflare R2 | S3-compatible, fast CDN |
| Deployment | Vercel | Auto-deploy from GitHub |

---

## Section 3: Database Schema

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  bio TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE TABLE oauth_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT UNIQUE NOT NULL,
  client_secret TEXT NOT NULL,
  redirect_uris TEXT[] NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID REFERENCES oauth_clients(id) ON DELETE CASCADE,
  access_token TEXT UNIQUE NOT NULL,
  refresh_token TEXT UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE note_stats (
  note_id UUID PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  views INT DEFAULT 0,
  likes INT DEFAULT 0,
  comments INT DEFAULT 0,
  shares INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE INDEX notes_user_id_idx ON notes(user_id);
CREATE INDEX notes_created_at_idx ON notes(created_at DESC);
CREATE INDEX oauth_tokens_access_token_idx ON oauth_tokens(access_token);
CREATE INDEX comments_note_id_idx ON comments(note_id);
```

---

## Section 4: API Specification

### Authentication
```
POST /api/auth/signup    — Disabled (410 Gone)
POST /api/auth/login     — Disabled (410 Gone)
POST /api/auth/logout    — Logout
GET  /api/auth/session   — Check session
```

### Notes (Authenticated)
```
POST   /api/notes        — Create note
GET    /api/notes        — List notes (paginated)
GET    /api/notes/:id    — Get single note
PUT    /api/notes/:id    — Update note
DELETE /api/notes/:id    — Delete note
```

### Media
```
POST /api/upload         — Upload image to R2
```

### OAuth 2.0
```
GET  /oauth/authorize    — Authorization screen
POST /oauth/token        — Exchange code for token
POST /oauth/refresh      — Refresh access token
```

### Analytics (for Connect Hub)
```
GET  /api/notes/:id/stats  — Engagement metrics
GET  /api/analytics/user   — User-level analytics
GET  /api/comments/:noteId — Get comments
POST /api/comments         — Post comment reply
```

### Local RedNote Worker

All worker routes require the configured local worker bearer token and disable
caching.

| Route | Contract |
|---|---|
| `GET /api/local-publish-jobs/next?lane=dispatch` | Atomic single claim for staging/dispatch; `FOR UPDATE SKIP LOCKED LIMIT 1` |
| `GET /api/local-publish-jobs/next?lane=verification` | Atomic single claim only when verification or reconciliation is due |
| `GET /api/local-publish-jobs/next` | Backward-compatible combined lane |
| `POST /api/local-publish-jobs/:id/result` | Per-job token result; preserves staging, human approval, verification, and reconciliation gates |
| `POST /admin/api/local-publish-job-success-attestations` | Access-authenticated exact scheduled-success attestation; immutable receipt, dispatch quarantine, and immediate worker release handshake |
| `POST /admin/api/publish-job-recoveries` | Cloudflare Access operator action that requeues the same exact approved job only for a pre-dispatch `BOUNDED_BATCH_BYPASS_DISABLED` terminal claim generation and writes one append-only audit per generation |
| `GET /api/rednote-metrics/due?limit=20` | Bounded metrics batch with a distinct token and lease per post |
| `POST /api/rednote-metrics/observations` | Consolidated observations and one coalesced run summary |

Metrics cadence is 6-hourly through 48 hours, daily through day 14, weekly
through day 90, and manual afterward. The server stores a performance snapshot
only for changed metrics or a scheduled checkpoint. Empty scans and exact
retries do not write. Metrics storage references the canonical Posts page ID
and never mutates Notion or CONNECT-owned records.

Lane claims return HTTP 204 with no body when empty. Metrics due-list requests
always return HTTP 200 with `{items,summary}`, including `items: []` when empty.
Each due item carries its own body-level `claimToken` for the consolidated
observation request; there is no batch claim-token header. Optional
`previousMetrics` and `lastObservedAt` values are baselines from the last
accepted scrape, not targets to re-submit without scraping.

For a valid observation batch, stale item tokens are counted in
`summary.failures` while valid items commit and contribute to
`summary.measured`; the response remains HTTP 200. Exact token/timestamp/metrics
replays are idempotent after expiry and write nothing. Changed expired replays
fail per item. Validation, authentication, stale single-job results, and
unexpected storage failures use 400, 401, 409, and 500 respectively.

#### Operator success release protocol

`operator-success-attestation/v1` splits one job into dispatch-terminal and
receipt-pending concerns. Creation is capability-gated by
`LOCAL_PUBLISH_WORKER_ATTESTATION_CONTRACT_REVISION`; deploy the migration and
platform with the gate unset, deploy the v1 worker, then enable the exact
literal. The action accepts only the exact approved bounded scheduled job/item
snapshot and only an expired staged attempt with consumed dispatch authorization
or terminal `AMBIGUOUS_CREATOR_UI` evidence.

The immutable receipt records operator, time, page/job/batch/item IDs, requested
UTC `publishAt`, Eastern expected-outcome text, revision, manifest/item digest,
and SHA-256 of the revoked prior claim token. `snapshotDigest === itemHash`;
the digest is SHA-256 of stable JSON with recursively sorted object keys and
array order preserved.

The first due verification claim is release-only and sets
`successAttestation.releaseRequired:true`. The worker must persist the full
receipt as a local tombstone and atomically clear only a matching local slot,
without opening Creator. It acknowledges with the exact
`ATTESTATION_RELEASE_CONSUMED` result and contract message. The platform appends
an immutable acknowledgement and schedules later verification at
`max(now, requestedPublishAt + 15 minutes)`. Only subsequent claims with
`releaseRequired:false` may discover identity in Notes Manager. Identity-free
delays retain `operator_attested`; exact `verified` identity follows normal
Notion reconciliation. Neither path is eligible for dispatch or recovery.

Named 409 boundaries are `JOB_OPERATOR_ATTESTED` for any stale dispatch path,
`STALE_CLAIM` for a mismatched current verification claim,
`ATTESTATION_RELEASE_REQUIRED` before receipt lookup,
`ATTESTATION_RELEASE_ACK_MISMATCH` for a changed reserved acknowledgement, and
`ATTESTATION_RELEASE_ACK_CONFLICT` for different durable ownership. Exact
attestation and acknowledgement replays are idempotent; changed evidence fails
closed.

---

## Section 5: OAuth 2.0 Flow Design

1. Connect Hub redirects user to `/oauth/authorize`
2. User sees consent screen, clicks "Authorize"
3. XHS redirects to Connect Hub callback with auth code
4. Connect Hub exchanges code for access + refresh tokens
5. Connect Hub uses access token to post notes

### Token Lifetimes
- Authorization code: 10 minutes
- Access token: 1 hour
- Refresh token: 30 days

---

## Section 6: Frontend Architecture

| Path | Type | Description |
|---|---|---|
| `/` | Public | Feed/timeline |
| `/login` | Public | Login page |
| `/register` | Public | Registration page |
| `/new` | Protected | Create note form |
| `/notes/[id]` | Public | Single note view |
| `/users/[id]` | Public | User profile |
| `/oauth/authorize` | Protected | OAuth consent screen |

---

## Section 7: Deployment Architecture

```
Vercel (Next.js)
  ├── SSR Pages + API Routes
  └── Serverless Functions
       ├── /api/* (REST API)
       └── /oauth/* (OAuth server)

Vercel Postgres
  └── Database (users, notes, oauth)

Cloudflare R2
  └── Image storage (CDN: images.xhs.justlikekatie.com)
```

### Domains
- Platform: xhs.justlikekatie.com
- Media CDN: images.xhs.justlikekatie.com

---

## Section 8: Timeline & Milestones

| Week | Deliverable |
|---|---|
| Week 1 | Core posting — Katie can POST a note via API |
| Week 2 | OAuth + Connect Hub integration |
| Week 3 | Frontend polish, public feed, mobile responsive |

---

## Environment Variables

```bash
DATABASE_URL=postgresql://...
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=xhs-images
R2_PUBLIC_URL=https://images.xhs.justlikekatie.com
JWT_SECRET=
NEXTAUTH_URL=https://xhs.justlikekatie.com
```
