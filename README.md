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

### Publish-ready CREATE packets

The protected admin loads unpublished Rednote records whose canonical
`Publish packet ready` property is checked. The server reads `Headline`,
`Weibo text`, `Image URLs`, `Thumbnail`, `Series`, and `Status` using the same
field aliases as CREATE. Only durable HTTPS MP4 assets under
`images.xhs.justlikekatie.com/videos/assets/` can be sent to the microservice.

Publishing is always manual: the operator selects a packet, reviews the media,
and confirms the irreversible action. The browser calls this application only;
the Notion token and `XHS_API_KEY` remain server-side. After the microservice
confirms `{ status: "success", note_id, share_url }`, the server changes the
Notion status to `Published`, stores `Rednote URL`, and stores `Rednote Note ID`
when that property exists. It advances `Next action` only when the schema
already contains `Backfill URL/metrics` (preferred) or `No action`. Apply
`migrations/002_xhs_publish_receipts.sql` before deployment; the durable receipt
prevents concurrent or repeated publication of the same Notion page.
A successful XHS publish followed by a failed
Notion backfill is reported as a blocking partial failure with the confirmed
share URL so the operator does not publish twice.

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
