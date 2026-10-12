import { describe, expect, it } from 'vitest';
import { rednoteDispatchOutcome } from './rednote-dispatch-outcome';

describe('canonical Dispatch outcome projection', () => {
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
});
