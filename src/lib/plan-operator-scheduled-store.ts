import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { PlanOperatorScheduledInput } from '@/lib/plan-operator-scheduled-input';
import type {
  RednotePublicationNextStep,
  RednotePublicationStatus,
} from '@/lib/rednote-publishing-contract-v1';
import {
  findManualPostHandlingByIdempotencyKey,
  insertManualPostHandling,
  loadManualPostHandlingsByPages,
  loadManualPostHandlingByPage,
} from '@/lib/manual-post-handling-store';
import type { ManualPostHandlingSummary } from '@/types/manual-post-handling';

export interface PlanOperatorScheduledState {
  id: string;
  notionPageId: string;
  state: 'operator_scheduled_receipt_pending' | 'reconciled';
  scheduledAt: string;
  notionVersion: string;
  recordedBy: string;
  recordedAt: string;
  reconciledAt?: string;
  publicationStatus: RednotePublicationStatus;
  publicationNextStep: RednotePublicationNextStep;
}

function mapHandling(
  handling: ManualPostHandlingSummary,
): PlanOperatorScheduledState {
  return {
    id: handling.id,
    notionPageId: handling.notionPageId,
    state: handling.receiptStatus === 'reconciled'
      ? 'reconciled'
      : 'operator_scheduled_receipt_pending',
    scheduledAt: handling.scheduledAt ?? handling.createdAt,
    notionVersion: handling.notionVersion,
    recordedBy: handling.recordedBy,
    recordedAt: handling.createdAt,
    ...(handling.reconciledAt ? { reconciledAt: handling.reconciledAt } : {}),
    ...(handling.stableLinkCapturedAt
      ? { stableLinkCapturedAt: handling.stableLinkCapturedAt }
      : {}),
    publicationStatus: handling.receiptStatus === 'reconciled'
      ? 'Published' as const
      : 'Verify receipt' as const,
    publicationNextStep: handling.receiptStatus === 'reconciled'
      ? 'Backfill metrics' as const
      : 'Verify receipt' as const,
  };
}

function replayMatches(
  handling: ManualPostHandlingSummary,
  input: PlanOperatorScheduledInput,
) {
  return handling.notionPageId === input.notionPageId
    && handling.scheduledAt === input.expectedScheduledAt
    && handling.mode === 'scheduled'
    && handling.recordedBy === 'plan';
}

function replayConflict() {
  return new LocalPublishJobError(
    'The idempotency key or Notion page already belongs to a different operator-scheduled request',
    'PLAN_OPERATOR_SCHEDULED_REPLAY_MISMATCH',
    409,
  );
}

function mapGenericError(error: unknown): never {
  if (!(error instanceof Error) || !('code' in error)) throw error;
  const code = String(error.code);
  if (
    code === 'IDEMPOTENCY_CONFLICT'
    || code === 'MANUAL_HANDLING_EXISTS'
  ) {
    throw replayConflict();
  }
  if (code === 'VERIFIED_PUBLICATION_EXISTS') {
    throw new LocalPublishJobError(
      error.message,
      'PLAN_OPERATOR_SCHEDULED_DURABLE_CONFLICT',
      409,
    );
  }
  if (code === 'LIVE_AUTOMATION_OWNERSHIP') {
    throw new LocalPublishJobError(
      error.message,
      'PLAN_OPERATOR_SCHEDULED_ACTIVE_WORKER_CONFLICT',
      409,
    );
  }
  throw error;
}

export async function loadPlanOperatorScheduledState(notionPageId: string) {
  const handling = await loadManualPostHandlingByPage(notionPageId);
  return handling ? mapHandling(handling) : null;
}

export async function loadPlanOperatorScheduledReplay(
  input: PlanOperatorScheduledInput,
  idempotencyKey: string,
) {
  const byKey = await findManualPostHandlingByIdempotencyKey(idempotencyKey);
  const handling = byKey ?? await loadManualPostHandlingByPage(input.notionPageId);
  if (!handling) return null;
  if (!replayMatches(handling, input)) throw replayConflict();
  return mapHandling(handling);
}

export async function listPlanOperatorScheduledPageIds(pageIds: string[]) {
  if (pageIds.length === 0) return new Set<string>();
  const handlings = await loadManualPostHandlingsByPages(pageIds);
  return new Set(handlings.map((handling) => handling.notionPageId));
}

export async function insertPlanOperatorScheduledState(
  input: PlanOperatorScheduledInput,
  idempotencyKey: string,
  observedNotionVersion = input.expectedNotionVersion,
) {
  try {
    const result = await insertManualPostHandling({
      notionPageId: input.notionPageId,
      notionVersion: observedNotionVersion,
      mode: 'scheduled',
      scheduledAt: input.expectedScheduledAt,
      warnings: [],
      recordedBy: 'plan',
      idempotencyKey,
    });
    return { execution: mapHandling(result.handling), created: result.created };
  } catch (error) {
    return mapGenericError(error);
  }
}
