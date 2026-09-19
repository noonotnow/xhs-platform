import type {
  LocalPublishJobStatus,
  LocalPublishJobSummary,
  OperatorSuccessAttestationEvidence,
} from '@/types/local-publish-job';

export function adminApiFetch(
  workspaceId: string,
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set('X-Workspace-Id', workspaceId);
  return fetch(input, { ...init, headers });
}

export interface AdminLocalJobsResponse {
  jobs: LocalPublishJobSummary[];
  successAttestationCandidates: OperatorSuccessAttestationEvidence[];
  attempts: AdminRednoteAttemptSummary[];
}

export interface AdminRednoteAttemptSummary {
  id: string;
  sourceLocalPublishJobId: string | null;
  payloadDigest: string | null;
  payloadRevision: string | null;
  active: boolean | null;
  approvedAt: string | null;
  supersededByAttemptId: string | null;
  terminalOutcome: string | null;
}

export function isEligibleAdminRednoteAttempt(
  attempt: AdminRednoteAttemptSummary,
  sourceLocalPublishJobId: string,
) {
  return attempt.sourceLocalPublishJobId === sourceLocalPublishJobId
    && attempt.active === true
    && Boolean(attempt.approvedAt)
    && !attempt.supersededByAttemptId
    && !attempt.terminalOutcome
    && Boolean(attempt.payloadDigest)
    && Boolean(attempt.payloadRevision);
}

const LOCAL_PUBLISH_JOB_STATUSES = new Set<LocalPublishJobStatus>([
  'queued',
  'claimed',
  'staged',
  'submitted',
  'scheduled',
  'operator_attested',
  'verification_pending',
  'verified',
  'reconciled',
  'failed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLocalPublishJobSummary(value: unknown): value is LocalPublishJobSummary {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.notionPageId === 'string'
    && typeof value.status === 'string'
    && LOCAL_PUBLISH_JOB_STATUSES.has(value.status as LocalPublishJobStatus)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && typeof value.verificationAttempts === 'number';
}

function isOperatorSuccessAttestationEvidence(
  value: unknown,
): value is OperatorSuccessAttestationEvidence {
  return isRecord(value)
    && typeof value.batchId === 'string'
    && typeof value.manifestHash === 'string'
    && typeof value.itemId === 'string'
    && typeof value.jobId === 'string'
    && typeof value.itemHash === 'string'
    && typeof value.snapshotRevision === 'string'
    && typeof value.requestedPublishAt === 'string'
    && isRecord(value.expectedOutcome)
    && value.expectedOutcome.kind === 'scheduled'
    && typeof value.expectedOutcome.publishAt === 'string'
    && value.expectedOutcome.timeZone === 'America/New_York'
    && typeof value.expectedOutcome.text === 'string';
}

function isAdminRednoteAttemptSummary(
  value: unknown,
): value is AdminRednoteAttemptSummary {
  return isRecord(value)
    && typeof value.id === 'string'
    && (typeof value.sourceLocalPublishJobId === 'string'
      || value.sourceLocalPublishJobId === null)
    && (typeof value.payloadDigest === 'string' || value.payloadDigest === null)
    && (typeof value.payloadRevision === 'string' || value.payloadRevision === null)
    && (typeof value.active === 'boolean' || value.active === null)
    && (typeof value.approvedAt === 'string' || value.approvedAt === null)
    && (typeof value.supersededByAttemptId === 'string'
      || value.supersededByAttemptId === null)
    && (typeof value.terminalOutcome === 'string' || value.terminalOutcome === null);
}

function requireArrayField<T>(
  value: Record<string, unknown>,
  field: string,
  predicate: (item: unknown) => item is T,
): T[] {
  const items = value[field];
  if (!Array.isArray(items)) {
    throw new Error(`Local publish jobs response is missing the ${field} array`);
  }
  const malformedIndex = items.findIndex((item) => !predicate(item));
  if (malformedIndex !== -1) {
    throw new Error(
      `Local publish jobs response contains a malformed ${field}[${malformedIndex}] record`,
    );
  }
  return items;
}

export function parseAdminLocalJobsResponse(value: unknown): AdminLocalJobsResponse {
  if (!isRecord(value)) {
    throw new Error('Local publish jobs response must be an object');
  }
  return {
    jobs: requireArrayField(value, 'jobs', isLocalPublishJobSummary),
    successAttestationCandidates: requireArrayField(
      value,
      'successAttestationCandidates',
      isOperatorSuccessAttestationEvidence,
    ),
    attempts: value.attempts === undefined
      ? []
      : requireArrayField(value, 'attempts', isAdminRednoteAttemptSummary),
  };
}
