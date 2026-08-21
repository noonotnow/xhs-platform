import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { sql } from '@/lib/db';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTION_PAGE_ID_PATTERN = /^[0-9a-f-]{32,36}$/i;

export interface PlanRednoteBatchHandoffItem {
  itemId: string;
  notionPageId: string;
  notionVersion: string;
  plannedAt?: string;
  headline: string;
  platform: string;
}

export interface PlanRednoteBatchManifest {
  batchId: string;
  manifestId: string;
  idempotencyKey: string;
  handoff: {
    mode: 'queue';
    publishPolicy: 'explicit-approval-only';
    scheduledPublish: false;
  };
  items: PlanRednoteBatchHandoffItem[];
}

export interface PlanRednoteBatchQueueReceipt {
  batchId: string;
  manifestId: string;
  state: 'queued' | 'replayed';
  items: Array<{
    itemId: string;
    notionPageId: string;
    notionVersion: string;
    state: 'queued' | 'replayed' | 'rejected';
    reason?: string;
  }>;
}

export interface PlanRednoteBatchApprovalReceipt {
  batchId: string;
  itemId: string;
  notionPageId: string;
  notionVersion: string;
  state: 'approved' | 'replayed';
}

function validateManifest(body: unknown): PlanRednoteBatchManifest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LocalPublishJobError('Request body must be a JSON object', 'VALIDATION_ERROR', 400);
  }
  const m = body as Record<string, unknown>;
  if (typeof m.batchId !== 'string' || !UUID_PATTERN.test(m.batchId)) {
    throw new LocalPublishJobError('batchId must be a valid UUID', 'VALIDATION_ERROR', 400);
  }
  if (typeof m.manifestId !== 'string' || !UUID_PATTERN.test(m.manifestId)) {
    throw new LocalPublishJobError('manifestId must be a valid UUID', 'VALIDATION_ERROR', 400);
  }
  if (typeof m.idempotencyKey !== 'string' || m.idempotencyKey.length < 32) {
    throw new LocalPublishJobError('idempotencyKey must be at least 32 characters', 'VALIDATION_ERROR', 400);
  }
  const h = m.handoff as Record<string, unknown> | undefined;
  if (!h || h.mode !== 'queue' || h.publishPolicy !== 'explicit-approval-only' || h.scheduledPublish !== false) {
    throw new LocalPublishJobError(
      'handoff must be mode=queue, publishPolicy=explicit-approval-only, scheduledPublish=false',
      'PLAN_UNSAFE_REDNOTE_MANIFEST',
      400,
    );
  }
  if (!Array.isArray(m.items) || m.items.length === 0) {
    throw new LocalPublishJobError('items must be a non-empty array', 'VALIDATION_ERROR', 400);
  }
  for (const item of m.items) {
    if (!item || typeof item !== 'object') {
      throw new LocalPublishJobError('Each item must be an object', 'VALIDATION_ERROR', 400);
    }
    const i = item as Record<string, unknown>;
    if (typeof i.itemId !== 'string' || !UUID_PATTERN.test(i.itemId)) {
      throw new LocalPublishJobError('Each item.itemId must be a valid UUID', 'VALIDATION_ERROR', 400);
    }
    if (typeof i.notionPageId !== 'string' || !NOTION_PAGE_ID_PATTERN.test(i.notionPageId)) {
      throw new LocalPublishJobError('Each item.notionPageId must be a valid Notion page ID', 'VALIDATION_ERROR', 400);
    }
    if (typeof i.notionVersion !== 'string' || !i.notionVersion) {
      throw new LocalPublishJobError('Each item.notionVersion is required', 'VALIDATION_ERROR', 400);
    }
  }
  return m as unknown as PlanRednoteBatchManifest;
}

type ItemRow = { item_id: string; notion_page_id: string; notion_version: string; state: string; rejection_reason: string | null };

function toReceiptItem(row: ItemRow): PlanRednoteBatchQueueReceipt['items'][number] {
  return {
    itemId: row.item_id,
    notionPageId: row.notion_page_id,
    notionVersion: row.notion_version,
    state: row.state as 'queued' | 'rejected',
    ...(row.rejection_reason ? { reason: row.rejection_reason } : {}),
  };
}

