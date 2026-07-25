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
- **Auth:** JWT (custom) for user auth + custom OAuth 2.0 server for third-party
- **Storage:** Cloudflare R2 (images)
- **Deployment:** Vercel

## Features

### MVP (Phase 0)

- User registration + login
- Create text + image notes
- Public chronological feed
- User profiles
- OAuth 2.0 authorization server
- REST API with token authentication
- Image upload via Cloudflare R2

## Development

### Prerequisites

- Node.js 20+
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

## API Usage

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
