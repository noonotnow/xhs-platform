import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let database: PGlite;

function queryResult(result: Awaited<ReturnType<PGlite['query']>>) {
  return {
    ...result,
    rowCount: result.affectedRows ?? result.rows.length,
  };
}

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    connect: async () => ({
      query: async (statement: string, params?: unknown[]) => {
        if (statement.includes('pg_advisory_xact_lock')) {
          return { rows: [], rowCount: 0 };
        }
        return queryResult(await database.query(statement, params));
      },
      release: () => undefined,
    }),
    query: async (statement: string, params?: unknown[]) =>
      queryResult(await database.query(statement, params)),
  }),
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (query, part, index) => query + (index > 0 ? `$${index}` : '') + part,
      '',
    );
    return queryResult(await database.query(text, values));
  },
}));

import {
  activateDispatchActivation,
  cancelDispatchActivation,
  dispatchActivationNonceDigest,
  prepareDispatchActivation,
  releaseDispatchActivation,
} from '@/lib/local-publish-dispatch-activation';
import {
  claimExactActivatedStoredLocalPublishJob,
  claimNextStoredLocalPublishJob,
} from '@/lib/local-publish-job-store';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';

const migrations = [
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
  '031_recovery_attempt_generations.sql',
  '032_recover_creator_login_failure.sql',
  '033_rejected_worker_result_recovery_evidence.sql',
  '034_recover_schedule_readback_mismatch.sql',
  '035_recover_browser_closed_pre_publish.sql',
  '036_allow_stable_browser_closed_pre_publish.sql',
  '037_on_demand_publish_batches.sql',
  '038_exact_job_dispatch_activations.sql',
] as const;

const workspaceId = 'activation-integration';
const workerId = 'worker-release-1';
const contractRevision = 'publishing-v1';
const compatibilityRevision = 'ready-x3/v1';
const actorId = 'operator@example.com';

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

