# Rednote publishing contract v1

`rednote-publishing/v1` and migration `017` are an additive shadow contract for
the future XHS Admin control plane. Existing workers, routes, legacy lifecycle
tables, and production behavior remain unchanged. This phase does not dual-write,
backfill, claim, publish, reconcile, or cut over any runtime path.

The authoritative TypeScript API is
`src/lib/rednote-publishing-contract-v1.ts`. It freezes canonical Post status,
next-action, and publish-execution values; attempt outcomes; executor identity;
frozen payload, event/evidence, and receipt shapes; Published identity; active
attempt lifecycle; and new-attempt retry semantics. `payloadRevision` is the
exact browser-payload schema revision (`rednote-browser-payload/v1`);
`sourcePostRevision` separately freezes the source Notion `last_edited_time`.
The frozen browser payload contains exact title, Caption, ordered tags, stable
ordered media identities, byte checksums, normalized MIME types, optional video
cover/poster, visibility, mode, and requested timing;
arbitrary creative fields are not part of the execution contract. `Backfill
receipt` is the only writable receipt queue. `Backfill metadata` and `Backfill
URL/metrics` are read-only aliases accepted solely when interpreting legacy
records with receipt/metrics completeness context.

Migration `017_rednote_publishing_attempts.sql` adds immutable attempts,
append-only events/evidence, and immutable receipts. Frozen attempt inputs never
change. The only attempt control-plane transitions are: setting a terminal
outcome once, advancing receipt lookup state until terminal, clearing `active`,
setting a supersession pointer once, and binding worker/Playwright run identity
from null once. A partial unique index permits only one
active worker-originated attempt per Notion Post. A single
`execution_started` event per attempt prevents automatic same-attempt retry.
Receipts require URL, Note ID, confirmed platform publish time, and provenance;
requested/target time remains separate intent.

No legacy rows are classified or copied by this migration. A later backfill must
leave ambiguous outcomes unknown and quarantine them for review rather than
turning historical failures into successes or retries. Human/operator
supersession must create a new attempt and retain the prior attempt and evidence.
The two supersession links cannot be made reciprocally consistent by independent
row constraints; the Phase 2 transaction must lock both attempts and write both
links atomically.

Before any runtime consumer cutover, Phase 2 may make only the narrow contract
precision additions described above: `sourcePostRevision` and per-asset
`mimeType`. They do not redefine existing fields or alter execution
architecture. XHS Admin derives the asset ID from the canonical R2 object key
and verifies MIME and SHA-256 from fetched bytes; it does not trust a URL suffix.

The next phase should implement XHS Admin transactions over these types and
tables: immutable attempt creation, claim/pointer compare-and-set, event append,
terminal resolution, receipt capture, and supersession. CREATE and PLAN may
request those transactions, but must never mutate execution fields directly and
must fail closed when the required XHS Admin execution action is unavailable.
