# RedNote publishing control-plane contract

`rednote-publishing/v1` remains the immutable execution-packet contract. The
authoritative TypeScript definitions are in
`src/lib/rednote-publishing-contract-v1.ts`. Every frozen browser payload
contains `expectedAccountId` alongside the exact copy, ordered media identities
and checksums, visibility, mode, and requested timing. The expected account is
therefore covered by the packet digest and must be checked in authenticated
RedNote Creator before any publish side effect.

Every executable claim requires `expectedAccountId` and an ordered `media`
array of 1–18 immutable `{identity,type,url}` entries. All entries have the same
type; video claims contain exactly one. The compatibility fields `mediaType`
and `mediaUrl` are projections of `media[0]`, not independent inputs.
`identity` is lowercase SHA-256 of `JSON.stringify({type,url})` with that key
order. Batch and Ready ×3 authorization records carry an array that must equal
the claim array entry-for-entry and in order. For image posts, xhs-platform
places the operator-selected image first and then preserves all remaining
canonical image URLs in source order.

The worker response contract is `rednote-worker-result/v2`:

```json
{
  "contractVersion": "rednote-worker-result/v2",
  "outcome": "acknowledged",
  "noteId": "durable-note-id",
  "acknowledgedAt": "2026-08-01T12:00:00Z",
  "authenticatedAccount": {
    "accountId": "creator-account-id",
    "capturedAt": "2026-08-01T12:00:01Z",
    "ownership": "owned"
  },
  "xsecAccess": {
    "accessible": true,
    "capturedAt": "2026-08-01T12:00:02Z"
  },
  "publicIndex": {
    "status": "indexed",
    "checkedAt": "2026-08-01T12:00:03Z",
    "publicUrl": "https://www.rednote.com/explore/durable-note-id"
  }
}
```

`xsecAccess` and `publicIndex` are optional. An acknowledged outcome requires a
`noteId` and authenticated ownership evidence, but it does not require a public
URL. The remaining outcomes are:

```json
{"contractVersion":"rednote-worker-result/v2","outcome":"scheduled","acknowledgedAt":"2026-08-01T12:00:00Z","scheduledFor":"2026-08-02T12:00:00Z","authenticatedAccount":{"accountId":"creator-account-id","capturedAt":"2026-08-01T12:00:01Z","ownership":"owned"},"noteId":"optional-durable-note-id"}
{"contractVersion":"rednote-worker-result/v2","outcome":"ambiguous","code":"POST_CLICK_TIMEOUT","message":"Publication outcome is unknown","occurredAt":"2026-08-01T12:00:00Z"}
{"contractVersion":"rednote-worker-result/v2","outcome":"rejected","code":"UPSTREAM_REJECTED","message":"RedNote rejected publication","occurredAt":"2026-08-01T12:00:00Z"}
```

For `scheduled`, authenticated-account evidence is required and `noteId` is
optional. `scheduledFor` must represent the same instant as the frozen
`browserPayload.targetPublishAt`. A mismatched Creator readback or authenticated
account is recorded as an ambiguous verification case and must not be
republished automatically.

`acknowledged` means RedNote accepted publication and issued the durable
`noteId`. With matching authenticated-account ownership it authorizes
`Publication Status = Published` and
`Publication Next Step = Backfill metrics`. `scheduled` closes dispatch and
enters receipt verification. `ambiguous` records `outcome_unknown`, closes
dispatch, and enters Verify receipt; it must never be automatically republished.
`rejected` records a known failure. A later attempt is possible only through the
normal approval and authorization path.

A `scheduled` receipt confirms only that the Creator submission accepted the
frozen native schedule. The job remains verification-only (the durable status
is `scheduled`, with a due verification time) and does not backfill Notion as
Published. Final publication requires later post-time Creator Manager or public
note identity evidence.

If result delivery fails after the executor durably records a terminal v2
result, the result endpoint accepts one late `scheduled`, `ambiguous`, or
`rejected` result for the exact original `(jobId, claimToken)`. Acceptance never
reopens the attempt or makes the job dispatch-claimable. Exact replay is
idempotent; a different token or conflicting result is rejected. An expiry-only
`outcome_unknown` may be refined by an exact scheduled receipt, while a
canonical post-click `ambiguous` result remains verify-only and cannot later be
replaced by success. A late rejection is accepted only when no dispatch or
publication receipt evidence conflicts with a definitive pre-click failure.

The durable identity is `noteId`. A canonical query-free
`https://www.rednote.com/explore/{noteId}` URL is optional derived metadata.
Current `noteId` + `xsecToken` reachability is renewable evidence, not identity.
Public indexing is asynchronous, informational evidence and never blocks,
downgrades, or reopens Published. Explicit removed/restricted evidence is
preserved without deleting publication history.

Migration `017_rednote_publishing_attempts.sql` supplies immutable attempts,
append-only events, frozen payload digests, terminal outcomes, and immutable
receipts. Migration `023_rednote_worker_result_v2.sql` makes receipt URLs
optional, adds v2 receipt state and current evidence summaries, and creates the
append-only `rednote_publication_evidence` history. Existing claim-token/lease
compare-and-set behavior, one-shot authorization, active-attempt uniqueness,
idempotency, duplicate prevention, and Notion `lastEditedTime` protection remain
authoritative in xhs-platform.

## Read-only adapter evidence

The separate read-only MCP adapter uses:

- `GET /api/rednote-publications/{noteId}/evidence?workspaceId={workspaceId}`
- `POST /api/rednote-publications/{noteId}/evidence`

Both require the worker bearer token and an `X-Workspace-ID` header. POST
accepts exactly one `rednote-evidence/v1` body:

```json
{"contractVersion":"rednote-evidence/v1","kind":"authenticated_account","capturedAt":"2026-08-01T12:00:00Z","accountId":"creator-account-id","ownership":"owned"}
{"contractVersion":"rednote-evidence/v1","kind":"xsec_access","capturedAt":"2026-08-01T12:05:00Z","accessible":true}
{"contractVersion":"rednote-evidence/v1","kind":"public_index","capturedAt":"2026-08-01T12:10:00Z","status":"pending"}
{"contractVersion":"rednote-evidence/v1","kind":"public_index","capturedAt":"2026-08-01T12:20:00Z","status":"indexed","publicUrl":"https://www.rednote.com/explore/durable-note-id"}
{"contractVersion":"rednote-evidence/v1","kind":"removed_restricted","capturedAt":"2026-08-01T12:30:00Z","status":"restricted"}
```

Never send `xsecToken`, cookies, authorization headers, or other credentials.
The endpoint rejects unknown fields and stores only reachability plus capture
time. Resolve xsec routes live from `noteId`; refresh evidence when it changes.
If an acknowledged result was quarantined for account mismatch, reclaim that
job through the verification lane after correcting the authenticated account,
then resubmit the same acknowledged v2 receipt. The control plane attaches the
corrected evidence to the existing acknowledged attempt and performs the
concurrency-checked Notion reconciliation. Never create a new publish claim to
resolve ambiguous or mismatched receipt evidence.

Legacy Playwright result bodies remain accepted during migration, but only v2
provides the noteId-first semantics above. Compatibility must not be used to
reintroduce a stable-public-URL requirement.
