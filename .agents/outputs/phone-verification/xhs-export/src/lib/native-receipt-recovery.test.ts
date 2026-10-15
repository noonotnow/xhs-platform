import { describe, expect, it } from 'vitest';
import { assertNativeRecoveryBinding, nativeReceiptLookupClaim } from './native-receipt-recovery';
import { parseLocalPublishWorkerResult, submitLocalPublishJobResult } from './local-publish-jobs';

const now = Date.now();
const slot = new Date(now + 86_400_000).toISOString();
const snapshot = { title: 'A test', caption: 'Exact body', tags: ['one'],
  expectedAccountId: 'owned', publishAt: slot };
const frozen = { browserPayload: {...snapshot}, timingMode: 'scheduled', targetPublishAt: slot };
const receipt = { noteId: '0123456789abcdef01234567', scheduledFor: slot,
  acknowledgedAt: new Date(now).toISOString(), authenticatedAccount: {
    accountId: 'owned', ownership: 'owned', capturedAt: new Date(now).toISOString(),
  }};
const attempt = { active: false, terminalOutcome: 'outcome_unknown',
  dispatchAuthorizedAt: new Date(now - 60_000).toISOString() };

describe('read-only native receipt recovery', () => {
  it('blocks old private-only success reports before any publication write', async () => {
    await expect(submitLocalPublishJobResult(
      '00000000-0000-4000-8000-000000000001', 'claim-token',
      {status:'verified',noteId:receipt.noteId,shareUrl:`https://www.rednote.com/explore/${receipt.noteId}`},
      'isolated',
    )).rejects.toMatchObject({code:'PUBLIC_RECEIPT_REQUIRED'});
  });
  it('claims only an already-dispatched unknown identity, never staging or consent', () => {
    const job = {status: 'verification_pending', receiptOutcome: 'ambiguous'};
    expect(nativeReceiptLookupClaim(job, attempt)).toMatchObject({status: 'identity_pending'});
    for (const changed of [{status:'claimed'}, {status:'staged'}, {noteId:receipt.noteId},
      {receiptOutcome:'rejected'}]) {
      const input = {...job,...changed};
      expect(nativeReceiptLookupClaim(input,attempt).status).toBe(input.status);
    }
    for (const changed of [{active:true}, {terminalOutcome:'known_failed'},
      {dispatchAuthorizedAt:null}]) {
      expect(nativeReceiptLookupClaim(job,{...attempt,...changed}).status).toBe(job.status);
    }
  });
  it('does not expose dispatch authorization or internal routing metadata on observation claims', () => {
    const result = nativeReceiptLookupClaim({
      status:'verification_pending',receiptOutcome:'ambiguous',
      dispatchAuthorizedAt:attempt.dispatchAuthorizedAt!,
    },attempt);
    expect(result).toMatchObject({status:'identity_pending',receiptLookup:{attemptedAt:attempt.dispatchAuthorizedAt}});
    expect(result).not.toHaveProperty('dispatchAuthorizedAt');
    expect(result).not.toHaveProperty('receiptOutcome');
  });
  it('requires exact frozen slot, owned account, copy and fresh observations', () => {
    expect(() => assertNativeRecoveryBinding(snapshot,frozen,receipt,now)).not.toThrow();
    for (const changed of [{scheduledFor:new Date(now).toISOString()},
      {noteId:'not-a-note'}, {authenticatedAccount:{...receipt.authenticatedAccount,accountId:'other'}},
      {authenticatedAccount:{...receipt.authenticatedAccount,capturedAt:new Date(now-400_000).toISOString()}}]) {
      expect(() => assertNativeRecoveryBinding(snapshot,frozen,{...receipt,...changed},now)).toThrow();
    }
    expect(() => assertNativeRecoveryBinding({...snapshot,caption:'changed'},frozen,receipt,now)).toThrow();
    expect(() => assertNativeRecoveryBinding(snapshot,{...frozen,timingMode:'post_now'},receipt,now)).toThrow();
  });
  it('keeps absence separate from a negative publish result', () => {
    expect(parseLocalPublishWorkerResult({
      status:'identity_pending',code:'RECEIPT_IDENTITY_PENDING',message:'Read-only lookup incomplete',
    })).toMatchObject({status:'identity_pending'});
  });
  it('binds anonymous public evidence to the exact returned identity', () => {
    const result = {status:'verified',noteId:receipt.noteId,
      shareUrl:`https://www.rednote.com/explore/${receipt.noteId}`};
    const publicReceipt = {contractVersion:'rednote-public-receipt/v1',
      source:'anonymous_public_page',noteId:result.noteId,canonicalUrl:result.shareUrl,
      capturedAt:new Date(now).toISOString()};
    expect(parseLocalPublishWorkerResult({...result,publicReceipt})).toMatchObject({publicReceipt});
    for (const changed of [{noteId:'1123456789abcdef01234567'}, {source:'private_creator'},
      {canonicalUrl:'https://example.com/'}]) {
      expect(() => parseLocalPublishWorkerResult({...result,publicReceipt:{...publicReceipt,...changed}})).toThrow();
    }
  });
});
