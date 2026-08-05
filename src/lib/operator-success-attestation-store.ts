import type { PoolClient, QueryResultRow } from 'pg';
import { isDeepStrictEqual } from 'util';
import { getPool, sql } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { manifestHash } from '@/lib/rednote-publish-batches';
import {
  claimTokenDigest,
  OPERATOR_SUCCESS_ATTESTATION_REVISION,
  OPERATOR_SUCCESS_CAPABILITY_MAX_AGE_SECONDS,
} from '@/lib/operator-success-attestation';
import type {
  LocalPublishSnapshot,
  OperatorSuccessAttestationIdentity,
  OperatorSuccessAttestationSummary,
} from '@/types/local-publish-job';

type WorkerAttestationIdentity = Omit<OperatorSuccessAttestationIdentity, 'itemId'>;

interface CandidateRow extends QueryResultRow {
  job_id: string;
  notion_page_id: string;
  job_status: string;
  job_snapshot: LocalPublishSnapshot;
  claim_token: string | null;
  job_error_code: string | null;
  dispatch_authorized_at: Date | string | null;
  dispatched_at: Date | string | null;
  note_id: string | null;
  share_url: string | null;
  batch_item_id: string;
  item_id: string;
  item_job_id: string | null;
  item_state: string;
  item_hash: string;
  item_snapshot: LocalPublishSnapshot;
  dispatch_mode: string;
  batch_id: string;
  batch_status: string;
  approved_at: Date | string | null;
}

