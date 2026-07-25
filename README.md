# XHS Platform — xhs.justlikekatie.com

A custom XHS (小红书) platform for sharing visual notes and content.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Database**: Vercel Postgres
- **Image Storage**: Cloudflare R2 (S3-compatible)
- **Auth**: JWT (jose) + bcrypt
- **Deployment**: Vercel

## Getting Started

### Prerequisites

- Node.js 18+
- Vercel Postgres database
- Cloudflare R2 bucket

### Setup

1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env.local` and fill in values:
   ```bash
   cp .env.example .env.local
   ```

3. Run the database migration:
   ```bash
   # Connect to your Vercel Postgres database and run:
   psql $DATABASE_URL -f migrations/001_initial.sql
   ```

4. Run development server:
   ```bash
   npm run dev
   ```

## API Endpoints

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/signup` | Register (email, password, name) |
| POST | `/api/auth/login` | Login, returns JWT token |

### Notes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/notes` | ✅ | Create a note |
| GET | `/api/notes` | ❌ | List notes (paginated) |
| GET | `/api/notes/:id` | ❌ | Get single note |

### Upload

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/upload` | ✅ | Upload image (returns CDN URL) |

## Usage Examples

### Sign up
```bash
curl -X POST https://xhs.justlikekatie.com/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "katie@example.com", "password": "password123", "name": "Katie"}'
```

### Create a note
```bash
curl -X POST https://xhs.justlikekatie.com/api/notes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"content": "My first note! 🎉", "image_url": "https://images.xhs.justlikekatie.com/uploads/abc.jpg"}'
```

### Upload an image
```bash
curl -X POST https://xhs.justlikekatie.com/api/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@photo.jpg"
```

## Project Structure

```
src/
├── app/
│   └── api/
│       ├── auth/
│       │   ├── signup/route.ts
│       │   └── login/route.ts
│       ├── notes/
│       │   ├── route.ts
│       │   └── [id]/route.ts
│       └── upload/route.ts
├── lib/
│   ├── auth.ts      # JWT sign/verify + auth middleware
│   ├── db.ts        # Vercel Postgres client
│   └── r2.ts        # Cloudflare R2 upload helper
migrations/
└── 001_initial.sql  # Users + Notes tables
```

## Deployment

Push to main branch — Vercel auto-deploys. Ensure all environment variables are set in the Vercel dashboard.

## Week 1 Scope

- ✅ User signup/login with JWT auth
- ✅ Create, list, and get notes via API
- ✅ Image upload to Cloudflare R2
- ✅ Vercel-ready deployment config
