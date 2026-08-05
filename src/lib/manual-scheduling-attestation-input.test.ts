import { describe, expect, it } from 'vitest';
import { parseManualSchedulingAttestationInput } from '@/lib/manual-scheduling-attestation-input';

const input = {
  notionPageId: 'notion-page',
  batchId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemId: '22222222-2222-4222-8222-222222222222',
  itemHash: 'b'.repeat(64),
  snapshotRevision: '2026-08-04T13:12:00.000Z',
  requestedPublishAt: '2026-08-06T14:30:00.000Z',
  confirmed: true,
};

describe('manual scheduling attestation input', () => {
  it('accepts only exact confirmed frozen evidence', () => {
    expect(parseManualSchedulingAttestationInput(input)).toEqual({
      notionPageId: input.notionPageId,
      batchId: input.batchId,
      manifestHash: input.manifestHash,
      itemId: input.itemId,
      itemHash: input.itemHash,
      snapshotRevision: input.snapshotRevision,
      requestedPublishAt: input.requestedPublishAt,
    });
  });

  it('rejects missing confirmation, stale-shaped timestamps, and extra fields', () => {
    expect(() => parseManualSchedulingAttestationInput({
      ...input,
      confirmed: false,
    })).toThrow(/confirmation/);
    expect(() => parseManualSchedulingAttestationInput({
      ...input,
      snapshotRevision: '2026-08-04',
    })).toThrow(/canonical UTC/);
    expect(() => parseManualSchedulingAttestationInput({
      ...input,
      publicUrl: 'https://example.com',
    })).toThrow(/unsupported or missing/);
  });
});
