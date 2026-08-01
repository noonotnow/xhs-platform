import { describe, expect, it } from 'vitest';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import {
  buildExternalPostQueryFilter,
  buildExternalPublishedProperties,
  chooseExternalReconciliationTarget,
  type PropertyMap,
  type ResolvedSchema,
} from '@/lib/notion-posts';

const snapshot = {
  noteId: 'note_123',
  shareUrl: 'https://www.rednote.com/explore/note_123',
  title: 'Final title',
  caption: 'Final caption',
  mediaType: 'video' as const,
};

function page(id: string) {
  return { id } as PageObjectResponse;
}

const resolved: ResolvedSchema = {
  headline: 'Headline',
  platform: 'Platform',
  status: 'Status',
  thumbnail: null,
  mediaUrls: 'Image URLs',
  caption: 'Caption',
  publishPacketReady: 'Publish packet ready',
  hasVideo: 'Has video',
  needsMedia: 'Needs media',
  needsCaption: 'Needs caption',
  tags: null,
  xhsNoteId: 'Rednote Note ID',
  xhsShareUrl: 'Rednote URL',
  publishedAt: 'Published At',
  nextAction: 'Next action',
  scheduledDate: null,
};

const schemaProperties: PropertyMap = {
  Headline: { type: 'title' },
  Platform: { type: 'multi_select' },
  Status: { type: 'status' },
  'Image URLs': { type: 'rich_text' },
  Caption: { type: 'rich_text' },
  'Publish packet ready': { type: 'checkbox' },
  'Has video': { type: 'checkbox' },
  'Needs media': { type: 'checkbox' },
  'Needs caption': { type: 'checkbox' },
  'Rednote Note ID': { type: 'rich_text' },
  'Rednote URL': { type: 'url' },
  'Published At': { type: 'date' },
  'Next action': {
    type: 'select',
    select: { options: [{ name: 'Backfill URL/metrics' }, { name: 'No action' }] },
  },
};

describe('external post Notion reconciliation', () => {
  it('matches note ID first, falls back to URL, and rejects conflicts', () => {
    expect(chooseExternalReconciliationTarget([page('note')], [page('note')]))
      .toMatchObject({ page: { id: 'note' }, outcome: 'matched_note_id' });
    expect(chooseExternalReconciliationTarget([], [page('url')]))
      .toMatchObject({ page: { id: 'url' }, outcome: 'matched_url' });
    expect(chooseExternalReconciliationTarget([], []))
      .toEqual({ page: null, outcome: 'created' });
    expect(() => chooseExternalReconciliationTarget(
      [page('note')],
      [page('other')],
    )).toThrow('different Notion posts');
    expect(() => chooseExternalReconciliationTarget(
      [page('one'), page('two')],
      [],
    )).toThrow('Multiple Notion posts');
  });

  it('uses exact Note ID and URL filters supported by the resolved schema', () => {
    expect(buildExternalPostQueryFilter('Rednote Note ID', 'rich_text', 'note_123'))
      .toEqual({
        property: 'Rednote Note ID',
        rich_text: { equals: 'note_123' },
      });
    expect(buildExternalPostQueryFilter('Rednote URL', 'url', snapshot.shareUrl))
      .toEqual({
        property: 'Rednote URL',
        url: { equals: snapshot.shareUrl },
      });
  });

  it('builds the same safe Published snapshot for updates and creates without media URLs', () => {
    const properties = buildExternalPublishedProperties(
      resolved,
      {},
      schemaProperties,
      snapshot,
      '2026-08-04T12:00:00.000Z',
    );

    expect(properties).not.toHaveProperty('Image URLs');
    expect(properties).toMatchObject({
      Headline: { title: [{ text: { content: snapshot.title } }] },
      Caption: { rich_text: [{ text: { content: snapshot.caption } }] },
      Platform: { multi_select: [{ name: 'RedNote' }] },
      Status: { status: { name: 'Published' } },
      'Has video': { checkbox: true },
      'Needs media': { checkbox: false },
      'Needs caption': { checkbox: false },
      'Publish packet ready': { checkbox: false },
      'Rednote Note ID': { rich_text: [{ text: { content: snapshot.noteId } }] },
      'Rednote URL': { url: snapshot.shareUrl },
      'Next action': { select: { name: 'Backfill URL/metrics' } },
    });
  });

  it('preserves existing platform tags when updating a matched cross-post', () => {
    const matchedPage = {
      properties: {
        Platform: {
          id: 'platform',
          type: 'multi_select',
          multi_select: [
            { id: 'weibo', name: 'Weibo', color: 'red' },
            { id: 'rednote', name: 'RedNote', color: 'default' },
          ],
        },
      },
    } as unknown as PageObjectResponse;
    const properties = buildExternalPublishedProperties(
      resolved,
      {},
      schemaProperties,
      snapshot,
      '2026-08-04T12:00:00.000Z',
      matchedPage,
    );
    expect(properties.Platform).toEqual({
      multi_select: [{ name: 'Weibo' }, { name: 'RedNote' }],
    });
  });

  it('requires the exact Backfill URL/metrics option', () => {
    expect(() => buildExternalPublishedProperties(
      resolved,
      {},
      {
        ...schemaProperties,
        'Next action': {
          type: 'select',
          select: { options: [{ name: 'No action' }] },
        },
      },
      snapshot,
      '2026-08-04T12:00:00.000Z',
    )).toThrow('no Backfill URL/metrics option');
  });
});
