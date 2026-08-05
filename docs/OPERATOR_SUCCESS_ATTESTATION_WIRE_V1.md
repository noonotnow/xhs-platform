# Operator success-attestation worker contract

Revision literal: `rednote.operator-success-attestation.v1`.

The worker reports that revision in
`X-Local-Publish-Worker-Capabilities` on every authenticated publish request.
The platform enables the admin action only while that exact authenticated
heartbeat is no more than five minutes old. Roll out the worker first, observe
the heartbeat, then roll out the platform. Partial rollout fails closed.

The full server identity is `jobId`, `pageId`, `batchId`, `itemId`,
`snapshotDigest`, `itemHash`, `scheduledAt`, and `claimTokenDigest`. The server
derives it under locks. `snapshotDigest === itemHash`: lowercase-hex SHA-256 of
UTF-8 compact `JSON.stringify` for the frozen snapshot after recursively
sorting object keys with JavaScript `localeCompare`; arrays retain order.
`scheduledAt` is exactly `snapshot.publishAt`. `claimTokenDigest` is
lowercase-hex SHA-256 over the prior raw claim token's UTF-8 bytes, with no
normalization, prefix, suffix, parsing, or newline. Raw tokens are never
returned after attestation.

`POST /admin/api/local-publish-job-success-attestations` accepts exactly:

```json
{"revision":"rednote.operator-success-attestation.v1","confirmed":true,"identity":{"jobId":"uuid","pageId":"id","batchId":"uuid","itemId":"uuid","snapshotDigest":"hex","itemHash":"hex","scheduledAt":"ISO UTC","claimTokenDigest":"hex"}}
```

Only an approved, two-way-linked, scheduled bounded-batch item with identical
snapshots, failed job/item state, `SCHEDULED_DISPATCH_AMBIGUOUS`, consumed
dispatch authorization, no publication identity, and current capability is
eligible. The append-only audit and linked job/item `operator_attested`
transition are atomic. That state is dispatch-terminal, verification-pending,
and permanently excluded from claims, recovery, and requeue.

The response is `201` initially and `200` for exact replay:

```json
{"attestation":{"id":"uuid","revision":"rednote.operator-success-attestation.v1","state":"operator_attested","verification":"pending_receipt","publicationVerified":false,"identity":{}},"release":{"revision":"rednote.operator-success-attestation.v1","jobId":"uuid","attestationId":"uuid","disposition":"release_compose_slot","reason":"operator_attested","dispatchTerminal":true,"verification":"pending_receipt","publicationVerified":false,"identity":{}}}
```

`GET /api/local-publish-jobs/{jobId}/operator-attestation-release` uses worker
auth and the prior raw `X-Local-Publish-Claim-Token`; it returns `204` before
attestation and the release envelope afterward. Release identity intentionally
omits `itemId`, which existing v5 durable worker state does not retain and
cannot safely derive. Its exact fields are `jobId`, `pageId`, `batchId`,
`snapshotDigest`, `itemHash`, `scheduledAt`, and `claimTokenDigest`. The
platform binds this projection to the full audit through `attestationId` and
the claim digest. This first acknowledgment only releases the sole Creator
compose slot; it never verifies publication.

`POST /api/local-publish-jobs/{jobId}/operator-attested-receipt` uses worker
auth without creating a claim. It carries `revision`, `attestationId`, the
exact projected release identity, and either
`{"status":"pending","code":"RECEIPT_NOT_FOUND","message":"safe text"}` or
`{"status":"verified","noteId":"id","shareUrl":"https://www.rednote.com/explore/id"}`.
Pending preserves the receipt-only lane. Verified enters existing verified
reconciliation only after exact identity validation. Neither can reacquire the
compose slot.

Exact operator replay compares revision, actor, and every full identity field.
Exact worker replay compares revision, attestation ID, and every projected
field. Named `409` codes are `ATTESTATION_IDENTITY_CONFLICT`,
`ATTESTATION_LIFECYCLE_CONFLICT`, and `ATTESTATION_RECEIPT_CONFLICT`.