interface AuditRow extends QueryResultRow {
  id: string;
  revision: string;
  local_publish_job_id: string;
  notion_page_id: string;
  batch_id: string;
  batch_item_id: string;
  snapshot_digest: string;
  item_hash: string;
  scheduled_at: Date | string;
  claim_token_digest: string;
  attested_by: string;
  receipt_status: 'pending' | 'verified';
  receipt_code: string | null;
  receipt_message: string | null;
  receipt_note_id: string | null;
  receipt_share_url: string | null;
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function identityFromAudit(row: AuditRow): OperatorSuccessAttestationIdentity {
  return {
    jobId: row.local_publish_job_id,
    pageId: row.notion_page_id,
    batchId: row.batch_id,
    itemId: row.batch_item_id,
    snapshotDigest: row.snapshot_digest,
    itemHash: row.item_hash,
    scheduledAt: timestamp(row.scheduled_at),
    claimTokenDigest: row.claim_token_digest,
  };
}

function summary(row: AuditRow): OperatorSuccessAttestationSummary {
  return {
    id: row.id,
    revision: OPERATOR_SUCCESS_ATTESTATION_REVISION,
    state: 'operator_attested',
    verification: row.receipt_status === 'verified' ? 'verified' : 'pending_receipt',
    publicationVerified: row.receipt_status === 'verified',
    identity: identityFromAudit(row),
  };
}

function workerIdentity(full: OperatorSuccessAttestationIdentity): WorkerAttestationIdentity {
  return {
    jobId: full.jobId,
    pageId: full.pageId,
    batchId: full.batchId,
    snapshotDigest: full.snapshotDigest,
    itemHash: full.itemHash,
    scheduledAt: full.scheduledAt,
    claimTokenDigest: full.claimTokenDigest,
  };
}

function release(row: AuditRow) {
  const full = identityFromAudit(row);
  return {
    revision: OPERATOR_SUCCESS_ATTESTATION_REVISION,
    jobId: row.local_publish_job_id,
    attestationId: row.id,
    disposition: 'release_compose_slot' as const,
    reason: 'operator_attested' as const,
    dispatchTerminal: true,
    verification: row.receipt_status === 'verified' ? 'verified' as const : 'pending_receipt' as const,
    publicationVerified: row.receipt_status === 'verified',
    identity: workerIdentity(full),
  };
}

function conflict(message: string, code = 'ATTESTATION_LIFECYCLE_CONFLICT') {
  return new LocalPublishJobError(message, code, 409);
}

function sameIdentity(left: OperatorSuccessAttestationIdentity, right: OperatorSuccessAttestationIdentity) {
  return isDeepStrictEqual(left, right);
}

async function capabilityCurrent(client?: PoolClient) {
  const runner = client ?? getPool();
  const result = await runner.query(
    `SELECT 1
     FROM local_publish_worker_capabilities
     WHERE capability = $1
       AND last_seen_at > CURRENT_TIMESTAMP - ($2 * INTERVAL '1 second')`,
    [OPERATOR_SUCCESS_ATTESTATION_REVISION, OPERATOR_SUCCESS_CAPABILITY_MAX_AGE_SECONDS],
  );
  return Boolean(result.rows[0]);
}

export async function recordLocalPublishWorkerCapabilities(capabilities: string[]) {
  if (!capabilities.includes(OPERATOR_SUCCESS_ATTESTATION_REVISION)) return;
  await sql`
    INSERT INTO local_publish_worker_capabilities (capability, last_seen_at)
    VALUES (${OPERATOR_SUCCESS_ATTESTATION_REVISION}, CURRENT_TIMESTAMP)
    ON CONFLICT (capability) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
  `;
}

export async function operatorSuccessCapabilityAvailable() {
  return capabilityCurrent();
}

function expectedIdentity(row: CandidateRow): OperatorSuccessAttestationIdentity {
  if (!row.job_snapshot.publishAt || !row.claim_token) {
    throw conflict('The scheduled ambiguity is missing immutable dispatch identity.');
  }
  return {
    jobId: row.job_id,
    pageId: row.notion_page_id,
    batchId: row.batch_id,
    itemId: row.item_id,
    snapshotDigest: manifestHash(row.job_snapshot),
    itemHash: row.item_hash,
    scheduledAt: row.job_snapshot.publishAt,
    claimTokenDigest: claimTokenDigest(row.claim_token),
  };
}

function assertEligible(row: CandidateRow) {
  const expected = expectedIdentity(row);
  if (
    row.batch_item_id !== row.item_id ||
    row.item_job_id !== row.job_id ||
    row.batch_status !== 'approved' ||
    !row.approved_at ||
    row.dispatch_mode !== 'scheduled' ||
    row.job_status !== 'failed' ||
    row.item_state !== 'failed' ||
    row.job_error_code !== 'SCHEDULED_DISPATCH_AMBIGUOUS' ||
    !row.dispatch_authorized_at ||
    !isDeepStrictEqual(row.job_snapshot, row.item_snapshot) ||
    expected.snapshotDigest !== row.item_hash ||
    row.note_id ||
    row.share_url
  ) {
    throw conflict('The job is not the exact eligible scheduled ambiguity.');
  }
  return expected;
}

async function loadCandidate(client: PoolClient, jobId: string) {
  const result = await client.query<CandidateRow>(
    `SELECT
       job.id AS job_id, job.notion_page_id, job.status AS job_status,
       job.snapshot AS job_snapshot, job.claim_token::text AS claim_token,
       job.error_code AS job_error_code, job.dispatch_authorized_at,
       job.dispatched_at, job.note_id, job.share_url, job.batch_item_id,
       item.id AS item_id, item.local_publish_job_id AS item_job_id,
       item.state AS item_state, item.item_hash, item.snapshot AS item_snapshot,
       item.dispatch_mode, batch.id AS batch_id, batch.status AS batch_status,
       batch.approved_at
     FROM local_publish_jobs AS job
     JOIN rednote_publish_batch_items AS item ON item.id = job.batch_item_id
     JOIN rednote_publish_batches AS batch ON batch.id = item.batch_id
     WHERE job.id = $1::uuid
     FOR UPDATE OF job, item, batch`,
    [jobId],
  );
  if (!result.rows[0]) throw conflict('The exact linked scheduled job does not exist.');
  return result.rows[0];
}

async function loadAudit(client: PoolClient, jobId: string) {
  const result = await client.query<AuditRow>(
    `SELECT * FROM local_publish_operator_success_attestations
     WHERE local_publish_job_id = $1::uuid`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

export async function attestStoredScheduledAmbiguity(
  supplied: OperatorSuccessAttestationIdentity,
  actor: string,
) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existing = await loadAudit(client, supplied.jobId);
    if (existing) {
      if (existing.attested_by !== actor || !sameIdentity(identityFromAudit(existing), supplied)) {
        throw conflict('This job has a different immutable success attestation.', 'ATTESTATION_IDENTITY_CONFLICT');
      }
      await client.query('COMMIT');
      return { attestation: summary(existing), release: release(existing), created: false };
    }
    if (!await capabilityCurrent(client)) {
      throw conflict('A compatible worker capability is not current.');
    }
    const row = await loadCandidate(client, supplied.jobId);
    const concurrent = await loadAudit(client, supplied.jobId);
    if (concurrent) {
      if (concurrent.attested_by !== actor || !sameIdentity(identityFromAudit(concurrent), supplied)) {
        throw conflict('This job has a different immutable success attestation.', 'ATTESTATION_IDENTITY_CONFLICT');
      }
      await client.query('COMMIT');
      return { attestation: summary(concurrent), release: release(concurrent), created: false };
    }
    const expected = assertEligible(row);
    if (!sameIdentity(expected, supplied)) {
      throw conflict('Supplied identity does not match server-derived identity.', 'ATTESTATION_IDENTITY_CONFLICT');
    }
    const inserted = await client.query<AuditRow>(
      `INSERT INTO local_publish_operator_success_attestations (
         revision, local_publish_job_id, notion_page_id, batch_id, batch_item_id,
         snapshot_digest, item_hash, scheduled_at, claim_token_digest, attested_by
       ) VALUES ($1, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8::timestamptz, $9, $10)
       RETURNING *`,
      [
        OPERATOR_SUCCESS_ATTESTATION_REVISION, expected.jobId, expected.pageId,
        expected.batchId, expected.itemId, expected.snapshotDigest, expected.itemHash,
        expected.scheduledAt, expected.claimTokenDigest, actor,
      ],
    );
    const itemChanged = await client.query(
      `UPDATE rednote_publish_batch_items
       SET state = 'operator_attested', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid AND state = 'failed' AND local_publish_job_id = $2::uuid`,
      [expected.itemId, expected.jobId],
    );
    const changed = await client.query(
      `UPDATE local_publish_jobs
       SET status = 'operator_attested', claim_token = NULL, claim_expires_at = NULL,
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
           error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid AND status = 'failed' AND note_id IS NULL AND share_url IS NULL`,
      [expected.jobId],
    );
    if (changed.rowCount !== 1 || itemChanged.rowCount !== 1) {
      throw conflict('The lifecycle changed while attestation was being recorded.');
    }
    await client.query('COMMIT');
    return {
      attestation: summary(inserted.rows[0]),
      release: release(inserted.rows[0]),
      created: true,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listOperatorSuccessAttestationState() {
  const available = await operatorSuccessCapabilityAvailable();
  const [eligible, audits] = await Promise.all([
    Promise.resolve(available).then(async (capabilityAvailable) => capabilityAvailable
      ? sql<CandidateRow>`
          SELECT
            job.id AS job_id, job.notion_page_id, job.status AS job_status,
            job.snapshot AS job_snapshot, job.claim_token::text AS claim_token,
            job.error_code AS job_error_code, job.dispatch_authorized_at,
            job.dispatched_at, job.note_id, job.share_url, job.batch_item_id,
            item.id AS item_id, item.local_publish_job_id AS item_job_id,
            item.state AS item_state, item.item_hash, item.snapshot AS item_snapshot,
            item.dispatch_mode, batch.id AS batch_id, batch.status AS batch_status,
            batch.approved_at
          FROM local_publish_jobs AS job
          JOIN rednote_publish_batch_items AS item ON item.id = job.batch_item_id
          JOIN rednote_publish_batches AS batch ON batch.id = item.batch_id
          WHERE job.status = 'failed'
            AND job.error_code = 'SCHEDULED_DISPATCH_AMBIGUOUS'
        `
      : { rows: [] as CandidateRow[] }),
    sql<AuditRow>`SELECT * FROM local_publish_operator_success_attestations`,
  ]);
  const eligibility = new Map<string, OperatorSuccessAttestationIdentity>();
  for (const row of eligible.rows) {
    try {
      eligibility.set(row.job_id, assertEligible(row));
    } catch {
      // Rows that fail any exact invariant are intentionally not exposed as actionable.
    }
  }
  return {
    capabilityAvailable: available,
    eligibility,
    attestations: new Map(audits.rows.map((row) => [row.local_publish_job_id, summary(row)])),
  };
}

export async function getOperatorAttestationRelease(jobId: string, rawClaimToken: string) {
  const result = await sql<AuditRow>`
    SELECT * FROM local_publish_operator_success_attestations
    WHERE local_publish_job_id = ${jobId}::uuid
  `;
  const row = result.rows[0];
  if (!row) return null;
  if (claimTokenDigest(rawClaimToken) !== row.claim_token_digest) {
    throw conflict('Release identity does not match the attested claim.', 'ATTESTATION_IDENTITY_CONFLICT');
  }
  return release(row);
}

function projectedMatches(row: AuditRow, supplied: WorkerAttestationIdentity) {
  return isDeepStrictEqual(workerIdentity(identityFromAudit(row)), supplied);
}

export async function recordOperatorAttestedReceipt(
  jobId: string,
  input: {
    attestationId: string;
    identity: WorkerAttestationIdentity;
    result: Record<string, unknown>;
  },
) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<AuditRow>(
      `SELECT * FROM local_publish_operator_success_attestations
       WHERE local_publish_job_id = $1::uuid FOR UPDATE`,
      [jobId],
    );
    const row = found.rows[0];
    if (!row || row.id !== input.attestationId || !projectedMatches(row, input.identity)) {
      throw conflict('Receipt identity does not match the attestation.', 'ATTESTATION_RECEIPT_CONFLICT');
    }
    if (input.result.status === 'pending') {
      if (row.receipt_status === 'verified') {
        throw conflict('A verified receipt cannot return to pending.', 'ATTESTATION_RECEIPT_CONFLICT');
      }
      const code = input.result.code;
      const message = input.result.message;
      if (typeof code !== 'string' || !/^[A-Z0-9_.-]{1,80}$/.test(code) ||
          typeof message !== 'string' || !message.trim() || message.length > 500) {
        throw new LocalPublishJobError('Pending receipt is invalid', 'VALIDATION_ERROR', 400);
      }
      const updated = await client.query<AuditRow>(
        `UPDATE local_publish_operator_success_attestations
         SET receipt_code = $2, receipt_message = $3, receipt_updated_at = CURRENT_TIMESTAMP
         WHERE id = $1::uuid RETURNING *`,
        [row.id, code, message.trim()],
      );
      await client.query('COMMIT');
      return summary(updated.rows[0]);
    }
    const noteId = input.result.noteId;
    const shareUrl = input.result.shareUrl;
    if (typeof noteId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(noteId) ||
        shareUrl !== `https://www.rednote.com/explore/${noteId}`) {
      throw new LocalPublishJobError('Verified receipt identity is invalid', 'VALIDATION_ERROR', 400);
    }
    if (row.receipt_status === 'verified') {
      if (row.receipt_note_id !== noteId || row.receipt_share_url !== shareUrl) {
        throw conflict('A different verified receipt already exists.', 'ATTESTATION_RECEIPT_CONFLICT');
      }
      await client.query('COMMIT');
      return summary(row);
    }
    const updated = await client.query<AuditRow>(
      `UPDATE local_publish_operator_success_attestations
       SET receipt_status = 'verified', receipt_note_id = $2, receipt_share_url = $3,
           receipt_code = NULL, receipt_message = NULL, receipt_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid RETURNING *`,
      [row.id, noteId, shareUrl],
    );
    const job = await client.query(
      `UPDATE local_publish_jobs
       SET status = 'verified', note_id = $2, share_url = $3,
           verified_at = COALESCE(verified_at, CURRENT_TIMESTAMP),
           next_verification_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid AND status = 'operator_attested'
         AND note_id IS NULL AND share_url IS NULL`,
      [jobId, noteId, shareUrl],
    );
    if (job.rowCount !== 1) {
      throw conflict('Attested job is no longer receipt-pending.', 'ATTESTATION_RECEIPT_CONFLICT');
    }
    await client.query('COMMIT');
    return summary(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
