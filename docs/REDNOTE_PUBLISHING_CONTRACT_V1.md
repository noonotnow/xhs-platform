# Rednote publishing contract v1

`rednote-publishing/v1` and migration `017` are an additive shadow contract for
the future XHS Admin control plane. Existing workers, routes, legacy lifecycle
tables, and production behavior remain unchanged. This phase does not dual-write,
backfill, claim, publish, reconcile, or cut over any runtime path.

The authoritative TypeScript API is
`src/lib/rednote-publishing-contract-v1.ts`. It freezes canonical Post status,
next-action, and publish-execution values; attempt outcomes; executor identity;
frozen payload, event/evidence, and receipt shapes; Published identity; active
attempt lifecycle; and new-attempt retry semantics. `Backfill receipt` is the
only writable receipt queue. `Backfill metadata` and `Backfill URL/metrics` are
read-only aliases accepted solely when interpreting legacy records.

Migration `017_rednote_publishing_attempts.sql` adds immutable attempts,
append-only events/evidence, and immutable receipts. Frozen attempt inputs never
change. The only attempt control-plane transitions are: setting a terminal
outcome once, advancing receipt lookup state until terminal, clearing `active`,
and setting a supersession pointer once. A partial unique index permits only one
active worker-originated attempt per Notion Post. A single
`execution_started` event per attempt prevents automatic same-attempt retry.
Receipts require URL, Note ID, confirmed platform publish time, and provenance;
requested/target time remains separate intent.

No legacy rows are classified or copied by this migration. A later backfill must
leave ambiguous outcomes unknown and quarantine them for review rather than
turning historical failures into successes or retries. Human/operator
supersession must create a new attempt and retain the prior attempt and evidence.

The next phase should implement XHS Admin transactions over these types and
tables: immutable attempt creation, claim/pointer compare-and-set, event append,
terminal resolution, receipt capture, and supersession. CREATE and PLAN may
request those transactions, but must never mutate execution fields directly and
must fail closed when the required XHS Admin execution action is unavailable.
