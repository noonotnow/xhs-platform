import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storedManifestHash } from '@/lib/rednote-publish-batch-store';

const migrationFiles = [
  '002_xhs_publish_receipts.sql',
  '003_local_publish_jobs.sql',
  '004_external_post_reconciliations.sql',
  '005_local_publish_job_lifecycle.sql',
  '006_rednote_worker_lanes.sql',
  '007_manual_reconciliation_requests.sql',
  '008_rednote_publish_batches.sql',
  '009_superseded_rednote_publish_batches.sql',
  '010_plan_rednote_batch_handoff.sql',
  '010_rednote_publish_job_recoveries.sql',
  '011_generation_aware_rednote_publish_job_recoveries.sql',
  '012_recover_fixed_image_mode_hydration.sql',
  '013_targeted_external_job_dispositions.sql',
  '014_operator_success_attestations.sql',
  '015_manual_scheduling_attestations.sql',
  '016_plan_operator_scheduled_posts.sql',
  '017_manual_first_receipt_lane.sql',
  '018_rednote_publishing_attempts.sql',
  '019_plan_operator_scheduled_stable_link_capture.sql',
  '019_local_publish_job_workspaces.sql',
  '020_ready_x3_authorization.sql',
  '021_local_publish_worker_heartbeats.sql',
  '022_ready_x3_invalid_claim_recovery.sql',
  '023_rednote_worker_result_v2.sql',
  '024_local_publish_queue_quarantine.sql',
  '025_late_rednote_terminal_results.sql',
  '026_batch_authorization_reclassification.sql',
  '027_expired_batch_claim_reclassification.sql',
  '028_legacy_ready_x3_batch_fallback_reclassification.sql',
  '029_terminal_expired_batch_claim_reclassification.sql',
  '030_revision_aware_publish_lifecycle.sql',
] as const;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableDigest(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

describe('canonical local publishing migration chain', () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    for (const file of migrationFiles) {
      const sql = await readFile(path.join(process.cwd(), 'migrations', file), 'utf8');
      await database.exec(sql);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  async function insertExpiredClaimWithFallback(
    lateFallbackPolicy: Record<string, unknown>,
  ) {
    const batchId = randomUUID();
    const itemId = randomUUID();
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const claimToken = randomUUID();
    const pageId = `expired-fallback-${attemptId}`;
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, 'bootstrap', 'approved', $2, CURRENT_TIMESTAMP)`,
      [batchId, 'a'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode
       ) VALUES ($1, $2, $3, '{}'::jsonb, $4, 'claimed', 'scheduled')`,
      [itemId, batchId, pageId, 'b'.repeat(64)],
    );
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id,
         batch_item_id, claim_token, claimed_at, claim_expires_at
       ) VALUES (
         $1, $2, '{}'::jsonb, 'claimed', $3, 'workspace-1', $4, $5,
         CURRENT_TIMESTAMP - INTERVAL '2 minutes', '2026-01-01T00:00:00Z'
       )`,
      [jobId, pageId, randomUUID(), itemId, claimToken],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, receipt_lookup_state, active, approved_at,
         claim_token, claim_expires_at, authorization_kind,
         late_fallback_policy
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         $3, $4, '{}'::jsonb, $5, 'batch-revision',
         'worker', 'playwright', 'worker-test', CURRENT_TIMESTAMP + INTERVAL '1 day',
         CURRENT_TIMESTAMP, 'pending', true, CURRENT_TIMESTAMP,
         $6, '2026-01-01T00:00:00Z', 'ready_x3', $7::jsonb
       )`,
      [
        attemptId,
        randomUUID(),
        pageId,
        jobId,
        'c'.repeat(64),
        claimToken,
        JSON.stringify(lateFallbackPolicy),
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id, event_type, occurred_at, actor_type, actor_id
       ) VALUES ($1, 'worker_claimed', CURRENT_TIMESTAMP, 'worker', 'worker-test')`,
      [attemptId],
    );
    return attemptId;
  }

  async function insertTerminalExpiredBatchClaim(options: {
    fallback?: Record<string, unknown>;
    errorMessage?: string;
    addExecutionEvidence?: boolean;
    receiptLookupUpdatedAt?: string;
    frozenSourcePageId?: string;
    authorizationKind?: 'ready_x3' | null;
  } = {}, target = database) {
    const batchId = randomUUID();
    const itemId = randomUUID();
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const claimToken = randomUUID();
    const pageId = `terminal-expired-${attemptId}`;
    const approval = '2026-09-08T17:08:23.346Z';
    const terminal = '2026-09-08T20:19:53.817Z';
    const fallback = options.fallback ?? {
      action: 'post_now',
      maxLateMinutes: 30,
    };
    const revision = '2026-09-08T16:37:00.000Z';
    const mediaUrl = 'https://images.xhs.justlikekatie.com/day-16.png';
    const mediaIdentity = stableDigest({ type: 'image', url: mediaUrl });
    const snapshot = {
      notionPageId: pageId,
      headline: 'Day 16',
      title: 'Day 16',
      caption: 'Caption',
      tags: ['Tag'],
      platform: 'RedNote',
      mediaType: 'image',
      mediaIndex: 0,
      mediaUrl,
      media: [{ type: 'image', url: mediaUrl, identity: mediaIdentity }],
      publishAt: '2026-09-08T23:20:00.000Z',
      notionLastEditedTime: revision,
      expectedAccountId: '678ba3b5000000000a03ecd2',
    };
    const browserPayload = {
      sourcePostId: pageId,
      expectedAccountId: snapshot.expectedAccountId,
      title: snapshot.title,
      caption: snapshot.caption,
      tags: snapshot.tags,
      scheduledDate: snapshot.publishAt,
      targetPublishAt: snapshot.publishAt,
      timingMode: 'scheduled',
      visibility: 'public',
      publishMode: 'image',
      mediaAssets: [{
        assetId: 'image-0',
        deliveryUrl: mediaUrl,
        sha256: 'a'.repeat(64),
        mediaType: 'image',
        role: 'content',
      }],
    };
    const payloadDigest = stableDigest(browserPayload);
    const frozenPayload = {
      contractRevision: 'rednote-publishing/v1',
      sourceNotionPageId: options.frozenSourcePageId ?? pageId,
      sourceLocalPublishJobId: jobId,
      payloadRevision: revision,
      payloadDigest,
      requestedAt: approval,
      executor: {
        type: 'worker',
        kind: 'playwright',
        id: 'worker-test',
      },
      browserPayload,
    };
    const itemHash = stableDigest(snapshot);
    const manifestHash = storedManifestHash([{
      notionPageId: pageId,
      itemHash,
      dispatchMode: 'scheduled',
      lateBySeconds: 0,
    }]);
    await target.query(
      `INSERT INTO rednote_publish_batches(
         id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, 'bootstrap', 'approved', $2, $3)`,
      [batchId, manifestHash, approval],
    );
    await target.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode
       ) VALUES ($1, $2, $3, $4::jsonb, $5, 'queued', 'scheduled')`,
      [itemId, batchId, pageId, JSON.stringify(snapshot), itemHash],
    );
    await target.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id,
         batch_item_id, claim_attempts, claimed_at, claim_expires_at,
         completed_at, error_code, error_message
       ) VALUES (
         $1, $2, $3::jsonb, 'failed', $4, 'workspace-1', $5, 1,
         '2026-09-08T19:15:12.818Z', $6, $6, 'CLAIM_LEASE_EXPIRED', $7
       )`,
      [
        jobId,
        pageId,
        JSON.stringify(snapshot),
        randomUUID(),
        itemId,
        terminal,
        options.errorMessage ??
          'The publish lease expired without a terminal result. Automatic dispatch is permanently closed; review the frozen attempt before operator handling or reconciliation.',
      ],
    );
    await target.query(
      `UPDATE rednote_publish_batch_items
       SET local_publish_job_id=$1,state='queued'
       WHERE id=$2`,
      [jobId, itemId],
    );
    await target.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, receipt_lookup_state, receipt_lookup_updated_at,
         active, approved_at, terminal_outcome, terminal_at,
         claim_token, claim_expires_at, authorization_kind,
         late_fallback_policy
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         $3, $4, $5::jsonb, $6, $7,
         'worker', 'playwright', 'worker-test', '2026-09-08T23:20:00Z',
         $8, 'not_required', $9, false, $8, 'known_failed', $10,
         $11, $10, $12, $13::jsonb
       )`,
      [
        attemptId,
        randomUUID(),
        pageId,
        jobId,
        JSON.stringify(frozenPayload),
        payloadDigest,
        revision,
        approval,
        options.receiptLookupUpdatedAt ?? terminal,
        terminal,
        claimToken,
        options.authorizationKind === undefined
          ? 'ready_x3'
          : options.authorizationKind,
        JSON.stringify(fallback),
      ],
    );
    await target.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id, event_type, occurred_at, actor_type, actor_id
       ) VALUES
         ($1, 'attempt_created', $2, 'admin', 'batch-approval'),
         ($1, 'worker_claimed', '2026-09-08T19:15:12.818Z', 'worker', 'worker-test'),
         ($1, 'terminal_outcome_recorded', $3, 'admin', 'local_publish_lease_recovery')`,
      [attemptId, approval, terminal],
    );
    if (options.addExecutionEvidence) {
      await target.query(
        `INSERT INTO rednote_publish_attempt_events(
           attempt_id, event_type, occurred_at, actor_type, actor_id
         ) VALUES ($1, 'execution_started', $2, 'worker', 'worker-test')`,
        [attemptId, terminal],
      );
    }
    return {
      attemptId,
      approvedAt: approval,
      batchId,
      itemId,
      jobId,
      pageId,
      itemHash,
      manifestHash,
      revision,
    };
  }

  async function expectTerminalReclassificationRejected(attemptId: string) {
    await database.exec('BEGIN');
    try {
      await database.exec(
        `SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true);
         SELECT set_config(
           'app.terminal_expired_batch_claim_reclassification',
           'on',
           true
         )`,
      );
      await expect(database.query(
        `UPDATE rednote_publish_attempts
         SET authorization_kind=NULL,late_fallback_policy=NULL,
             active=true,terminal_outcome=NULL,terminal_at=NULL,
             receipt_lookup_state='pending',
             receipt_lookup_updated_at=CURRENT_TIMESTAMP,
             claim_token=NULL,claim_expires_at=NULL
         WHERE id=$1`,
        [attemptId],
      )).rejects.toThrow(/Ready x3 authorization is immutable/);
    } finally {
      await database.exec('ROLLBACK');
    }
  }

  it('installs every baseline and RedNote worker table in order', async () => {
    const result = await database.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [[
        'local_publish_jobs',
        'manual_reconciliation_requests',
        'plan_operator_scheduled_posts',
        'rednote_publish_attempts',
        'rednote_publish_attempt_events',
        'rednote_publish_attempt_receipts',
        'rednote_publication_evidence',
        'local_publish_worker_heartbeats',
      ]],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'local_publish_jobs',
      'local_publish_worker_heartbeats',
      'manual_reconciliation_requests',
      'plan_operator_scheduled_posts',
      'rednote_publication_evidence',
      'rednote_publish_attempt_events',
      'rednote_publish_attempt_receipts',
      'rednote_publish_attempts',
    ]);
  });

  it('replaces the legacy receipt primary key with workspace identity', async () => {
    await database.query(
      `INSERT INTO xhs_publish_receipts (
         notion_page_id, workspace_id, status
       ) VALUES
         ('same-page', 'workspace-a', 'publishing'),
         ('same-page', 'workspace-b', 'publishing')`,
    );
    const result = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM xhs_publish_receipts
       WHERE notion_page_id = 'same-page'`,
    );
    expect(result.rows[0]?.count).toBe('2');
  });

  it('installs stable-link capture and immutable Ready x3 authorization', async () => {
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'plan_operator_scheduled_posts'
             AND column_name = 'stable_link_captured_at')
           OR
           (table_name = 'rednote_publish_attempts'
             AND column_name = 'authorization_kind')
         )
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'authorization_kind',
      'stable_link_captured_at',
    ]);
  });

  it('preserves Ready x3 invalid-claim recovery after migration 025', async () => {
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, idempotency_key, contract_revision, source_notion_page_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at,
         terminal_outcome, terminal_at, receipt_lookup_state,
         active, approved_at, authorization_kind, late_fallback_policy
       ) VALUES (
         '11111111-1111-4111-8111-111111111111',
         '22222222-2222-4222-8222-222222222222',
         'rednote-publishing/v1', 'ready-x3-recovery',
         '{}'::jsonb, $1, 'test-revision',
         'worker', 'playwright', 'worker-test',
         CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP,
         'known_failed', CURRENT_TIMESTAMP, 'not_required',
         false, CURRENT_TIMESTAMP, 'ready_x3',
         '{"action":"post_now","maxLateMinutes":30}'::jsonb
       )`,
      ['a'.repeat(64)],
    );
    await database.exec(`
      BEGIN;
      SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true);
      UPDATE rednote_publish_attempts
      SET active = true,
          terminal_outcome = NULL,
          terminal_at = NULL,
          receipt_lookup_state = 'pending',
          receipt_lookup_updated_at = CURRENT_TIMESTAMP,
          claim_token = NULL,
          claim_expires_at = NULL
      WHERE id = '11111111-1111-4111-8111-111111111111';
      COMMIT;
    `);
    await expect(database.query<{
      active: boolean;
      terminal_outcome: string | null;
      receipt_lookup_state: string;
    }>(
      `SELECT active, terminal_outcome, receipt_lookup_state
       FROM rednote_publish_attempts
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    )).resolves.toMatchObject({
      rows: [{
        active: true,
        terminal_outcome: null,
        receipt_lookup_state: 'pending',
      }],
    });
  });

  it('permits only an approved pre-browser batch failure to shed Ready x3 authorization', async () => {
    const batchId = '55555555-5555-4555-8555-555555555555';
    const itemId = '66666666-6666-4666-8666-666666666666';
    const jobId = '77777777-7777-4777-8777-777777777777';
    const attemptId = '88888888-8888-4888-8888-888888888888';
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, 'bootstrap', 'approved', $2, CURRENT_TIMESTAMP)`,
      [batchId, 'b'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode
       ) VALUES ($1, $2, 'batch-recovery-page', '{}'::jsonb, $3, 'approved', 'scheduled')`,
      [itemId, batchId, 'c'.repeat(64)],
    );
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id,
         batch_item_id, error_code, error_message
       ) VALUES (
         $1, 'batch-recovery-page', '{}'::jsonb, 'failed', $2,
         'workspace-1', $3, 'INVALID_CLAIM',
         'readyX3Authorization: must exactly match the frozen packet revision, schedule, and media fields'
       )`,
      [
        jobId,
        '99999999-9999-4999-8999-999999999999',
        itemId,
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, terminal_outcome, terminal_at, receipt_lookup_state,
         active, approved_at, authorization_kind, late_fallback_policy
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         'batch-recovery-page', $3, '{}'::jsonb, $4, 'batch-revision',
         'worker', 'playwright', 'worker-test', CURRENT_TIMESTAMP + INTERVAL '1 day',
         CURRENT_TIMESTAMP, 'known_failed', CURRENT_TIMESTAMP, 'not_required',
         false, CURRENT_TIMESTAMP, 'ready_x3',
         '{"action":"post_now","maxLateMinutes":30}'::jsonb
       )`,
      [
        attemptId,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        jobId,
        'd'.repeat(64),
      ],
    );

    await database.exec(`
      BEGIN;
      SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true);
      SELECT set_config('app.batch_authorization_reclassification', 'on', true);
      UPDATE rednote_publish_attempts
      SET authorization_kind = NULL,
          late_fallback_policy = NULL,
          active = true,
          terminal_outcome = NULL,
          terminal_at = NULL,
          receipt_lookup_state = 'pending',
          receipt_lookup_updated_at = CURRENT_TIMESTAMP,
          claim_token = NULL,
          claim_expires_at = NULL
      WHERE id = '${attemptId}';
      COMMIT;
    `);

    await expect(database.query<{
      active: boolean;
      authorization_kind: string | null;
      terminal_outcome: string | null;
    }>(
      `SELECT active, authorization_kind, terminal_outcome
       FROM rednote_publish_attempts
       WHERE id = $1`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{
        active: true,
        authorization_kind: null,
        terminal_outcome: null,
      }],
    });
  });

  it('reclassifies only an expired unexecuted batch claim and preserves its approval', async () => {
    const batchId = '11111111-aaaa-4111-8111-111111111111';
    const itemId = '22222222-aaaa-4222-8222-222222222222';
    const jobId = '33333333-aaaa-4333-8333-333333333333';
    const attemptId = '44444444-aaaa-4444-8444-444444444444';
    const claimToken = '55555555-aaaa-4555-8555-555555555555';
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, 'bootstrap', 'approved', $2, CURRENT_TIMESTAMP)`,
      [batchId, 'e'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode
       ) VALUES (
         $1, $2, 'expired-claim-page',
         '{"notionPageId":"expired-claim-page","notionLastEditedTime":"batch-revision","publishAt":"2026-09-08T23:20:00.000Z"}'::jsonb,
         $3, 'approved', 'scheduled'
       )`,
      [itemId, batchId, 'f'.repeat(64)],
    );
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id,
         batch_item_id, claim_token, claimed_at, claim_expires_at
       ) VALUES (
       $1, 'expired-claim-page',
       '{"notionPageId":"expired-claim-page","notionLastEditedTime":"batch-revision","publishAt":"2026-09-08T23:20:00.000Z"}'::jsonb,
       'claimed', $2,
         'workspace-1', $3, $4, CURRENT_TIMESTAMP - INTERVAL '2 minutes',
         '2026-01-01T00:00:00Z'
       )`,
      [
        jobId,
        '66666666-aaaa-4666-8666-666666666666',
        itemId,
        claimToken,
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, receipt_lookup_state, active, approved_at,
         claim_token, claim_expires_at, authorization_kind,
         late_fallback_policy
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         'expired-claim-page', $3,
         '{"payloadRevision":"batch-revision","browserPayload":{"sourcePostId":"expired-claim-page","timingMode":"scheduled","scheduledDate":"2026-09-08T23:20:00.000Z","targetPublishAt":"2026-09-08T23:20:00.000Z"}}'::jsonb,
         $4, 'batch-revision',
         'worker', 'playwright', 'worker-test', '2026-09-08T23:20:00.000Z',
         CURRENT_TIMESTAMP, 'pending', true, '2026-08-31T14:00:00Z',
         $5, '2026-01-01T00:00:00Z', 'ready_x3',
         '{"action":"post_now","maxLateMinutes":30}'::jsonb
       )`,
      [
        attemptId,
        '77777777-aaaa-4777-8777-777777777777',
        jobId,
        '1'.repeat(64),
        claimToken,
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id, event_type, occurred_at, actor_type, actor_id
       ) VALUES ($1, 'worker_claimed', CURRENT_TIMESTAMP, 'worker', 'worker-test')`,
      [attemptId],
    );

    await expect(database.query(
      `SELECT
         attempt.late_fallback_policy =
           '{"action":"post_now","maxLateMinutes":30}'::jsonb AS fallback_matches,
         item.state AS item_state,
         item.dispatch_mode,
         item.local_publish_job_id = job.id AS item_job_matches,
         job.status AS job_status,
         job.claim_expires_at <= CURRENT_TIMESTAMP AS job_lease_expired,
         attempt.claim_expires_at <= CURRENT_TIMESTAMP AS attempt_lease_expired
       FROM rednote_publish_attempts attempt
       JOIN local_publish_jobs job ON job.id = attempt.source_local_publish_job_id
       JOIN rednote_publish_batch_items item ON item.id = job.batch_item_id
       WHERE attempt.id = $1`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{
        fallback_matches: true,
        item_state: 'claimed',
        dispatch_mode: 'scheduled',
        item_job_matches: true,
        job_status: 'claimed',
        job_lease_expired: true,
        attempt_lease_expired: true,
      }],
    });

    await database.exec(`
      BEGIN;
      SELECT set_config('app.expired_batch_claim_reclassification', 'on', true);
      UPDATE rednote_publish_attempts
      SET authorization_kind = NULL,
          late_fallback_policy = NULL,
          claim_token = NULL,
          claim_expires_at = NULL
      WHERE id = '${attemptId}';
      UPDATE local_publish_jobs
      SET status = 'queued',
          claim_token = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL
      WHERE id = '${jobId}';
      COMMIT;
    `);

    await expect(database.query<{
      active: boolean;
      approved_at: string;
      authorization_kind: string | null;
      terminal_outcome: string | null;
      claim_token: string | null;
    }>(
      `SELECT active, approved_at::text, authorization_kind,
          terminal_outcome, claim_token
       FROM rednote_publish_attempts
       WHERE id = $1`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{
        active: true,
        approved_at: '2026-08-31 14:00:00+00',
        authorization_kind: null,
        terminal_outcome: null,
        claim_token: null,
      }],
    });
    await expect(database.query<{ status: string }>(
      'SELECT status FROM local_publish_jobs WHERE id = $1',
      [jobId],
    )).resolves.toMatchObject({ rows: [{ status: 'queued' }] });
  });

  it('rejects expired-claim reclassification with a changed legacy fallback action', async () => {
    const attemptId = await insertExpiredClaimWithFallback({
      action: 'schedule',
      maxLateMinutes: 30,
    });
    await database.exec('BEGIN');
    try {
      await database.exec(
        `SELECT set_config('app.expired_batch_claim_reclassification', 'on', true)`,
      );
      await expect(database.query(
        `UPDATE rednote_publish_attempts
         SET authorization_kind = NULL,
             late_fallback_policy = NULL,
             claim_token = NULL,
             claim_expires_at = NULL
         WHERE id = $1`,
        [attemptId],
      )).rejects.toThrow(/Ready x3 authorization is immutable/);
    } finally {
      await database.exec('ROLLBACK');
    }
  });

  it.each([
    ['changed timeout', { action: 'post_now', maxLateMinutes: 31 }],
    ['extra field', { action: 'post_now', maxLateMinutes: 30, revision: 'unexpected' }],
  ])('rejects inserting a legacy fallback with a %s', async (_, lateFallbackPolicy) => {
    await expect(insertExpiredClaimWithFallback(lateFallbackPolicy))
      .rejects.toThrow(/rednote_publish_attempts_late_fallback_policy_check/);
  });

  it('rejects expired-claim reclassification while the lease is still live', async () => {
    const batchId = '88888888-aaaa-4888-8888-888888888888';
    const itemId = '99999999-aaaa-4999-8999-999999999999';
    const jobId = 'aaaaaaaa-bbbb-4aaa-8aaa-aaaaaaaaaaaa';
    const attemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const claimToken = 'cccccccc-bbbb-4ccc-8ccc-cccccccccccc';
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, 'bootstrap', 'approved', $2, CURRENT_TIMESTAMP)`,
      [batchId, '2'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode
       ) VALUES ($1, $2, 'live-claim-page', '{}'::jsonb, $3, 'approved', 'scheduled')`,
      [itemId, batchId, '3'.repeat(64)],
    );
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id,
         batch_item_id, claim_token, claimed_at, claim_expires_at
       ) VALUES (
         $1, 'live-claim-page', '{}'::jsonb, 'claimed', $2,
         'workspace-1', $3, $4, CURRENT_TIMESTAMP,
         '2099-01-01T00:00:00Z'
       )`,
      [jobId, 'dddddddd-bbbb-4ddd-8ddd-dddddddddddd', itemId, claimToken],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, receipt_lookup_state, active, approved_at,
         claim_token, claim_expires_at, authorization_kind,
         late_fallback_policy
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         'live-claim-page', $3, '{}'::jsonb, $4, 'batch-revision',
         'worker', 'playwright', 'worker-test', CURRENT_TIMESTAMP + INTERVAL '1 day',
         CURRENT_TIMESTAMP, 'pending', true, CURRENT_TIMESTAMP,
         $5, '2099-01-01T00:00:00Z', 'ready_x3',
         '{"action":"post_now","maxLateMinutes":30}'::jsonb
       )`,
      [
        attemptId,
        'eeeeeeee-bbbb-4eee-8eee-eeeeeeeeeeee',
        jobId,
        '4'.repeat(64),
        claimToken,
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id, event_type, occurred_at, actor_type, actor_id
       ) VALUES ($1, 'worker_claimed', CURRENT_TIMESTAMP, 'worker', 'worker-test')`,
      [attemptId],
    );

    await database.exec('BEGIN');
    try {
      await database.exec(
        `SELECT set_config('app.expired_batch_claim_reclassification', 'on', true)`,
      );
      await expect(database.query(
        `UPDATE rednote_publish_attempts
         SET authorization_kind = NULL,
             late_fallback_policy = NULL,
             claim_token = NULL,
             claim_expires_at = NULL
         WHERE id = $1`,
        [attemptId],
      )).rejects.toThrow(/Ready x3 authorization is immutable/);
    } finally {
      await database.exec('ROLLBACK');
    }
  });

  it('permits only the exact terminal lease-expiry reclassification transition', async () => {
    const { attemptId, approvedAt } = await insertTerminalExpiredBatchClaim();
    await database.exec('BEGIN');
    try {
      await database.exec(
        `SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true);
         SELECT set_config(
           'app.terminal_expired_batch_claim_reclassification',
           'on',
           true
         )`,
      );
      await expect(database.query(
        `UPDATE rednote_publish_attempts
         SET authorization_kind=NULL,late_fallback_policy=NULL,
             active=true,terminal_outcome=NULL,terminal_at=NULL,
             receipt_lookup_state='pending',
             receipt_lookup_updated_at=CURRENT_TIMESTAMP,
             claim_token=NULL,claim_expires_at=NULL
         WHERE id=$1`,
        [attemptId],
      )).resolves.toBeDefined();
      const result = await database.query<{
        active: boolean;
        approved_at: string;
        authorization_kind: string | null;
        terminal_outcome: string | null;
        claim_token: string | null;
      }>(
        `SELECT active,approved_at::text,authorization_kind,
            terminal_outcome,claim_token
         FROM rednote_publish_attempts
         WHERE id=$1`,
        [attemptId],
      );
      expect(result.rows[0]).toMatchObject({
        active: true,
        approved_at: '2026-09-08 17:08:23.346+00',
        authorization_kind: null,
        terminal_outcome: null,
        claim_token: null,
      });
      expect(new Date(result.rows[0]?.approved_at ?? '').toISOString())
        .toBe(new Date(approvedAt).toISOString());
    } finally {
      await database.exec('ROLLBACK');
    }
  });

  it('rejects terminal lease-expiry reset without authorization reclassification', async () => {
    const { attemptId } = await insertTerminalExpiredBatchClaim();
    await database.exec('BEGIN');
    try {
      await database.exec(
        `SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true)`,
      );
      await expect(database.query(
        `UPDATE rednote_publish_attempts
         SET active=true,terminal_outcome=NULL,terminal_at=NULL,
             receipt_lookup_state='pending',
             receipt_lookup_updated_at=CURRENT_TIMESTAMP,
             claim_token=NULL,claim_expires_at=NULL
         WHERE id=$1`,
        [attemptId],
      )).rejects.toThrow(
        /terminal expired batch claim reset requires exact authorization reclassification/,
      );
    } finally {
      await database.exec('ROLLBACK');
    }
  });

  it('fails closed on a fresh connection when recovery settings are unset', async () => {
    const freshDatabase = new PGlite();
    try {
      for (const file of migrationFiles) {
        const sql = await readFile(path.join(process.cwd(), 'migrations', file), 'utf8');
        await freshDatabase.exec(sql);
      }
      const settings = await freshDatabase.query<{
        batch_setting: string | null;
        expired_setting: string | null;
        terminal_setting: string | null;
      }>(
        `SELECT
           current_setting(
             'app.batch_authorization_reclassification',
             true
           ) AS batch_setting,
           current_setting(
             'app.expired_batch_claim_reclassification',
             true
           ) AS expired_setting,
           current_setting(
             'app.terminal_expired_batch_claim_reclassification',
             true
           ) AS terminal_setting`,
      );
      expect(settings.rows[0]).toEqual({
        batch_setting: null,
        expired_setting: null,
        terminal_setting: null,
      });

      const exactRecovery = await insertTerminalExpiredBatchClaim(
        {},
        freshDatabase,
      );
      await expect(freshDatabase.query(
        `UPDATE rednote_publish_attempts
         SET authorization_kind=NULL,late_fallback_policy=NULL,
             active=true,terminal_outcome=NULL,terminal_at=NULL,
             receipt_lookup_state='pending',
             receipt_lookup_updated_at=CURRENT_TIMESTAMP,
             claim_token=NULL,claim_expires_at=NULL
         WHERE id=$1`,
        [exactRecovery.attemptId],
      )).rejects.toThrow(/Ready x3 authorization is immutable/);

      const terminalReset = await insertTerminalExpiredBatchClaim(
        {},
        freshDatabase,
      );
      await expect(freshDatabase.query(
        `UPDATE rednote_publish_attempts
         SET active=true,terminal_outcome=NULL,terminal_at=NULL,
             receipt_lookup_state='pending',
             receipt_lookup_updated_at=CURRENT_TIMESTAMP,
             claim_token=NULL,claim_expires_at=NULL
         WHERE id=$1`,
        [terminalReset.attemptId],
      )).rejects.toThrow(
        /terminal expired batch claim reset requires exact authorization reclassification/,
      );
    } finally {
      await freshDatabase.close();
    }
  });

  it('fails closed when the terminal setting is enabled but authorization is null', async () => {
    const { attemptId } = await insertTerminalExpiredBatchClaim({
      authorizationKind: null,
    });
    await database.exec('BEGIN');
    try {
      await database.exec(
        `SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true);
         SELECT set_config(
           'app.terminal_expired_batch_claim_reclassification',
           'on',
           true
         )`,
      );
      await expect(database.query(
        `UPDATE rednote_publish_attempts
         SET active=true,terminal_outcome=NULL,terminal_at=NULL,
             receipt_lookup_state='pending',
             receipt_lookup_updated_at=CURRENT_TIMESTAMP,
             claim_token=NULL,claim_expires_at=NULL
         WHERE id=$1`,
        [attemptId],
      )).rejects.toThrow(
        /terminal expired batch claim reset requires exact authorization reclassification/,
      );
    } finally {
      await database.exec('ROLLBACK');
    }
  });

  it.each([
    ['altered fallback', { fallback: { action: 'schedule', maxLateMinutes: 30 } }],
    ['altered lease error', { errorMessage: 'Different lease failure' }],
    ['execution evidence', { addExecutionEvidence: true }],
    ['altered receipt timestamp', {
      receiptLookupUpdatedAt: '2026-09-08T20:19:52.817Z',
    }],
    ['altered frozen source page', { frozenSourcePageId: 'other-page' }],
  ])('rejects terminal lease-expiry reclassification with %s', async (_, options) => {
    const { attemptId } = await insertTerminalExpiredBatchClaim(options);
    await expectTerminalReclassificationRejected(attemptId);
  });

  it.each([
    [
      'job page mismatch',
      async (fixture: Awaited<ReturnType<typeof insertTerminalExpiredBatchClaim>>) => {
        await database.query(
          `UPDATE local_publish_jobs SET notion_page_id='other-page' WHERE id=$1`,
          [fixture.jobId],
        );
      },
    ],
    [
      'snapshot revision mismatch',
      async (fixture: Awaited<ReturnType<typeof insertTerminalExpiredBatchClaim>>) => {
        await database.query(
          `UPDATE rednote_publish_batch_items
           SET snapshot=jsonb_set(snapshot, '{notionLastEditedTime}', '"other-revision"')
           WHERE id=$1`,
          [fixture.itemId],
        );
        await database.query(
          `UPDATE local_publish_jobs
           SET snapshot=jsonb_set(snapshot, '{notionLastEditedTime}', '"other-revision"')
           WHERE id=$1`,
          [fixture.jobId],
        );
      },
    ],
    [
      'item digest mismatch',
      async (fixture: Awaited<ReturnType<typeof insertTerminalExpiredBatchClaim>>) => {
        await database.query(
          `UPDATE rednote_publish_batch_items SET item_hash=$2 WHERE id=$1`,
          [fixture.itemId, 'd'.repeat(64)],
        );
      },
    ],
    [
      'manifest digest mismatch',
      async (fixture: Awaited<ReturnType<typeof insertTerminalExpiredBatchClaim>>) => {
        await database.query(
          `UPDATE rednote_publish_batches SET manifest_hash=$2 WHERE id=$1`,
          [fixture.batchId, 'e'.repeat(64)],
        );
      },
    ],
    [
      'success attestation',
      async (fixture: Awaited<ReturnType<typeof insertTerminalExpiredBatchClaim>>) => {
        await database.query(
          `INSERT INTO local_publish_job_success_attestations(
             idempotency_key,local_publish_job_id,notion_page_id,batch_id,
             batch_item_id,manifest_hash,item_hash,snapshot_revision,
             snapshot_digest,contract_revision,prior_claim_token_digest,
             expected_outcome,requested_publish_at,prior_job_status,
             prior_claim_attempts,prior_completed_at,attested_by
           ) VALUES(
             $1,$2,$3,$4,$5,$6,$7,$8,$7,
             'operator-success-attestation/v1',$9,'success',
             '2026-09-08T23:20:00Z','failed',1,
             '2026-09-08T20:19:53.817Z','operator@example.com'
           )`,
          [
            randomUUID(),
            fixture.jobId,
            fixture.pageId,
            fixture.batchId,
            fixture.itemId,
            fixture.manifestHash,
            fixture.itemHash,
            fixture.revision,
            'f'.repeat(64),
          ],
        );
      },
    ],
    [
      'prior recovery',
      async (fixture: Awaited<ReturnType<typeof insertTerminalExpiredBatchClaim>>) => {
        await database.query(
          `INSERT INTO rednote_publish_job_recoveries(
             local_publish_job_id,batch_item_id,batch_id,manifest_hash,item_hash,
             snapshot_revision,prior_error_code,prior_claim_attempts,
             prior_completed_at,recovered_by
           ) VALUES(
             $1,$2,$3,$4,$5,$6,'BOUNDED_BATCH_BYPASS_DISABLED',1,
             '2026-09-08T20:19:53.817Z','operator@example.com'
           )`,
          [
            fixture.jobId,
            fixture.itemId,
            fixture.batchId,
            fixture.manifestHash,
            fixture.itemHash,
            fixture.revision,
          ],
        );
      },
    ],
    [
      'queue quarantine',
      async (fixture: Awaited<ReturnType<typeof insertTerminalExpiredBatchClaim>>) => {
        const quarantineId = randomUUID();
        await database.query(
          `INSERT INTO local_publish_queue_quarantines(
             id,idempotency_key,cutoff_at,job_count,active_claim_count,
             dispatch_evidence_count,prior_status_counts
           ) VALUES($1,$2,CURRENT_TIMESTAMP,1,0,0,'{"failed":1}'::jsonb)`,
          [quarantineId, randomUUID()],
        );
        await database.query(
          `INSERT INTO local_publish_queue_quarantine_items(
             quarantine_id,local_publish_job_id,workspace_id,prior_status,
             had_dispatch_evidence
           ) VALUES($1,$2,'workspace-1','failed',false)`,
          [quarantineId, fixture.jobId],
        );
      },
    ],
    [
      'duplicate linked attempt',
      async (fixture: Awaited<ReturnType<typeof insertTerminalExpiredBatchClaim>>) => {
        await database.query(
          `INSERT INTO rednote_publish_attempts(
             id,workspace_id,idempotency_key,contract_revision,
             source_notion_page_id,source_local_publish_job_id,frozen_payload,
             payload_digest,payload_revision,executor_type,executor_kind,
             executor_id,target_publish_at,requested_at,receipt_lookup_state,
             active
           )
           SELECT $2,workspace_id,$3,contract_revision,source_notion_page_id,
             source_local_publish_job_id,frozen_payload,payload_digest,
             payload_revision,executor_type,executor_kind,executor_id,
             target_publish_at,requested_at,'pending',false
           FROM rednote_publish_attempts WHERE id=$1`,
          [fixture.attemptId, randomUUID(), randomUUID()],
        );
      },
    ],
  ])('rejects terminal reclassification with persisted %s', async (_, alter) => {
    const fixture = await insertTerminalExpiredBatchClaim();
    await alter(fixture);
    await expectTerminalReclassificationRejected(fixture.attemptId);
  });

  it('supports Note ID-only receipts and append-only renewable evidence', async () => {
    const columns = await database.query<{ is_nullable: string }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'rednote_publish_attempt_receipts'
         AND column_name = 'rednote_url'`,
    );
    expect(columns.rows[0]?.is_nullable).toBe('YES');

    const jobId = '11111111-1111-4111-8111-111111111111';
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id
       ) VALUES ($1, 'notion-page-1', $2::jsonb, 'verified', $3, 'workspace-1')`,
      [
        jobId,
        JSON.stringify({ expectedAccountId: 'creator-account-1' }),
        '22222222-2222-4222-8222-222222222222',
      ],
    );
    const evidence = await database.query<{ id: string }>(
      `INSERT INTO rednote_publication_evidence(
         workspace_id, local_publish_job_id, note_id, evidence_kind,
         captured_at, evidence_status
       ) VALUES (
         'workspace-1', $1, 'note_123', 'xsec_access',
         '2026-08-02T12:00:00Z', 'accessible'
       ) RETURNING id`,
      [jobId],
    );
    await expect(database.query(
      `UPDATE rednote_publication_evidence
       SET captured_at = '2026-08-03T12:00:00Z'
       WHERE id = $1`,
      [evidence.rows[0]?.id],
    )).rejects.toThrow(/append-only/);
    await expect(database.query(
      `INSERT INTO rednote_publication_evidence(
         workspace_id, local_publish_job_id, note_id, evidence_kind,
         captured_at, evidence_status, public_url
       ) VALUES (
         'workspace-1', $1, 'note_123', 'public_index',
         '2026-08-03T12:00:00Z', 'pending',
         'https://www.rednote.com/explore/note_123'
       )`,
      [jobId],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO rednote_publication_evidence(
         workspace_id, local_publish_job_id, note_id, evidence_kind,
         captured_at, account_id, evidence_status
       ) VALUES (
         'workspace-1', $1, NULL, 'authenticated_account',
         '2026-08-02T12:05:00Z', 'creator-account-1', 'owned'
       )`,
      [jobId],
    )).resolves.toMatchObject({ affectedRows: 1 });
    await expect(database.query(
      `INSERT INTO rednote_publication_evidence(
         workspace_id, local_publish_job_id, note_id, evidence_kind,
         captured_at, evidence_status
       ) VALUES (
         'workspace-1', $1, NULL, 'xsec_access',
         '2026-08-02T12:06:00Z', 'accessible'
       )`,
      [jobId],
    )).rejects.toThrow();

    const attemptId = '33333333-3333-4333-8333-333333333333';
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, requested_at,
         terminal_outcome, terminal_at, receipt_lookup_state, active
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         'notion-page-1', $3, '{}'::jsonb, $4, 'revision-1',
         'worker', 'playwright', 'worker-1', '2026-08-02T11:00:00Z',
         'outcome_unknown', '2026-08-02T12:00:00Z', 'found', false
       )`,
      [
        attemptId,
        '44444444-4444-4444-8444-444444444444',
        jobId,
        'a'.repeat(64),
      ],
    );
    await expect(database.query(
      `INSERT INTO rednote_publish_attempt_receipts(
         attempt_id, rednote_note_id, platform_publish_time, provenance
       ) VALUES (
         $1, 'note_ambiguous', '2026-08-02T12:00:00Z',
         '{"kind":"rednote_worker_result_v2"}'::jsonb
       )`,
      [attemptId],
    )).resolves.toBeDefined();
  });

  it('allows the exact revised Day 16 page only while the old failure is evidence-free', async () => {
    const pageId = '432411de-071a-498e-9833-ff7b6c238374';
    const jobId = 'a6cdfa8a-e840-4e48-9776-044a8cd2b093';
    const attemptId = 'b6cdfa8a-e840-4e48-9776-044a8cd2b093';
    const oldBatchId = 'c6cdfa8a-e840-4e48-9776-044a8cd2b093';
    const oldItemId = 'd6cdfa8a-e840-4e48-9776-044a8cd2b093';
    const newBatchId = 'e6cdfa8a-e840-4e48-9776-044a8cd2b093';
    const newItemId = 'f6cdfa8a-e840-4e48-9776-044a8cd2b093';
    const oldRevision = '2026-09-08T16:37:00.000Z';
    const newRevision = '2026-09-08T23:36:51.638Z';
    const frozenSnapshot = {
      notionPageId: pageId,
      notionLastEditedTime: oldRevision,
      publishAt: '2026-09-08T23:20:00.000Z',
      mediaUrl: 'https://images.xhs.justlikekatie.com/videos/day-16.mp4',
      thumbnailUrl: 'https://images.xhs.justlikekatie.com/thumbnails/day-16.jpg',
    };

    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, workspace_id, kind, status, manifest_hash, approved_at
       ) VALUES (
         $1, 'workspace-day-16', 'bootstrap', 'approved', $2,
         '2026-09-08T23:18:00.000Z'
       )`,
      [oldBatchId, 'a'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, workspace_id, notion_page_id, snapshot, item_hash,
         state, dispatch_mode
       ) VALUES (
         $1, $2, 'workspace-day-16', $3, $4::jsonb, $5,
         'queued', 'scheduled'
       )`,
      [oldItemId, oldBatchId, pageId, JSON.stringify(frozenSnapshot), 'b'.repeat(64)],
    );
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, workspace_id, notion_page_id, snapshot, status, idempotency_key,
         error_code, error_message, completed_at
       ) VALUES (
         $1, 'workspace-day-16', $2, $3::jsonb, 'failed', $4,
         'CLAIM_LEASE_EXPIRED', 'Claim lease expired before execution',
         '2026-09-08T23:25:00.000Z'
       )`,
      [jobId, pageId, JSON.stringify(frozenSnapshot), randomUUID()],
    );
    await database.query(
      `UPDATE rednote_publish_batch_items
       SET local_publish_job_id = $1
       WHERE id = $2`,
      [jobId, oldItemId],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, terminal_outcome, terminal_at,
         receipt_lookup_state, active
       ) VALUES (
         $1, 'workspace-day-16', $2, 'rednote-publishing/v1',
         $3, $4, $5::jsonb, $6, $7,
         'worker', 'playwright', 'worker-day-16',
         '2026-09-08T23:20:00.000Z', '2026-09-08T23:19:00.000Z',
         'known_failed', '2026-09-08T23:25:00.000Z',
         'not_required', false
       )`,
      [
        attemptId,
        randomUUID(),
        pageId,
        jobId,
        JSON.stringify(frozenSnapshot),
        'd'.repeat(64),
        oldRevision,
      ],
    );

    const revised = await database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-day-16', pageId, newRevision],
    );
    expect(revised.rows).toEqual([]);

    const sameRevision = await database.query<{
      lifecycle_id: string;
      lifecycle_state: string;
    }>(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-day-16', pageId, oldRevision],
    );
    expect(sameRevision.rows).toEqual(expect.arrayContaining([
      {
        notion_page_id: pageId,
        lifecycle_id: jobId,
        lifecycle_state: 'local_job:failed',
      },
      {
        notion_page_id: pageId,
        lifecycle_id: oldItemId,
        lifecycle_state: 'batch_item:queued',
      },
    ]));
    expect(sameRevision.rows).toHaveLength(2);

    const olderRevision = await database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-day-16', pageId, '2026-09-08T15:00:00.000Z'],
    );
    expect(olderRevision.rows).toEqual(expect.arrayContaining([
      {
        notion_page_id: pageId,
        lifecycle_id: jobId,
        lifecycle_state: 'local_job:failed',
      },
      {
        notion_page_id: pageId,
        lifecycle_id: oldItemId,
        lifecycle_state: 'batch_item:queued',
      },
    ]));
    expect(olderRevision.rows).toHaveLength(2);

    const otherWorkspace = await database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['other-workspace', pageId, newRevision],
    );
    expect(otherWorkspace.rows).toEqual([]);

    const revisedSnapshot = {
      ...frozenSnapshot,
      notionLastEditedTime: newRevision,
      publishAt: '2026-09-11T23:20:00.000Z',
    };
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, workspace_id, kind, status, manifest_hash
       ) VALUES (
         $1, 'workspace-day-16', 'bootstrap', 'pending_approval', $2
       )`,
      [newBatchId, 'c'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, workspace_id, notion_page_id, snapshot, item_hash,
         state, dispatch_mode
       ) VALUES (
         $1, $2, 'workspace-day-16', $3, $4::jsonb, $5,
         'needs_approval', 'scheduled'
       )`,
      [newItemId, newBatchId, pageId, JSON.stringify(revisedSnapshot), 'd'.repeat(64)],
    );
    const historicalItems = await database.query<{
      id: string;
      state: string;
      revision: string;
      local_publish_job_id: string | null;
    }>(
      `SELECT
         id,
         state,
         snapshot->>'notionLastEditedTime' AS revision,
         local_publish_job_id
       FROM rednote_publish_batch_items
       WHERE workspace_id = 'workspace-day-16'
         AND notion_page_id = $1
       ORDER BY revision`,
      [pageId],
    );
    expect(historicalItems.rows).toEqual([
      {
        id: oldItemId,
        state: 'queued',
        revision: oldRevision,
        local_publish_job_id: jobId,
      },
      {
        id: newItemId,
        state: 'needs_approval',
        revision: newRevision,
        local_publish_job_id: null,
      },
    ]);

    const attestationId = randomUUID();
    await database.query(
      `INSERT INTO local_publish_job_success_attestations(
         id, idempotency_key, local_publish_job_id, notion_page_id,
         batch_id, batch_item_id, manifest_hash, item_hash,
         snapshot_revision, snapshot_digest, contract_revision,
         prior_claim_token_digest, expected_outcome, requested_publish_at,
         prior_job_status, prior_claim_attempts, attested_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $8,
         'operator-success-attestation/v1', $10, 'scheduled',
         '2026-09-08T23:20:00.000Z', 'failed', 0, 'operator@example.com'
       )`,
      [
        attestationId,
        randomUUID(),
        jobId,
        pageId,
        oldBatchId,
        oldItemId,
        'a'.repeat(64),
        'b'.repeat(64),
        oldRevision,
        'e'.repeat(64),
      ],
    );
    const appendOnlyAttestationBlocks = await database.query<{ allowed: boolean }>(
      `SELECT rednote_publish_local_job_allows_newer_revision(
         $1, $2, $3, $4
       ) AS allowed`,
      ['workspace-day-16', pageId, jobId, newRevision],
    );
    expect(appendOnlyAttestationBlocks.rows).toEqual([{ allowed: false }]);
    await database.query(
      `INSERT INTO local_publish_job_success_attestation_release_acks(
         success_attestation_id, acknowledgement_claim_token_digest
       ) VALUES ($1, $2)`,
      [attestationId, 'f'.repeat(64)],
    );
    const releaseAckStillBlocks = await database.query<{ allowed: boolean }>(
      `SELECT rednote_publish_local_job_allows_newer_revision(
         $1, $2, $3, $4
       ) AS allowed`,
      ['workspace-day-16', pageId, jobId, newRevision],
    );
    expect(releaseAckStillBlocks.rows).toEqual([{ allowed: false }]);

    await database.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id, event_type, occurred_at, actor_type, actor_id
       ) VALUES (
         $1, 'execution_started', '2026-09-08T23:19:30.000Z',
         'worker', 'worker-day-16'
       )`,
      [attemptId],
    );
    const withExecutionEvidence = await database.query<{
      lifecycle_id: string;
      lifecycle_state: string;
    }>(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-day-16', pageId, newRevision],
    );
    expect(withExecutionEvidence.rows).toEqual(expect.arrayContaining([{
      notion_page_id: pageId,
      lifecycle_id: jobId,
      lifecycle_state: 'local_job:failed',
    }]));
  });

  it('blocks a newer revision while an older active batch item has no proven lifecycle', async () => {
    const pageId = 'unlinked-active-batch-item';
    const batchId = randomUUID();
    const itemId = randomUUID();
    const oldRevision = '2026-09-08T16:37:00.000Z';
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, workspace_id, kind, status, manifest_hash, approved_at
       ) VALUES (
         $1, 'workspace-unlinked-item', 'bootstrap', 'approved', $2,
         '2026-09-08T23:18:00.000Z'
       )`,
      [batchId, '7'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, workspace_id, notion_page_id, snapshot, item_hash,
         state, dispatch_mode
       ) VALUES (
         $1, $2, 'workspace-unlinked-item', $3,
         jsonb_build_object('notionLastEditedTime', $4::text), $5,
         'queued', 'scheduled'
       )`,
      [itemId, batchId, pageId, oldRevision, '8'.repeat(64)],
    );

    const blockers = await database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-unlinked-item', pageId, '2026-09-08T23:36:51.638Z'],
    );
    expect(blockers.rows).toEqual([{
      notion_page_id: pageId,
      lifecycle_id: itemId,
      lifecycle_state: 'batch_item:queued',
    }]);
  });

  it('blocks a failed local job that has no terminal attempt provenance', async () => {
    const pageId = 'failed-job-without-attempt';
    const jobId = randomUUID();
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, workspace_id, notion_page_id, snapshot, status, idempotency_key,
         error_code, error_message, completed_at
       ) VALUES (
         $1, 'workspace-no-attempt', $2,
         jsonb_build_object(
           'notionLastEditedTime', '2026-09-08T16:37:00.000Z'
         ),
         'failed', $3, 'CLAIM_LEASE_EXPIRED',
         'Claim lease expired before an attempt was recorded',
         '2026-09-08T23:25:00.000Z'
       )`,
      [jobId, pageId, randomUUID()],
    );

    const blockers = await database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-no-attempt', pageId, '2026-09-08T23:36:51.638Z'],
    );
    expect(blockers.rows).toEqual([{
      notion_page_id: pageId,
      lifecycle_id: jobId,
      lifecycle_state: 'local_job:failed',
    }]);
  });

  it('keeps page-wide receipt and reconciliation evidence as permanent barriers', async () => {
    const revision = '2026-09-08T23:36:51.638Z';
    const receiptPageId = 'page-wide-receipt-evidence';
    const reconciliationPageId = 'page-wide-reconciliation-evidence';
    const scheduledPageId = 'page-wide-operator-scheduled-evidence';

    await database.query(
      `INSERT INTO xhs_publish_receipts(
         workspace_id, notion_page_id, status, note_id, share_url
       ) VALUES (
         'workspace-page-wide-evidence', $1, 'published',
         'note_receipt_evidence',
         'https://www.xiaohongshu.com/explore/note_receipt_evidence'
       )`,
      [receiptPageId],
    );
    await database.query(
      `INSERT INTO external_post_reconciliations(
         workspace_id, note_id, share_url, snapshot, status,
         idempotency_key, notion_page_id
       ) VALUES (
         'workspace-page-wide-evidence', 'note_page_wide',
         'https://www.xiaohongshu.com/explore/note_page_wide',
         '{}'::jsonb, 'failed', $1, $2
       )`,
      [randomUUID(), reconciliationPageId],
    );
    await database.query(
      `INSERT INTO plan_operator_scheduled_posts(
         workspace_id, notion_page_id, idempotency_key,
         notion_last_edited_time, scheduled_at
       ) VALUES (
         'workspace-page-wide-evidence', $1, $2, $3,
         '2026-09-11T23:20:00.000Z'
       )`,
      [scheduledPageId, randomUUID(), revision],
    );

    await expect(database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-page-wide-evidence', receiptPageId, revision],
    )).resolves.toMatchObject({
      rows: [{
        notion_page_id: receiptPageId,
        lifecycle_id: receiptPageId,
        lifecycle_state: 'publish_receipt:published',
      }],
    });
    await expect(database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-page-wide-evidence', reconciliationPageId, revision],
    )).resolves.toMatchObject({
      rows: [{
        notion_page_id: reconciliationPageId,
        lifecycle_state: 'external_reconciliation:failed',
      }],
    });
    await expect(database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-page-wide-evidence', scheduledPageId, revision],
    )).resolves.toMatchObject({
      rows: [{
        notion_page_id: scheduledPageId,
        lifecycle_state: 'operator_scheduled',
      }],
    });

    for (const pageId of [receiptPageId, reconciliationPageId, scheduledPageId]) {
      const otherWorkspace = await database.query(
        `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
        ['other-workspace', pageId, revision],
      );
      expect(otherWorkspace.rows).toEqual([]);
    }
  });

  it('fails closed for malformed revisions and evaluates standalone attempts', async () => {
    const pageId = 'revision-boundary-page';
    const attemptId = 'c6cdfa8a-e840-4e48-9776-044a8cd2b093';
    const oldRevision = '2026-09-08T16:37:00.000Z';
    const newRevision = '2026-09-08T23:36:51.638Z';

    const malformedRevisions = [
      'not-a-revision',
      'epoch',
      'infinity',
      '-infinity',
      '2026-09-08',
      '2026-09-08T23:36:51',
      '2026-09-08T23:36:51Z',
      '2026-09-08T23:36:51.638+00:00',
      '2026-02-30T23:36:51.638Z',
    ];
    for (const malformedRevision of malformedRevisions) {
      const malformedCandidate = await database.query(
        `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
        ['workspace-revision-boundary', pageId, malformedRevision],
      );
      expect(malformedCandidate.rows).toEqual([{
        notion_page_id: pageId,
        lifecycle_id: pageId,
        lifecycle_state: 'candidate_revision:invalid',
      }]);
    }
    const canonicalRevision = await database.query<{ valid: boolean }>(
      `SELECT rednote_publish_revision_is_valid($1) AS valid`,
      [newRevision],
    );
    expect(canonicalRevision.rows).toEqual([{ valid: true }]);

    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, terminal_outcome, terminal_at,
         receipt_lookup_state, active
       ) VALUES (
         $1, 'workspace-revision-boundary', $2, 'rednote-publishing/v1',
         $3, '{}'::jsonb, $4, $5,
         'operator', 'operator', 'operator-revision-boundary',
         '2026-09-08T23:20:00.000Z', '2026-09-08T23:19:00.000Z',
         'known_failed', '2026-09-08T23:25:00.000Z',
         'not_required', false
       )`,
      [attemptId, randomUUID(), pageId, 'e'.repeat(64), oldRevision],
    );

    const revised = await database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-revision-boundary', pageId, newRevision],
    );
    expect(revised.rows).toEqual([]);

    const sameRevision = await database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-revision-boundary', pageId, oldRevision],
    );
    expect(sameRevision.rows).toEqual([{
      notion_page_id: pageId,
      lifecycle_id: attemptId,
      lifecycle_state: 'publish_attempt:known_failed',
    }]);

    const malformedAttemptId = 'd6cdfa8a-e840-4e48-9776-044a8cd2b093';
    const malformedPageId = 'malformed-frozen-revision-page';
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, terminal_outcome, terminal_at,
         receipt_lookup_state, active
       ) VALUES (
         $1, 'workspace-revision-boundary', $2, 'rednote-publishing/v1',
         $3, '{}'::jsonb, $4, 'not-a-revision',
         'operator', 'operator', 'operator-revision-boundary',
         '2026-09-08T23:20:00.000Z', '2026-09-08T23:19:00.000Z',
         'known_failed', '2026-09-08T23:25:00.000Z',
         'not_required', false
       )`,
      [malformedAttemptId, randomUUID(), malformedPageId, 'f'.repeat(64)],
    );
    const malformedFrozenRevision = await database.query(
      `SELECT * FROM rednote_publish_revision_blockers($1, $2, $3)`,
      ['workspace-revision-boundary', malformedPageId, newRevision],
    );
    expect(malformedFrozenRevision.rows).toEqual([{
      notion_page_id: malformedPageId,
      lifecycle_id: malformedAttemptId,
      lifecycle_state: 'publish_attempt:known_failed',
    }]);
  });
});