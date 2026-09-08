import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('batch authorization reclassification migration', () => {
  const migration = readFileSync(
    join(process.cwd(), 'migrations/026_batch_authorization_reclassification.sql'),
    'utf8',
  );

  it('allows only an explicit evidence-backed Ready x3 to batch correction', () => {
    expect(migration).toContain(
      "current_setting('app.batch_authorization_reclassification', true) = 'on'",
    );
    expect(migration).toContain("OLD.authorization_kind = 'ready_x3'");
    expect(migration).toContain('NEW.authorization_kind IS NULL');
    expect(migration).toContain("job.error_code = 'INVALID_CLAIM'");
    expect(migration).toContain('job.dispatch_authorized_at IS NULL');
    expect(migration).toContain("event.event_type = 'execution_started'");
    expect(migration).toContain('FROM rednote_publish_attempt_receipts receipt');
    expect(migration).toContain("batch.status IN ('approved', 'partially_approved')");
  });
});
