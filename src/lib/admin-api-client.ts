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
  };
}
