import type { ManualHandlingMode } from '@/types/manual-post-handling';

export class ManualPostHandlingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ManualPostHandlingError';
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ManualPostHandlingError(
      `${field} must be a non-empty string`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return value.trim();
}

export function parseManualPostHandlingInput(value: unknown): {
  notionPageId: string;
  expectedLastEditedTime: string;
  mode: ManualHandlingMode;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManualPostHandlingError(
      'body must be an object',
      'VALIDATION_ERROR',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, ['expectedLastEditedTime', 'mode', 'notionPageId'])) {
    throw new ManualPostHandlingError(
      'body must contain only notionPageId, expectedLastEditedTime, and mode',
      'VALIDATION_ERROR',
      400,
    );
  }
  const mode = requiredString(body.mode, 'mode');
  if (mode !== 'scheduled' && mode !== 'published') {
    throw new ManualPostHandlingError(
      'mode must be scheduled or published',
      'VALIDATION_ERROR',
      400,
    );
  }
  const expectedLastEditedTime = requiredString(
    body.expectedLastEditedTime,
    'expectedLastEditedTime',
  );
  if (Number.isNaN(new Date(expectedLastEditedTime).getTime())) {
    throw new ManualPostHandlingError(
      'expectedLastEditedTime must be an ISO timestamp',
      'VALIDATION_ERROR',
      400,
    );
  }
  return {
    notionPageId: requiredString(body.notionPageId, 'notionPageId'),
    expectedLastEditedTime: new Date(expectedLastEditedTime).toISOString(),
    mode,
  };
}
