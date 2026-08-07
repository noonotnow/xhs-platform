import { describe, expect, it } from 'vitest';
import {
  parseRednoteClaimBody,
  parseRednoteOutcomeBody,
  parseRednoteReceiptBody,
  requireRednoteIdempotencyKey,
  requireRednoteWorkerCallbackIdentity,
} from '@/lib/rednote-publishing-api';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

describe('Rednote publishing API inputs', () => {
  it('requires a UUID idempotency header', () => {
    expect(() => requireRednoteIdempotencyKey(
      new Request('https://xhs.example', {
        headers: { 'Idempotency-Key': 'not-a-uuid' },
      }),
    )).toThrowError(expect.objectContaining({
      code: 'REDNOTE_REQUEST_INVALID',
      status: 400,
    }));
  });

  it('parses exact claim and terminal fields', () => {
    expect(parseRednoteClaimBody({
      expectedActiveAttemptId: null,
      workerRunId: 'worker-run-1',
      occurredAt: '2026-08-07T16:00:00.000Z',
    })).toMatchObject({ expectedActiveAttemptId: null });
    expect(() => parseRednoteOutcomeBody({
      outcome: 'retry',
      occurredAt: '2026-08-07T16:00:00.000Z',
    })).toThrowError(expect.objectContaining({
      code: 'REDNOTE_REQUEST_INVALID',
    }));
  });

  it('requires worker callback run identity headers', () => {
    expect(requireRednoteWorkerCallbackIdentity(
      new Request('https://xhs.example', {
        headers: {
          'X-Rednote-Worker-Run-Id': 'worker-run-1',
          'X-Rednote-Playwright-Run-Id': 'playwright-run-1',
        },
      }),
    )).toEqual({
      workerRunId: 'worker-run-1',
      playwrightRunId: 'playwright-run-1',
    });
    expect(() => requireRednoteWorkerCallbackIdentity(
      new Request('https://xhs.example'),
    )).toThrowError(expect.objectContaining({
      code: 'REDNOTE_REQUEST_INVALID',
      status: 400,
    }));
  });

  it('binds an atomic receipt to the route attempt', () => {
    const receipt = {
      attemptId: ATTEMPT_ID,
      rednoteUrl: 'https://www.xiaohongshu.com/explore/note-1',
      rednoteNoteId: 'note-1',
      platformPublishTime: '2026-08-07T15:59:00.000Z',
      capturedAt: '2026-08-07T16:00:00.000Z',
      provenance: { source: 'lookup' },
    };
    expect(parseRednoteReceiptBody(receipt, ATTEMPT_ID)).toEqual(receipt);
    expect(() => parseRednoteReceiptBody(
      receipt,
      '22222222-2222-4222-8222-222222222222',
    )).toThrowError(expect.objectContaining({
      code: 'REDNOTE_REQUEST_INVALID',
    }));
  });
});
