import { sql } from '@/lib/db';
import { createManualReconciliation } from '@/lib/manual-reconciliations';
import {
  createPublishBatch,
  dueSweepKinds,
} from '@/lib/rednote-publish-batches';
import { reconcilePendingRednotePostMutations } from '@/lib/rednote-publishing';

function localDate(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

async function recoverKnownReceipts() {
  const receipts = await sql<{
    notion_page_id: string;
    note_id: string;
    share_url: string;
  }>`
    SELECT receipt.notion_page_id, receipt.note_id, receipt.share_url
    FROM xhs_publish_receipts AS receipt
    LEFT JOIN local_publish_jobs AS job
      ON job.notion_page_id = receipt.notion_page_id
      AND job.status NOT IN ('failed', 'reconciled')
    LEFT JOIN manual_reconciliation_requests AS reconciliation
      ON reconciliation.notion_page_id = receipt.notion_page_id
      AND reconciliation.status IN ('queued', 'verifying', 'reconciled')
    WHERE receipt.status = 'published'
      AND receipt.note_id IS NOT NULL
      AND receipt.share_url IS NOT NULL
      AND job.id IS NULL
      AND reconciliation.id IS NULL
    LIMIT 50
  `;
  let recovered = 0;
  for (const receipt of receipts.rows) {
    try {
      await createManualReconciliation({
        notionPageId: receipt.notion_page_id,
        publicPost: receipt.share_url,
        confirmed: true,
      }, crypto.randomUUID());
      recovered += 1;
    } catch (error) {
      console.info('Known RedNote receipt did not need automatic reconciliation', {
        notionPageId: receipt.notion_page_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return recovered;
}

export async function runDueRednoteSweeps(now = new Date()) {
  const results = [];
  for (const cadence of dueSweepKinds(now)) {
    const inserted = await sql<{ id: string }>`
      INSERT INTO rednote_sweep_runs (cadence, local_date)
      VALUES (${cadence}, ${localDate(now)}::date)
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    const runId = inserted.rows[0]?.id;
    if (!runId) continue;
    try {
      const recoveredReceipts = await recoverKnownReceipts();
      // Sweeps recover receipts and cadence records only. Publishing manifests
      // require explicit operator-selected page IDs.
      const batch = await createPublishBatch(
        cadence === 'weekly' ? 'weekly' : 'catch_up',
        [],
        now,
      );
      await sql`
        UPDATE rednote_sweep_runs
        SET completed_at = CURRENT_TIMESTAMP,
            batch_id = ${batch?.id ?? null}::uuid
        WHERE id = ${runId}::uuid
      `;
      results.push({ cadence, batch, recoveredReceipts });
    } catch (error) {
      await sql`
        DELETE FROM rednote_sweep_runs
        WHERE id = ${runId}::uuid
          AND completed_at IS NULL
      `;
      throw error;
    }
  }
  return results;
}

export async function runRednoteMaintenance(now = new Date()) {
  const [postMutations, runs] = await Promise.all([
    reconcilePendingRednotePostMutations(25, { now: () => now }),
    runDueRednoteSweeps(now),
  ]);
  return { postMutations, runs };
}