function digest(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

async function insertReadyJob(label: string) {
  const batchId = randomUUID();
  const itemId = randomUUID();
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const pageId = `activation-${label}-${randomUUID()}`;
  const sourceRevision = '2026-09-08T16:37:00.000Z';
  const media = {
    type: 'image' as const,
    url: 'https://images.xhs.justlikekatie.com/activation.png',
  };
  const snapshot = {
    notionPageId: pageId,
    headline: label,
    title: label,
    caption: label,
    tags: ['activation'],
    platform: 'RedNote',
    mediaType: 'image',
    mediaIndex: 0,
    mediaUrl: media.url,
    media: [{ ...media, identity: rednoteMediaIdentity(media) }],
    publishAt: '2026-09-08T23:20:00.000Z',
    notionLastEditedTime: sourceRevision,
    expectedAccountId: '678ba3b5000000000a03ecd2',
  };
  const itemHash = digest(snapshot);
  const manifestHash = digest({ itemId, itemHash });

  await database.query(
    `INSERT INTO rednote_publish_batches(
       id, workspace_id, kind, status, manifest_hash, approved_at
     ) VALUES ($1, $2, 'bootstrap', 'approved', $3, CURRENT_TIMESTAMP)`,
    [batchId, workspaceId, manifestHash],
  );
  await database.query(
    `INSERT INTO rednote_publish_batch_items(
       id, workspace_id, batch_id, notion_page_id, snapshot, item_hash,
       state, dispatch_mode, local_publish_job_id
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, $6, 'queued', 'scheduled', NULL
     )`,
    [itemId, workspaceId, batchId, pageId, JSON.stringify(snapshot), itemHash],
  );
  await database.query(
    `INSERT INTO local_publish_jobs(
       id, workspace_id, notion_page_id, snapshot, status, idempotency_key,
       batch_item_id
     ) VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, $6)`,
    [jobId, workspaceId, pageId, JSON.stringify(snapshot), randomUUID(), itemId],
  );
  await database.query(
    `UPDATE rednote_publish_batch_items
     SET local_publish_job_id = $2
     WHERE id = $1`,
    [itemId, jobId],
  );
  await database.query(
    `INSERT INTO rednote_publish_attempts(
       id, workspace_id, idempotency_key, contract_revision,
       source_notion_page_id, source_local_publish_job_id, frozen_payload,
       payload_digest, payload_revision, executor_type, executor_kind,
       executor_id, target_publish_at, requested_at, approved_at, active,
       receipt_lookup_state, authorization_kind, late_fallback_policy
     ) VALUES (
       $1, $2, $3, 'rednote-publishing/v1', $4, $5, $6::jsonb, $7, $8,
       'worker', 'playwright', $9, $10, CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP, true, 'pending', 'ready_x3',
       '{"action":"post_now","maxLateMinutes":30}'::jsonb
     )`,
    [
      attemptId,
      workspaceId,
      randomUUID(),
      pageId,
      jobId,
      JSON.stringify(snapshot),
      digest(snapshot),
      sourceRevision,
      workerId,
      snapshot.publishAt,
    ],
  );
  return {
    attemptId,
    batchId,
    itemHash,
    itemId,
    jobId,
    manifestHash,
    snapshot,
    sourceRevision,
  };
}

async function state(jobId: string, activationId: string) {
  const result = await database.query<{
    activation_state: string;
    claim_attempts: number;
    claim_token: string | null;
    attempt_claim_token: string | null;
  }>(
    `SELECT activation.state AS activation_state, job.claim_attempts,
       job.claim_token, attempt.claim_token AS attempt_claim_token
     FROM local_publish_dispatch_activations activation
     JOIN local_publish_jobs job ON job.id = activation.local_publish_job_id
     JOIN rednote_publish_attempts attempt
       ON attempt.source_local_publish_job_id = job.id AND attempt.active
     WHERE job.id = $1 AND activation.id = $2`,
    [jobId, activationId],
  );
  return result.rows[0];
}

describe('exact job dispatch activation', () => {
  beforeAll(async () => {
    database = new PGlite();
    for (const migration of migrations) {
      await database.exec(
        await readFile(path.join(process.cwd(), 'migrations', migration), 'utf8'),
      );
    }
    await database.query(
      `INSERT INTO local_publish_worker_heartbeats(
         workspace_id, worker_id, contract_revision, compatibility_revision,
         polling_interval_seconds, last_poll_at, next_poll_at,
         last_heartbeat_at, lease_expires_at
       ) VALUES (
         $1, $2, $3, $4, 30, CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP + INTERVAL '30 seconds', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP + INTERVAL '1 hour'
       )`,
      [workspaceId, workerId, contractRevision, compatibilityRevision],
    );
  });

  afterAll(async () => {
    await database.close();
  });

  it('blocks competing work, claims exactly once, and retains the hold until release', async () => {
    const exact = await insertReadyJob('exact');
    const competing = await insertReadyJob('competing');

    await expect(prepareDispatchActivation({
      workspaceId,
      jobId: exact.jobId,
      batchId: exact.batchId,
      itemId: exact.itemId,
      manifestHash: 'f'.repeat(64),
      itemHash: exact.itemHash,
      sourceRevision: exact.sourceRevision,
      generation: 0,
      expectedWorkerId: workerId,
      expectedWorkerContractRevision: contractRevision,
      expectedWorkerCompatibilityRevision: compatibilityRevision,
    }, actorId)).rejects.toMatchObject({
      code: 'DISPATCH_ACTIVATION_TARGET_MISMATCH',
    });

    const cancelledPreparation = await prepareDispatchActivation({
      workspaceId,
      jobId: exact.jobId,
      batchId: exact.batchId,
      itemId: exact.itemId,
      manifestHash: exact.manifestHash,
      itemHash: exact.itemHash,
      sourceRevision: exact.sourceRevision,
      generation: 0,
      expectedWorkerId: workerId,
      expectedWorkerContractRevision: contractRevision,
      expectedWorkerCompatibilityRevision: compatibilityRevision,
    }, actorId);
    await expect(cancelDispatchActivation(
      cancelledPreparation.activation.id,
      actorId,
      'Replacing an unused prepared nonce',
    )).resolves.toMatchObject({ state: 'cancelled' });

    let prepared = await prepareDispatchActivation({
      workspaceId,
      jobId: exact.jobId,
      batchId: exact.batchId,
      itemId: exact.itemId,
      manifestHash: exact.manifestHash,
      itemHash: exact.itemHash,
      sourceRevision: exact.sourceRevision,
      generation: 0,
      expectedWorkerId: workerId,
      expectedWorkerContractRevision: contractRevision,
      expectedWorkerCompatibilityRevision: compatibilityRevision,
    }, actorId);
    await database.query(
      `UPDATE local_publish_jobs
       SET status = 'claimed',
           claim_token = $2,
           claim_expires_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
       WHERE id = $1`,
      [competing.jobId, randomUUID()],
    );
    await expect(activateDispatchActivation(
      prepared.activation.id,
      prepared.nonce,
      actorId,
    )).rejects.toMatchObject({ code: 'DISPATCH_ACTIVATION_NOT_ACTIVATABLE' });
    await database.query(
      `UPDATE local_publish_jobs
       SET status = 'queued', claim_token = NULL, claim_expires_at = NULL
       WHERE id = $1`,
      [competing.jobId],
    );
    await activateDispatchActivation(prepared.activation.id, prepared.nonce, actorId);
    await database.query(
      `UPDATE local_publish_worker_heartbeats
       SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE workspace_id = $1 AND worker_id = $2`,
      [workspaceId, workerId],
    );
    await expect(releaseDispatchActivation(
      prepared.activation.id,
      actorId,
      'Unused activation must not release into generic dispatch',
    )).rejects.toMatchObject({ code: 'DISPATCH_ACTIVATION_NOT_RELEASABLE' });
    await expect(cancelDispatchActivation(
      prepared.activation.id,
      actorId,
      'Worker stopped before the activation was consumed',
    )).resolves.toMatchObject({ state: 'cancelled' });
    await database.query(
      `UPDATE local_publish_worker_heartbeats
       SET lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '1 hour'
       WHERE workspace_id = $1 AND worker_id = $2`,
      [workspaceId, workerId],
    );
    prepared = await prepareDispatchActivation({
      workspaceId,
      jobId: exact.jobId,
      batchId: exact.batchId,
      itemId: exact.itemId,
      manifestHash: exact.manifestHash,
      itemHash: exact.itemHash,
      sourceRevision: exact.sourceRevision,
      generation: 0,
      expectedWorkerId: workerId,
      expectedWorkerContractRevision: contractRevision,
      expectedWorkerCompatibilityRevision: compatibilityRevision,
    }, actorId);
    await activateDispatchActivation(prepared.activation.id, prepared.nonce, actorId);

    await expect(database.query(
      `INSERT INTO rednote_publish_batches(
         id, workspace_id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, $2, 'bootstrap', 'approved', $3, CURRENT_TIMESTAMP)`,
      [randomUUID(), workspaceId, 'e'.repeat(64)],
    )).rejects.toThrow(/DISPATCH_ACTIVATION_HOLD_ACTIVE/);
    await expect(database.query(
      `INSERT INTO local_publish_jobs(
         workspace_id, notion_page_id, snapshot, status, idempotency_key
       ) VALUES ($1, 'future-page', '{}'::jsonb, 'queued', $2)`,
      [workspaceId, randomUUID()],
    )).rejects.toThrow(/DISPATCH_ACTIVATION_HOLD_ACTIVE/);
    await expect(database.query(
      `UPDATE rednote_publish_batches
       SET status = 'pending_approval', approved_at = NULL
       WHERE id = $1`,
      [competing.batchId],
    )).resolves.toBeDefined();
    await expect(database.query(
      `UPDATE rednote_publish_batches
       SET status = 'approved', approved_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [competing.batchId],
    )).rejects.toThrow(/DISPATCH_ACTIVATION_HOLD_ACTIVE/);
    await expect(claimNextStoredLocalPublishJob(
      60,
      'dispatch',
      undefined,
      workspaceId,
      randomUUID(),
    )).resolves.toBeNull();

    await database.query(
      `UPDATE local_publish_jobs
       SET snapshot = jsonb_set(
         snapshot, '{title}', '"changed-title"'::jsonb
       )
       WHERE id = $1`,
      [exact.jobId],
    );
    await expect(claimExactActivatedStoredLocalPublishJob(
      60,
      workspaceId,
      exact.jobId,
      prepared.activation.id,
      dispatchActivationNonceDigest(prepared.nonce),
      randomUUID(),
      workerId,
    )).rejects.toMatchObject({ code: 'DISPATCH_ACTIVATION_NOT_CLAIMABLE' });
    expect(await state(exact.jobId, prepared.activation.id)).toEqual({
      activation_state: 'active',
      claim_attempts: 0,
      claim_token: null,
      attempt_claim_token: null,
    });
    await database.query(
      `UPDATE local_publish_jobs SET snapshot = $2::jsonb WHERE id = $1`,
      [exact.jobId, JSON.stringify(exact.snapshot)],
    );

    const claimToken = randomUUID();
    await expect(claimExactActivatedStoredLocalPublishJob(
      60,
      workspaceId,
      exact.jobId,
      prepared.activation.id,
      dispatchActivationNonceDigest(prepared.nonce),
      randomUUID(),
      'unexpected-worker',
    )).rejects.toMatchObject({ code: 'DISPATCH_ACTIVATION_NOT_CLAIMABLE' });
    const claim = await claimExactActivatedStoredLocalPublishJob(
      60,
      workspaceId,
      exact.jobId,
      prepared.activation.id,
      dispatchActivationNonceDigest(prepared.nonce),
      claimToken,
      workerId,
    );
    expect(claim).toMatchObject({
      id: exact.jobId,
      claimToken,
      dispatchActivation: {
        id: prepared.activation.id,
        generation: 0,
        releaseRequired: true,
      },
    });
    await expect(claimExactActivatedStoredLocalPublishJob(
      60,
      workspaceId,
      exact.jobId,
      prepared.activation.id,
      dispatchActivationNonceDigest(prepared.nonce),
      randomUUID(),
      workerId,
    )).rejects.toMatchObject({ code: 'DISPATCH_ACTIVATION_NOT_CLAIMABLE' });
    await expect(database.query(
      `INSERT INTO local_publish_jobs(
         workspace_id, notion_page_id, snapshot, status, idempotency_key
       ) VALUES ($1, 'future-page-2', '{}'::jsonb, 'queued', $2)`,
      [workspaceId, randomUUID()],
    )).rejects.toThrow(/DISPATCH_ACTIVATION_HOLD_ACTIVE/);

    await expect(releaseDispatchActivation(
      prepared.activation.id,
      actorId,
      'Worker stopped and exact claim verified',
    )).rejects.toMatchObject({ code: 'DISPATCH_ACTIVATION_NOT_RELEASABLE' });
    await database.query(
      `UPDATE local_publish_jobs
       SET status = 'failed', claim_expires_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [exact.jobId],
    );
    await database.query(
      `UPDATE local_publish_worker_heartbeats
       SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE workspace_id = $1 AND worker_id = $2`,
      [workspaceId, workerId],
    );
    const released = await releaseDispatchActivation(
      prepared.activation.id,
      actorId,
      'Worker stopped and exact claim verified',
    );
    expect(released.state).toBe('released');
    await expect(database.query(
      `INSERT INTO local_publish_jobs(
         workspace_id, notion_page_id, snapshot, status, idempotency_key
       ) VALUES ($1, 'future-page-3', '{}'::jsonb, 'queued', $2)`,
      [workspaceId, randomUUID()],
    )).resolves.toBeDefined();

    const events = await database.query<{ event_type: string; actor_id: string }>(
      `SELECT event_type, actor_id
       FROM local_publish_dispatch_activation_events
       WHERE activation_id = $1
       ORDER BY id`,
      [prepared.activation.id],
    );
    expect(events.rows).toEqual([
      { event_type: 'prepared', actor_id: actorId },
      { event_type: 'activated', actor_id: actorId },
      { event_type: 'consumed', actor_id: workerId },
      { event_type: 'released', actor_id: actorId },
    ]);
    await expect(database.query(
      'TRUNCATE local_publish_dispatch_activation_events',
    )).rejects.toThrow(/append-only/);
  });
});
