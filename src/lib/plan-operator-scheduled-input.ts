import { LocalPublishJobError } from '@/lib/local-publish-job-input';

export interface PlanOperatorScheduledInput {
  notionPageId: string;
  expectedNotionVersion: string;
  expectedScheduledAt: string;
}

function cleanString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string') {
    throw new LocalPublishJobError(`${field} must be a string`, 'VALIDATION_ERROR', 400);
  }
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) {
    throw new LocalPublishJobError(
      `${field} must be between 1 and ${maxLength} characters`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return cleaned;
}

function instant(value: unknown, field: string) {
  const raw = cleanString(value, field, 64);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new LocalPublishJobError(`${field} must be an ISO timestamp`, 'VALIDATION_ERROR', 400);
  }
  return parsed.toISOString();
}

export function parsePlanOperatorScheduledInput(
  value: unknown,
): PlanOperatorScheduledInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError(
      'Request body must be a JSON object',
      'VALIDATION_ERROR',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  const expected = [
    'expectedNotionVersion',
    'expectedScheduledAt',
    'notionPageId',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new LocalPublishJobError(
      'Request body contains unsupported fields',
      'VALIDATION_ERROR',
      400,
    );
  }
  return {
    notionPageId: cleanString(body.notionPageId, 'notionPageId', 64),
    expectedNotionVersion: instant(
      body.expectedNotionVersion,
      'expectedNotionVersion',
    ),
    expectedScheduledAt: instant(body.expectedScheduledAt, 'expectedScheduledAt'),
  };
}
