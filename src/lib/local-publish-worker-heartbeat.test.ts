import { describe, expect, it } from 'vitest';
import { parseLocalPublishWorkerHeartbeat } from '@/lib/local-publish-worker-heartbeat';

const valid = {
  workerId: 'desktop-worker-1',
  contractRevision: 'publishing-v1',
  compatibilityRevision: 'ready-x3/v1',
  pollingIntervalSeconds: 30,
  lastPollAt: '2026-08-04T13:30:00.000Z',
  nextPollAt: '2026-08-04T13:30:30.000Z',
};

describe('local publish worker heartbeat contract', () => {
  it('accepts only the explicit non-sensitive liveness fields', () => {
    expect(parseLocalPublishWorkerHeartbeat(valid)).toEqual(valid);
    expect(() => parseLocalPublishWorkerHeartbeat({
      ...valid,
      cookie: 'browser-session-cookie',
    })).toThrow('unsupported fields');
  });

  it('rejects invalid polling metadata rather than retaining arbitrary worker data', () => {
    expect(() => parseLocalPublishWorkerHeartbeat({
      ...valid,
      workerId: 'worker with spaces',
    })).toThrow('safe worker identifier');
    expect(() => parseLocalPublishWorkerHeartbeat({
      ...valid,
      contractRevision: 'publishing-v2',
    })).toThrow('contractRevision must be publishing-v1');
    expect(() => parseLocalPublishWorkerHeartbeat({
      ...valid,
      pollingIntervalSeconds: 1,
    })).toThrow('pollingIntervalSeconds');
    expect(() => parseLocalPublishWorkerHeartbeat({
      ...valid,
      nextPollAt: '2026-08-04T13:32:00.000Z',
    })).toThrow('within two polling intervals');
  });
});