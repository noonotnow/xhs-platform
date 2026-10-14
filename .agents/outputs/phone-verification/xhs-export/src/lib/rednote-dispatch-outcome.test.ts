import { describe, expect, it } from 'vitest';
import { rednoteDispatchOutcome, rednotePublicReceiptVerified } from './rednote-dispatch-outcome';

describe('canonical Dispatch outcome projection', () => {
  it('resolves a recovered schedule without rewriting the original unknown outcome', () => {
    expect(rednoteDispatchOutcome({
      status: 'verification_pending', terminalOutcome: 'outcome_unknown',
      receiptLookupState: 'found', receiptOutcome: 'scheduled',
      receiptAcknowledgedAt: '2026-10-12T21:19:13.916Z',
    })).toEqual({
      state: 'verification_pending', providerAccepted: true, failed: false, failure: null,
    });
  });
  it('requires both a bound identity and a real acceptance timestamp for recovery', () => {
    for (const missing of [
      { receiptLookupState: 'identity_pending' },
      { receiptOutcome: 'ambiguous' },
      { receiptAcknowledgedAt: null },
      { receiptAcknowledgedAt: 'invalid' },
      { terminalOutcome: 'known_failed' },
    ]) {
      expect(rednoteDispatchOutcome({
        status: 'verification_pending', terminalOutcome: 'outcome_unknown',
        receiptLookupState: 'found', receiptOutcome: 'scheduled',
        receiptAcknowledgedAt: '2026-10-12T21:19:13.916Z', ...missing,
      }).providerAccepted).toBe(false);
    }
  });
  it('never promotes a recovered identity or schedule to public publication', () => {
    expect(rednotePublicReceiptVerified({
      status: 'verification_pending', publicIndexStatus: 'pending',
      canonicalUrl: null, verifiedAt: null,
    })).toBe(false);
    expect(rednotePublicReceiptVerified({
      status: 'scheduled', publicIndexStatus: 'indexed',
      canonicalUrl: 'https://www.rednote.com/explore/note', verifiedAt: '2026-10-13T12:00:00Z',
    })).toBe(false);
  });
  it('requires verified lifecycle state, public evidence and a verification timestamp', () => {
    const verified = { status: 'reconciled', publicIndexStatus: 'indexed',
      canonicalUrl: 'https://www.rednote.com/explore/note', verifiedAt: '2026-10-13T12:00:00Z' };
    expect(rednotePublicReceiptVerified(verified)).toBe(true);
    for (const missing of [{ publicIndexStatus: null }, { canonicalUrl: null },
      { verifiedAt: null }, { verifiedAt: 'invalid' }]) {
      expect(rednotePublicReceiptVerified({ ...verified, ...missing })).toBe(false);
    }
  });
  it('does not count a response timeout as failure or provider acceptance', () => {
    expect(rednoteDispatchOutcome({
      status: 'verification_pending', terminalOutcome: 'outcome_unknown',
      receiptLookupState: 'identity_pending',
    })).toEqual({
      state: 'identity_pending', providerAccepted: false, failed: false, failure: null,
    });
  });
  it('keeps a native accepted schedule separate from pending public identity', () => {
    expect(rednoteDispatchOutcome({
      status: 'scheduled', terminalOutcome: 'accepted', receiptLookupState: 'identity_pending',
    })).toEqual({
      state: 'scheduled', providerAccepted: true, failed: false, failure: null,
    });
  });
  it('does not infer acceptance from an editorial or unacknowledged slot', () => {
    expect(rednoteDispatchOutcome({
      status: 'scheduled', terminalOutcome: null, receiptLookupState: 'pending',
    }).providerAccepted).toBe(false);
  });
  it.each(['known_failed', null])('preserves real failure (%s)', terminalOutcome => {
    const projected = rednoteDispatchOutcome({
      status: 'failed', terminalOutcome, receiptLookupState: 'pending',
    });
    expect(projected.failed).toBe(true);
    expect(projected.failure).toBe('Publishing attempt failed');
  });
  it('does not turn an unknown outcome into failure even with a legacy failed status', () => {
    expect(rednoteDispatchOutcome({
      status: 'failed', terminalOutcome: 'outcome_unknown', receiptLookupState: 'identity_pending',
    }).failed).toBe(false);
  });
  it('projects a legacy unknown failure as unconfirmed without lookup metadata', () => {
    expect(rednoteDispatchOutcome({
      status: 'failed', terminalOutcome: 'outcome_unknown', receiptLookupState: null,
    }).state).toBe('identity_pending');
  });
  it('does not hide a known negative outcome behind pending lookup metadata', () => {
    const projected = rednoteDispatchOutcome({
      status: 'failed', terminalOutcome: 'known_failed', receiptLookupState: 'identity_pending',
    });
    expect(projected.state).toBe('failed');
    expect(projected.failed).toBe(true);
  });
});
