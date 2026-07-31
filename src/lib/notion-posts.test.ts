import { describe, expect, it } from 'vitest';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import {
  isCanonicalMediaVideo,
  buildPublishedProperties,
  mapReadyXhsPost,
  publishedNextAction,
  resolvePostsSchema,
} from '@/lib/notion-posts';

function richText(content: string) {
  return [{
    type: 'text' as const,
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default' as const,
    },
    plain_text: content,
    href: null,
  }];
}

function pageFixture(): PageObjectResponse {
  return {
    object: 'page',
    id: '11111111-1111-1111-1111-111111111111',
    created_time: '2026-07-31T00:00:00.000Z',
    last_edited_time: '2026-07-31T01:00:00.000Z',
    created_by: { object: 'user', id: 'user' },
    last_edited_by: { object: 'user', id: 'user' },
    cover: null,
    icon: null,
    parent: { type: 'database_id', database_id: 'database' },
    archived: false,
    in_trash: false,
    properties: {
      Headline: {
        id: 'title',
        type: 'title',
        title: richText('Hot take: BTS is often the best part of the drama'),
      },
      Platform: {
        id: 'platform',
        type: 'multi_select',
        multi_select: [{ id: 'rednote', name: 'Rednote', color: 'red' }],
      },
      Status: {
        id: 'status',
        type: 'status',
        status: { id: 'ready', name: 'Ready', color: 'green' },
      },
      'Weibo text': {
        id: 'caption',
        type: 'rich_text',
        rich_text: richText('Hot take: the BTS is often the best part of the drama.'),
      },
      'Publish packet ready': { id: 'packet', type: 'checkbox', checkbox: true },
      'Has video': { id: 'has-video', type: 'checkbox', checkbox: true },
      'Needs media': { id: 'needs-media', type: 'checkbox', checkbox: false },
      'Needs caption': { id: 'needs-caption', type: 'checkbox', checkbox: false },
      'Image URLs': {
        id: 'media',
        type: 'rich_text',
        rich_text: richText(
          'https://images.xhs.justlikekatie.com/videos/assets/6c/6ca0927b-66ef-4a90-8c6d-39f9e6db903b.mp4',
        ),
      },
      Thumbnail: {
        id: 'thumb',
        type: 'url',
        url: 'https://images.xhs.justlikekatie.com/thumb.jpg',
      },
      Series: {
        id: 'series',
        type: 'multi_select',
        multi_select: [{ id: 'bts', name: 'BTS', color: 'purple' }],
      },
      'Rednote URL': { id: 'share', type: 'url', url: null },
      'Rednote Note ID': { id: 'note-id', type: 'rich_text', rich_text: [] },
      'Next action': {
        id: 'next',
        type: 'select',
        select: { id: 'review', name: 'Review packet', color: 'yellow' },
      },
    },
    url: 'https://notion.so/ready-micropost',
    public_url: null,
  };
}

describe('Notion Posts mapping', () => {
  it('uses CREATE canonical aliases and exposes a publishable MEDIA video', () => {
    const fixture = pageFixture();
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(resolved.xhsShareUrl).toBe('Rednote URL');
    expect(resolved.xhsNoteId).toBe('Rednote Note ID');
    expect(mapReadyXhsPost(fixture, resolved, duplicateAliases)).toMatchObject({
      headline: 'Hot take: BTS is often the best part of the drama',
      caption: 'Hot take: the BTS is often the best part of the drama.',
      status: 'Ready',
      publishPacketReady: true,
      hasVideo: true,
      needsMedia: false,
      needsCaption: false,
      videoUrls: [
        'https://images.xhs.justlikekatie.com/videos/assets/6c/6ca0927b-66ef-4a90-8c6d-39f9e6db903b.mp4',
      ],
      tags: ['BTS'],
      publishBlockers: [],
    });
  });

  it('builds the exact confirmed-success backfill using existing property types', () => {
      const fixture = pageFixture();
      const schemaProperties = Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => {
          if (name === 'Next action') {
            return [name, {
              type: value.type,
              select: {
                options: [
                  { name: 'Attach media' },
                  { name: 'Write caption' },
                  { name: 'Review packet' },
                  { name: 'Paste to XHS admin' },
                  { name: 'Backfill URL/metrics' },
                  { name: 'No action' },
                ],
              },
            }];
          }
          return [name, { type: value.type }];
        }),
      );
      const { resolved, duplicateAliases } = resolvePostsSchema(schemaProperties);

      expect(buildPublishedProperties(
        fixture,
        resolved,
        duplicateAliases,
        schemaProperties,
        {
          status: 'success',
          noteId: 'note-123',
          shareUrl: 'https://www.xiaohongshu.com/explore/note-123',
        },
        '2026-07-31T20:00:00.000Z',
      )).toEqual({
        Status: { status: { name: 'Published' } },
        'Rednote URL': { url: 'https://www.xiaohongshu.com/explore/note-123' },
        'Rednote Note ID': {
          rich_text: [{ type: 'text', text: { content: 'note-123' } }],
        },
        'Next action': { select: { name: 'Backfill URL/metrics' } },
      });
  });

  it('blocks the target when any production readiness invariant regresses', () => {
      const fixture = pageFixture();
      fixture.properties['Needs media'] = {
        id: 'needs-media',
        type: 'checkbox',
        checkbox: true,
      };
      const { resolved, duplicateAliases } = resolvePostsSchema(
        Object.fromEntries(
          Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
        ),
      );

      expect(mapReadyXhsPost(fixture, resolved, duplicateAliases).publishBlockers)
        .toContain('Needs media is still checked');
  });

  it('advances only to an established published-state Next action option', () => {
    expect(publishedNextAction({
      'Next action': {
        type: 'select',
        select: { options: [{ name: 'No action' }, { name: 'Backfill URL/metrics' }] },
      },
    }, 'Next action')).toBe('Backfill URL/metrics');
    expect(publishedNextAction({
      'Next action': {
        type: 'select',
        select: { options: [{ name: 'No action' }] },
      },
    }, 'Next action')).toBe('No action');
    expect(publishedNextAction({
      'Next action': {
        type: 'select',
        select: { options: [{ name: 'Review packet' }] },
      },
    }, 'Next action')).toBeNull();
  });

  it('accepts only canonical HTTPS MEDIA asset MP4 URLs', () => {
    expect(isCanonicalMediaVideo(
      'https://images.xhs.justlikekatie.com/videos/assets/micropost.mp4',
    )).toBe(true);
    expect(isCanonicalMediaVideo(
      'https://images.xhs.justlikekatie.com/uploads/micropost.mp4',
    )).toBe(false);
    expect(isCanonicalMediaVideo('https://example.com/videos/assets/micropost.mp4')).toBe(false);
    expect(isCanonicalMediaVideo(
      'http://images.xhs.justlikekatie.com/videos/assets/micropost.mp4',
    )).toBe(false);
  });

  it('blocks publishing when the Posts DB cannot store the returned share URL', () => {
    const fixture = pageFixture();
    delete fixture.properties['Rednote URL'];
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(mapReadyXhsPost(fixture, resolved, duplicateAliases).publishBlockers)
      .toContain('Posts DB has no mapped xhsShareUrl property');
  });
});
