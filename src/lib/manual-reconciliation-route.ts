import { LocalPublishJobError } from '@/lib/local-publish-job-input';

export function parseManualReconciliationId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new LocalPublishJobError(
      'Invalid manual reconciliation id',
      'VALIDATION_ERROR',
      400,
    );
  }
  return value.toLowerCase();
}

export function parseManualReconciliationLimit(value: string | null) {
  if (value === null) return 10;
  if (!/^\d+$/.test(value)) {
    throw new LocalPublishJobError(
      'limit must be an integer between 1 and 20',
      'VALIDATION_ERROR',
      400,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new LocalPublishJobError(
      'limit must be an integer between 1 and 20',
      'VALIDATION_ERROR',
      400,
    );
  }
  return parsed;
}
