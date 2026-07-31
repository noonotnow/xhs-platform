import { sql } from '@/lib/db';
import type { PublishReadyPostResponse } from '@/types/ready-post';

export async function claimXhsPublish(notionPageId: string) {
  const result = await sql`
    INSERT INTO xhs_publish_receipts (notion_page_id, status)
    VALUES (${notionPageId}, 'publishing')
    ON CONFLICT (notion_page_id) DO NOTHING
    RETURNING notion_page_id
  `;
  return result.rowCount === 1;
}

export async function releaseXhsPublishClaim(notionPageId: string) {
  await sql`
    DELETE FROM xhs_publish_receipts
    WHERE notion_page_id = ${notionPageId} AND status = 'publishing'
  `;
}

export async function recordXhsPublish(
  notionPageId: string,
  published: PublishReadyPostResponse,
) {
  const result = await sql`
    UPDATE xhs_publish_receipts
    SET status = 'published',
        note_id = ${published.noteId},
        share_url = ${published.shareUrl},
        updated_at = CURRENT_TIMESTAMP
    WHERE notion_page_id = ${notionPageId} AND status = 'publishing'
  `;
  if (result.rowCount !== 1) {
    throw new Error('Publish receipt claim was not found');
  }
}
