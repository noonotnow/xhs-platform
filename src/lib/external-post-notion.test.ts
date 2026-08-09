import { describe, expect, it } from 'vitest';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import {
  buildExternalPostQueryFilter,
  buildExternalPublishedProperties,
  chooseExternalReconciliationTarget,
  resolvePostsSchema,
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
  productionNextStep: null,
  publicationStatus: 'Publication Status',
  publicationNextStep: 'Publication Next Step',
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
  'Publication Status': {
    type: 'status',
    status: { options: [{ name: 'Published' }, { name: 'Verify receipt' }] },
  },
  'Publication Next Step': {
    type: 'select',
    select: { options: [{ name: 'Backfill metrics' }, { name: 'Verify receipt' }] },
  },
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

  it('builds a publication-only Published receipt update', () => {
    const properties = buildExternalPublishedProperties(
      resolved,
      {},
      schemaProperties,
      snapshot,
      '2026-08-04T12:00:00.000Z',
    );

    expect(properties).not.toHaveProperty('Image URLs');
    expect(properties).toMatchObject({
      'Publication Status': { status: { name: 'Published' } },
      'Publication Next Step': { select: { name: 'Backfill metrics' } },
      'Rednote Note ID': { rich_text: [{ text: { content: snapshot.noteId } }] },
      'Rednote URL': { url: snapshot.shareUrl },
    });
    expect(properties).not.toHaveProperty('Status');
    expect(properties).not.toHaveProperty('Next action');
    expect(properties).not.toHaveProperty('Publish packet ready');
  });

  it('does not rewrite existing platform tags when updating a matched cross-post', () => {
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
    expect(properties).not.toHaveProperty('Platform');
  });

  it('ignores production Platform alias ambiguity for publication-only updates', () => {
    const aliasedSchema = {
      ...schemaProperties,
      Platforms: { type: 'multi_select' },
    };
    const {
      resolved: aliasedResolved,
      duplicateAliases,
    } = resolvePostsSchema(aliasedSchema);

    expect(aliasedResolved.platform).toBe('Platform');
    expect(duplicateAliases.platform).toEqual(['Platform', 'Platforms']);

    const properties = buildExternalPublishedProperties(
      aliasedResolved,
      duplicateAliases,
      aliasedSchema,
      snapshot,
      '2026-08-04T12:00:00.000Z',
    );

    expect(properties).not.toHaveProperty('Platform');
    expect(properties).not.toHaveProperty('Platforms');
  });

  it('keeps non-platform duplicate aliases strictly ambiguous', () => {
    const aliasedSchema = {
      ...schemaProperties,
      'XHS Note ID': { type: 'rich_text' },
    };
    const {
      resolved: aliasedResolved,
      duplicateAliases,
    } = resolvePostsSchema(aliasedSchema);

    expect(() => buildExternalPublishedProperties(
      aliasedResolved,
      duplicateAliases,
      aliasedSchema,
      snapshot,
      '2026-08-04T12:00:00.000Z',
    )).toThrow('Cannot backfill xhsNoteId: multiple aliases are present');
  });

  it('requires the exact Backfill metrics publication option', () => {
    expect(() => buildExternalPublishedProperties(
      resolved,
      {},
      {
        ...schemaProperties,
        'Publication Next Step': {
          type: 'select',
          select: { options: [{ name: 'Verify receipt' }] },
        },
      },
      snapshot,
      '2026-08-04T12:00:00.000Z',
    )).toThrow('no Backfill metrics option');
  });
});
