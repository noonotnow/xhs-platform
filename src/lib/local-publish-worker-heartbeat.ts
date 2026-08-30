import type { QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIN_POLL_SECONDS = 5;
const MAX_POLL_SECONDS = 86_400;
export const LOCAL_PUBLISH_WORKER_CONTRACT_REVISION = 'publishing-v1';
export const LOCAL_PUBLISH_WORKER_COMPATIBILITY_REVISION = 'ready-x3/v1';

export interface LocalPublishWorkerHeartbeatInput {
  workerId: string;
  contractRevision: string;
  compatibilityRevision: string;
  pollingIntervalSeconds: number;
  lastPollAt: string;
  nextPollAt: string;
}

interface WorkerHeartbeatRow extends QueryResultRow {
  workspace_id: string;
  worker_id: string;
  contract_revision: string;
  compatibility_revision: string;
  polling_interval_seconds: number;
  last_poll_at: Date | string;
  next_poll_at: Date | string;
  last_heartbeat_at: Date | string;
  lease_expires_at: Date | string;
}

function invalid(message: string) {
  throw new LocalPublishJobError(message, 'VALIDATION_ERROR', 400);
}

function isoDate(value: unknown, field: string) {
  if (typeof value !== 'string' || value.length > 40) invalid(`${field} must be an ISO timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    invalid(`${field} must be an ISO timestamp`);
  }
  return date;
}

/** Parses the intentionally small, credential-free worker liveness contract. */
export function parseLocalPublishWorkerHeartbeat(value: unknown): LocalPublishWorkerHeartbeatInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Heartbeat body must be a JSON object');
  }
  const body = value as Record<string, unknown>;
  const expected = [
    'compatibilityRevision',
    'contractRevision',
    'lastPollAt',
    'nextPollAt',
    'pollingIntervalSeconds',
    'workerId',
  ];
  const keys = Object.keys(body).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    invalid('Heartbeat body contains unsupported fields');
  }
  if (typeof body.workerId !== 'string' || !SAFE_ID.test(body.workerId)) {
    invalid('workerId must be a safe worker identifier');
  }
  if (body.contractRevision !== LOCAL_PUBLISH_WORKER_CONTRACT_REVISION) {
    invalid(`contractRevision must be ${LOCAL_PUBLISH_WORKER_CONTRACT_REVISION}`);
  }
  if (body.compatibilityRevision !== LOCAL_PUBLISH_WORKER_COMPATIBILITY_REVISION) {
    invalid(`compatibilityRevision must be ${LOCAL_PUBLISH_WORKER_COMPATIBILITY_REVISION}`);
  }
  if (body.contractRevision !== 'publishing-v1' ||
      body.compatibilityRevision !== 'ready-x3/v1') {
    invalid('Worker heartbeat contract is incompatible with Ready x3 automation');
  }
  const pollingIntervalSeconds = body.pollingIntervalSeconds;
  if (typeof pollingIntervalSeconds !== 'number' ||
      !Number.isSafeInteger(pollingIntervalSeconds) ||
      pollingIntervalSeconds < MIN_POLL_SECONDS ||
      pollingIntervalSeconds > MAX_POLL_SECONDS) {
    invalid(`pollingIntervalSeconds must be between ${MIN_POLL_SECONDS} and ${MAX_POLL_SECONDS}`);
  }
  const lastPollAt = isoDate(body.lastPollAt, 'lastPollAt');
  const nextPollAt = isoDate(body.nextPollAt, 'nextPollAt');
  if (nextPollAt.getTime() < lastPollAt.getTime() ||
      nextPollAt.getTime() > lastPollAt.getTime() + pollingIntervalSeconds * 2_000) {
    invalid('nextPollAt must be after lastPollAt within two polling intervals');
  }
  return {
    workerId: body.workerId,
    contractRevision: body.contractRevision,
    compatibilityRevision: body.compatibilityRevision,
    pollingIntervalSeconds,
    lastPollAt: lastPollAt.toISOString(),
    nextPollAt: nextPollAt.toISOString(),
  };
}

function leaseSeconds(interval: number) {
  return Math.min(3_600, Math.max(60, interval * 3));
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function publicHeartbeat(row: WorkerHeartbeatRow, now = Date.now()) {
  const leaseUntil = timestamp(row.lease_expires_at);
  const lastHeartbeatAt = timestamp(row.last_heartbeat_at);
  const offline = new Date(leaseUntil).getTime() <= now;
  const stale = !offline && new Date(row.next_poll_at).getTime() < now;
  const state = offline ? 'offline' : stale ? 'stale' : 'online';
  return {
    state,
    online: state === 'online',
    id: offline ? null : row.worker_id,
    contractRevision: offline ? null : row.contract_revision,
    compatibilityRevision: offline ? null : row.compatibility_revision,
    lastHeartbeatAt: offline ? null : lastHeartbeatAt,
    leaseUntil,
    polling: {
      state: offline ? 'offline' : stale ? 'stale' : 'active',
      active: state === 'online',
      intervalSeconds: offline ? null : row.polling_interval_seconds,
      lastPollAt: offline ? null : timestamp(row.last_poll_at),
      nextPollAt: offline ? null : timestamp(row.next_poll_at),
    },
  };
}

export async function upsertLocalPublishWorkerHeartbeat(
  workspaceId: string,
  input: LocalPublishWorkerHeartbeatInput,
) {
  const result = await getPool().query<WorkerHeartbeatRow>(
    `INSERT INTO local_publish_worker_heartbeats (
       workspace_id,worker_id,contract_revision,compatibility_revision,
       polling_interval_seconds,last_poll_at,next_poll_at,last_heartbeat_at,lease_expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP + ($8 * INTERVAL '1 second'))
     ON CONFLICT (workspace_id) DO UPDATE SET
       worker_id=EXCLUDED.worker_id,contract_revision=EXCLUDED.contract_revision,
       compatibility_revision=EXCLUDED.compatibility_revision,
       polling_interval_seconds=EXCLUDED.polling_interval_seconds,
       last_poll_at=EXCLUDED.last_poll_at,next_poll_at=EXCLUDED.next_poll_at,
       last_heartbeat_at=CURRENT_TIMESTAMP,lease_expires_at=EXCLUDED.lease_expires_at,
       updated_at=CURRENT_TIMESTAMP
     RETURNING *`,
    [workspaceId, input.workerId, input.contractRevision, input.compatibilityRevision,
      input.pollingIntervalSeconds, input.lastPollAt, input.nextPollAt,
      leaseSeconds(input.pollingIntervalSeconds)],
  );
  return publicHeartbeat(result.rows[0]);
}

export async function readLocalPublishWorkerHeartbeat(workspaceId: string) {
  const result = await getPool().query<WorkerHeartbeatRow>(
    `SELECT workspace_id,worker_id,contract_revision,compatibility_revision,
       polling_interval_seconds,last_poll_at,next_poll_at,last_heartbeat_at,lease_expires_at
     FROM local_publish_worker_heartbeats WHERE workspace_id=$1`,
    [workspaceId],
  );
  if (!result.rows[0]) {
    return {
      state: 'offline' as const, online: false, id: null, contractRevision: null,
      compatibilityRevision: null, lastHeartbeatAt: null, leaseUntil: null,
      polling: { state: 'offline' as const, active: false, intervalSeconds: null, lastPollAt: null, nextPollAt: null },
    };
  }
  return publicHeartbeat(result.rows[0]);
}