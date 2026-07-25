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
POST /api/auth/signup    — Register new user
POST /api/auth/login     — Login, returns JWT
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