export async function queuePlanRednoteBatch(
  body: unknown,
  idempotencyKey: string,
): Promise<{ receipt: PlanRednoteBatchQueueReceipt; status: number }> {
  const manifest = validateManifest(body);

  // Idempotency: check if this exact key was already processed
  const existingByKey = await sql<{ batch_id: string; manifest_id: string }>`
    SELECT batch_id, manifest_id FROM plan_rednote_batch_manifests
    WHERE idempotency_key = ${idempotencyKey}
  `;
  if (existingByKey.rows.length > 0) {
    const row = existingByKey.rows[0];
    if (row.batch_id !== manifest.batchId || row.manifest_id !== manifest.manifestId) {
      throw new LocalPublishJobError(
        'The idempotency key belongs to a different batch',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    const items = await sql<ItemRow>`
      SELECT item_id, notion_page_id, notion_version, state, rejection_reason
      FROM plan_rednote_batch_manifest_items WHERE batch_id = ${manifest.batchId}
    `;
    return {
      receipt: { batchId: manifest.batchId, manifestId: manifest.manifestId, state: 'replayed', items: items.rows.map(toReceiptItem) },
      status: 200,
    };
  }

  // Check for a conflicting batchId / manifestId (different idempotency key)
  const conflict = await sql<{ id: string }>`
    SELECT id FROM plan_rednote_batch_manifests
    WHERE batch_id = ${manifest.batchId} OR manifest_id = ${manifest.manifestId}
  `;
  if (conflict.rows.length > 0) {
    throw new LocalPublishJobError(
      'This batch or manifest ID already belongs to a different request',
      'IDEMPOTENCY_CONFLICT',
      409,
    );
  }

  // Detect active per-page conflicts (a post can only be in one non-rejected batch at a time)
  const pageIds = manifest.items.map((i) => i.notionPageId);
  const activeConflicts = await sql<{ notion_page_id: string }>`
    SELECT notion_page_id FROM plan_rednote_batch_manifest_items
    WHERE notion_page_id = ANY(${pageIds}::text[]) AND state NOT IN ('rejected')
  `;
  const conflictingPageIds = new Set(activeConflicts.rows.map((r) => r.notion_page_id));

  // Insert the manifest record
  const inserted = await sql<{ id: string }>`
    INSERT INTO plan_rednote_batch_manifests
      (batch_id, manifest_id, idempotency_key, handoff_mode, publish_policy, manifest_json, state)
    VALUES
      (${manifest.batchId}, ${manifest.manifestId}, ${idempotencyKey},
       'queue', 'explicit-approval-only', ${JSON.stringify(manifest)}::jsonb, 'queued')
    RETURNING id
  `;
  const manifestPk = inserted.rows[0].id;

  // Insert each item; items with a conflicting page ID are immediately rejected
  const receiptItems: PlanRednoteBatchQueueReceipt['items'] = [];
  for (const item of manifest.items) {
    const rejected = conflictingPageIds.has(item.notionPageId);
    const itemState = rejected ? 'rejected' : 'queued';
    const reason = rejected
      ? 'This post is already in an active Rednote batch. Wait for completion or cancel it first.'
      : null;
    await sql`
      INSERT INTO plan_rednote_batch_manifest_items
        (manifest_pk, batch_id, item_id, notion_page_id, notion_version, state, rejection_reason)
      VALUES
        (${manifestPk}::uuid, ${manifest.batchId}, ${item.itemId},
         ${item.notionPageId}, ${item.notionVersion}, ${itemState}, ${reason})
    `;
    receiptItems.push({
      itemId: item.itemId,
      notionPageId: item.notionPageId,
      notionVersion: item.notionVersion,
      state: itemState,
      ...(reason ? { reason } : {}),
    });
  }

  return {
    receipt: { batchId: manifest.batchId, manifestId: manifest.manifestId, state: 'queued', items: receiptItems },
    status: 201,
  };
}

export async function approvePlanRednoteBatchItem(
  batchId: string,
  itemId: string,
  notionPageId: string,
  expectedNotionVersion: string,
  idempotencyKey: string,
): Promise<{ approval: PlanRednoteBatchApprovalReceipt; status: number }> {
  if (!UUID_PATTERN.test(batchId)) {
    throw new LocalPublishJobError('batchId must be a valid UUID', 'VALIDATION_ERROR', 400);
  }
  if (!UUID_PATTERN.test(itemId)) {
    throw new LocalPublishJobError('itemId must be a valid UUID', 'VALIDATION_ERROR', 400);
  }

  // Idempotency: replay if this approval key was already used
  const existingByKey = await sql<{ item_id: string; batch_id: string; notion_page_id: string; notion_version: string }>`
    SELECT item_id, batch_id, notion_page_id, notion_version
    FROM plan_rednote_batch_manifest_items
    WHERE approval_idempotency_key = ${idempotencyKey}
  `;
  if (existingByKey.rows.length > 0) {
    const r = existingByKey.rows[0];
    if (r.batch_id !== batchId || r.item_id !== itemId) {
      throw new LocalPublishJobError(
        'The approval idempotency key belongs to a different item',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    return { approval: { batchId, itemId, notionPageId: r.notion_page_id, notionVersion: r.notion_version, state: 'replayed' }, status: 200 };
  }

  // Look up the item
  const itemResult = await sql<{ id: string; notion_page_id: string; notion_version: string; state: string }>`
    SELECT id, notion_page_id, notion_version, state
    FROM plan_rednote_batch_manifest_items
    WHERE batch_id = ${batchId} AND item_id = ${itemId}
  `;
  if (itemResult.rows.length === 0) {
    throw new LocalPublishJobError(
      'No matching batch item found. Ensure the batch was queued before approval.',
      'PLAN_REDNOTE_APPROVAL_UNCORRELATED',
      409,
    );
  }
  const row = itemResult.rows[0];

  const normalizePageId = (v: string) => v.replaceAll('-', '').toLowerCase();
  if (normalizePageId(row.notion_page_id) !== normalizePageId(notionPageId)) {
    throw new LocalPublishJobError(
      'The notionPageId does not match the queued batch item.',
      'PLAN_REDNOTE_APPROVAL_UNCORRELATED',
      409,
    );
  }
  if (row.notion_version !== expectedNotionVersion) {
    throw new LocalPublishJobError(
      'This post changed after it was queued. Refresh, review, and queue a new manifest before approval.',
      'PLAN_REDNOTE_STALE_VERSION',
      409,
    );
  }
  if (row.state === 'rejected') {
    throw new LocalPublishJobError(
      'This batch item was rejected and cannot be approved. Queue a new batch instead.',
      'PLAN_REDNOTE_APPROVAL_INELIGIBLE',
      422,
    );
  }

  await sql`
    UPDATE plan_rednote_batch_manifest_items
    SET state = 'approved', approval_idempotency_key = ${idempotencyKey}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${row.id}::uuid
  `;

  return {
    approval: { batchId, itemId, notionPageId: row.notion_page_id, notionVersion: row.notion_version, state: 'approved' },
    status: 200,
  };
}
