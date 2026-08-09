import { describe, expect, it, vi } from 'vitest';
import { APIErrorCode, APIResponseError, type Client } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import {
  buildReadyPostCandidatesQueryFilter,
  isCanonicalMediaMov,
  isCanonicalMediaVideo,
  buildManualPublishedProperties,
  buildPublicationAwaitingReceiptProperties,
  buildPublishedProperties,
  mapReadyXhsPost,
  normalizeNotionPostsError,
  publishedResultState,
  publishedNextAction,
  queryReadyCandidatePages,
  resolvePostsSchema,
  toReadyPostCandidate,
} from '@/lib/notion-posts';

describe('normalizeNotionPostsError', () => {
  it('turns inaccessible database responses into a recoverable service error', () => {
    const error = new APIResponseError({
      code: APIErrorCode.ObjectNotFound,
      status: 404,
      message: 'Could not find database',
      headers: new Headers(),
      rawBodyText: '{}',
    });

    expect(normalizeNotionPostsError(error)).toMatchObject({
      message:
        'The configured Notion integration cannot access the Posts database. ' +
        'Reconnect the database to the integration, then refresh.',
      code: 'NOTION_DATABASE_UNAVAILABLE',
      status: 503,
    });
  });
});

describe('buildReadyPostCandidatesQueryFilter', () => {
  it('combines packet-ready and rich-text MOV candidate filters', () => {
    expect(buildReadyPostCandidatesQueryFilter(
      'Publish packet ready',
      'checkbox',
      'Image URLs',
      'rich_text',
    )).toEqual({
      or: [
        {
          property: 'Publish packet ready',
          checkbox: { equals: true },
        },
        {
          property: 'Image URLs',
          rich_text: { contains: '.mov' },
        },
      ],
    });
  });

  it('uses a bounded client-side candidate scan for incompatible schema variants', () => {
    expect(buildReadyPostCandidatesQueryFilter(
      'Publish packet ready',
      'formula',
      'Image URLs',
      'rich_text',
    )).toBeUndefined();
    expect(buildReadyPostCandidatesQueryFilter(
      'Publish packet ready',
      'checkbox',
      'Images',
      'files',
    )).toBeUndefined();
    expect(buildReadyPostCandidatesQueryFilter(
      null,
      undefined,
      null,
      undefined,
    )).toBeUndefined();
  });
});

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
      Caption: {
        id: 'caption',
        type: 'rich_text',
        rich_text: richText('Hot take: the BTS is often the best part of the drama.'),
      },
      'Final Tags': {
        id: 'final-tags',
        type: 'multi_select',
        multi_select: [
          { id: 'bts', name: 'BTS', color: 'purple' },
          { id: 'behind-the-scenes', name: 'BehindTheScenes', color: 'blue' },
        ],
      },
      ScheduledDate: {
        id: 'scheduled-date',
        type: 'date',
        date: {
          start: '2026-08-04T09:30:00-04:00',
          end: null,
          time_zone: null,
        },
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
      'Publication Status': {
        id: 'publication-status',
        type: 'status',
        status: { id: 'not-attempted', name: 'Not attempted', color: 'gray' },
      },
      'Publication Next Step': {
        id: 'publication-next-step',
        type: 'select',
        select: { id: 'verify', name: 'Verify receipt', color: 'yellow' },
      },
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
  it('includes the exact CREATE MOV state only as a compatibility-trial candidate', () => {
    const fixture = pageFixture();
    fixture.properties.Status = {
      id: 'status',
      type: 'status',
      status: { id: 'in-progress', name: 'In progress', color: 'blue' },
    };
    fixture.properties['Publish packet ready'] = {
      id: 'packet',
      type: 'checkbox',
      checkbox: false,
    };
    fixture.properties['Needs media'] = {
      id: 'needs-media',
      type: 'checkbox',
      checkbox: true,
    };
    fixture.properties.ScheduledDate = {
      id: 'scheduled-date',
      type: 'date',
      date: {
        start: '2026-08-07T10:30:00-04:00',
        end: null,
        time_zone: null,
      },
    };
    fixture.properties['Image URLs'] = {
      id: 'media',
      type: 'rich_text',
      rich_text: richText(
        'https://images.xhs.justlikekatie.com/videos/assets/51/live-trial.mov',
      ),
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    const post = toReadyPostCandidate(fixture, resolved, duplicateAliases);
    expect(post).toMatchObject({
      candidateKind: 'mov_compatibility_trial',
      status: 'In progress',
      publishPacketReady: false,
      hasVideo: true,
      needsMedia: true,
      needsCaption: false,
      compatibilityTrialVideoUrls: [
        'https://images.xhs.justlikekatie.com/videos/assets/51/live-trial.mov',
      ],
      publishBlockers: [
        'Publish packet is not ready',
        'Needs media is still checked',
        'No canonical HTTPS Rednote media is attached',
        'MOV media requires the CapCut compatibility workflow',
      ],
    });
    expect(post).toHaveProperty('publishAt', '2026-08-07T14:30:00.000Z');
  });

  it('keeps a MOV trial visible when Image URLs also contains a distinct JPG cover', () => {
    const fixture = pageFixture();
    fixture.id = '51716941-afcc-4e51-90cf-45e21246d97d';
    fixture.properties['Publish packet ready'] = {
      id: 'packet',
      type: 'checkbox',
      checkbox: false,
    };
    fixture.properties['Needs media'] = {
      id: 'needs-media',
      type: 'checkbox',
      checkbox: true,
    };
    fixture.properties.ScheduledDate = {
      id: 'scheduled-date',
      type: 'date',
      date: {
        start: '2026-08-07T10:30:00-04:00',
        end: null,
        time_zone: null,
      },
    };
    fixture.properties['Image URLs'] = {
      id: 'media',
      type: 'rich_text',
      rich_text: richText([
        'https://images.xhs.justlikekatie.com/videos/assets/51/live-trial.mov',
        'https://images.xhs.justlikekatie.com/uploads/live-trial-cover.jpg',
      ].join('\n')),
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(toReadyPostCandidate(fixture, resolved, duplicateAliases)).toMatchObject({
      id: '51716941-afcc-4e51-90cf-45e21246d97d',
      candidateKind: 'mov_compatibility_trial',
      imageUrls: [
        'https://images.xhs.justlikekatie.com/uploads/live-trial-cover.jpg',
      ],
      compatibilityTrialVideoUrls: [
        'https://images.xhs.justlikekatie.com/videos/assets/51/live-trial.mov',
      ],
      publishBlockers: [
        'Publish packet is not ready',
        'Needs media is still checked',
        'No canonical HTTPS Rednote media is attached',
        'MOV media requires the CapCut compatibility workflow',
      ],
    });

    fixture.properties['Has video'] = {
      id: 'has-video',
      type: 'checkbox',
      checkbox: false,
    };
    expect(toReadyPostCandidate(fixture, resolved, duplicateAliases)).toMatchObject({
      candidateKind: 'active_unpublished',
      publishBlockers: expect.arrayContaining([
        'Publish packet is not ready',
        'Needs media is still checked',
      ]),
    });

    fixture.properties['Has video'] = {
      id: 'has-video',
      type: 'checkbox',
      checkbox: true,
    };
    fixture.properties['Image URLs'] = {
      id: 'media',
      type: 'rich_text',
      rich_text: richText([
        'https://images.xhs.justlikekatie.com/videos/assets/51/live-trial.mov',
        'https://images.xhs.justlikekatie.com/videos/assets/51/certified.mp4',
        'https://images.xhs.justlikekatie.com/uploads/live-trial-cover.jpg',
      ].join('\n')),
    };
    expect(toReadyPostCandidate(fixture, resolved, duplicateAliases)).toMatchObject({
      candidateKind: 'active_unpublished',
      publishPacketReady: false,
    });
  });

  it('keeps incomplete packet-false records visible without making them approvable', () => {
    const fixture = pageFixture();
    fixture.properties['Publish packet ready'] = {
      id: 'packet',
      type: 'checkbox',
      checkbox: false,
    };
    const schemaProperties = Object.fromEntries(
      Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
    );
    const { resolved, duplicateAliases } = resolvePostsSchema(schemaProperties);
    expect(toReadyPostCandidate(fixture, resolved, duplicateAliases)).toMatchObject({
      candidateKind: 'active_unpublished',
      publishPacketReady: false,
    });

    fixture.properties['Image URLs'] = {
      id: 'media',
      type: 'rich_text',
      rich_text: richText(
        'https://images.xhs.justlikekatie.com/videos/assets/51/trial.mov',
      ),
    };
    fixture.properties['Needs media'] = {
      id: 'needs-media',
      type: 'checkbox',
      checkbox: true,
    };
    fixture.properties['Needs caption'] = {
      id: 'needs-caption',
      type: 'checkbox',
      checkbox: true,
    };
    expect(toReadyPostCandidate(fixture, resolved, duplicateAliases)).toMatchObject({
      candidateKind: 'active_unpublished',
      publishBlockers: expect.arrayContaining(['Needs caption is still checked']),
    });
  });

  it('keeps ambiguous MOV records visible for manual handling without enabling the trial', () => {
    const fixture = pageFixture();
    fixture.properties['Publish packet ready'] = {
      id: 'packet',
      type: 'checkbox',
      checkbox: false,
    };
    fixture.properties['Needs media'] = {
      id: 'needs-media',
      type: 'checkbox',
      checkbox: true,
    };
    fixture.properties['Image URLs'] = {
      id: 'media',
      type: 'rich_text',
      rich_text: richText(
        'https://images.xhs.justlikekatie.com/videos/assets/51/trial.mov',
      ),
    };
    const schemaProperties = Object.fromEntries(
      Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
    );
    const { resolved } = resolvePostsSchema(schemaProperties);

    expect(toReadyPostCandidate(
      fixture,
      { ...resolved, publishPacketReady: null },
      {},
    )).toMatchObject({ candidateKind: 'active_unpublished' });
    expect(toReadyPostCandidate(
      fixture,
      resolved,
      { publishPacketReady: ['Publish packet ready', 'Packet ready'] },
    )).toMatchObject({ candidateKind: 'active_unpublished' });
  });

  it('keeps packet-ready unpublished Rednote records in normal readiness semantics', () => {
    const fixture = pageFixture();
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );
    expect(toReadyPostCandidate(fixture, resolved, duplicateAliases)).toMatchObject({
      candidateKind: 'packet_ready',
      publishPacketReady: true,
      publishBlockers: [],
    });
  });

  it('does not treat CREATE Status as publication authority', () => {
    const fixture = pageFixture();
    fixture.properties.Status = {
      id: 'status',
      type: 'status',
      status: { id: 'published', name: 'Published', color: 'green' },
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(toReadyPostCandidate(fixture, resolved, duplicateAliases)).toMatchObject({
      candidateKind: 'packet_ready',
      publishPacketReady: true,
    });
    fixture.properties['Publication Status'] = {
      id: 'publication-status',
      type: 'status',
      status: { id: 'published', name: 'Published', color: 'green' },
    };
    expect(toReadyPostCandidate(fixture, resolved, duplicateAliases)).toBeNull();
    expect(toReadyPostCandidate(fixture, resolved, duplicateAliases, true))
      .toMatchObject({ candidateKind: 'packet_ready' });
  });

  it('requires canonical primary media for the declared packet type', () => {
    const videoWithCoverOnly = pageFixture();
    videoWithCoverOnly.properties['Image URLs'] = {
      id: 'media',
      type: 'rich_text',
      rich_text: richText(
        'https://images.xhs.justlikekatie.com/uploads/video-cover.jpg',
      ),
    };
    const imageWithVideoOnly = pageFixture();
    imageWithVideoOnly.properties['Has video'] = {
      id: 'has-video',
      type: 'checkbox',
      checkbox: false,
    };
    const imageWithImage = pageFixture();
    imageWithImage.properties['Has video'] = {
      id: 'has-video',
      type: 'checkbox',
      checkbox: false,
    };
    imageWithImage.properties['Image URLs'] = {
      id: 'media',
      type: 'rich_text',
      rich_text: richText(
        'https://images.xhs.justlikekatie.com/uploads/image-post.jpg',
      ),
    };
    const schemaProperties = Object.fromEntries(
      Object.entries(videoWithCoverOnly.properties)
        .map(([name, value]) => [name, { type: value.type }]),
    );
    const { resolved, duplicateAliases } = resolvePostsSchema(schemaProperties);

    expect(mapReadyXhsPost(
      videoWithCoverOnly,
      resolved,
      duplicateAliases,
    ).publishBlockers).toContain('No canonical HTTPS Rednote media is attached');
    expect(mapReadyXhsPost(
      imageWithVideoOnly,
      resolved,
      duplicateAliases,
    ).publishBlockers).toContain('No canonical HTTPS Rednote media is attached');
    expect(mapReadyXhsPost(
      imageWithImage,
      resolved,
      duplicateAliases,
    ).publishBlockers).not.toContain('No canonical HTTPS Rednote media is attached');

    const schemaWithoutHasVideo = { ...resolved, hasVideo: null };
    expect(mapReadyXhsPost(
      pageFixture(),
      schemaWithoutHasVideo,
      duplicateAliases,
    ).publishBlockers).not.toContain('No canonical HTTPS Rednote media is attached');
  });

  it('separates canonical MEDIA MOV registrations from certified MP4 videos', () => {
    const fixture = pageFixture();
    fixture.properties['Image URLs'] = {
      id: 'media',
      type: 'rich_text',
      rich_text: richText(
        'https://images.xhs.justlikekatie.com/videos/assets/6c/trial.mov',
      ),
    };
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
    const post = mapReadyXhsPost(fixture, resolved, duplicateAliases);

    expect(isCanonicalMediaMov(post.mediaUrls[0])).toBe(true);
    expect(isCanonicalMediaVideo(post.mediaUrls[0])).toBe(false);
    expect(post.videoUrls).toEqual([]);
    expect(post.compatibilityTrialVideoUrls).toEqual([post.mediaUrls[0]]);
    expect(post.publishBlockers).toEqual([
      'Needs media is still checked',
      'No canonical HTTPS Rednote media is attached',
      'MOV media requires the CapCut compatibility workflow',
    ]);
  });

  describe('queryReadyCandidatePages', () => {
    const schema = {
      headline: 'Headline',
      platform: 'Platform',
      status: 'Status',
      productionNextStep: null,
      publicationStatus: 'Publication Status',
      publicationNextStep: 'Publication Next Step',
      thumbnail: 'Thumbnail',
      mediaUrls: 'Image URLs',
      caption: 'Caption',
      publishPacketReady: 'Publish packet ready',
      hasVideo: 'Has video',
      needsMedia: 'Needs media',
      needsCaption: 'Needs caption',
      tags: 'Final Tags',
      xhsNoteId: 'Rednote Note ID',
      xhsShareUrl: 'Rednote URL',
      publishedAt: null,
      nextAction: 'Next action',
      scheduledDate: 'ScheduledDate',
    } as const;

    it('queries a bounded active-record set without any Notion mutation', async () => {
      const query = vi.fn().mockResolvedValue({ results: [], has_more: false });
      const update = vi.fn();
      const client = { databases: { query }, pages: { update } } as unknown as Client;

      await expect(queryReadyCandidatePages(client, schema, {
        'Publish packet ready': { type: 'checkbox' },
        'Image URLs': { type: 'rich_text' },
        Status: { type: 'status' },
        'Publication Status': { type: 'status' },
      }, 'database')).resolves.toEqual([]);

      expect(query).toHaveBeenCalledWith(expect.objectContaining({
        database_id: 'database',
        page_size: 100,
      }));
      expect(query.mock.calls[0][0]).toMatchObject({
        filter: {
          property: 'Publication Status',
          status: { does_not_equal: 'Published' },
        },
      });
      expect(update).not.toHaveBeenCalled();
    });

    it('includes only candidate-shaped Published rows for batch reporting', async () => {
      const query = vi.fn().mockResolvedValue({ results: [], has_more: false });
      const client = { databases: { query } } as unknown as Client;

      await queryReadyCandidatePages(client, schema, {
        'Publish packet ready': { type: 'checkbox' },
        'Image URLs': { type: 'rich_text' },
        Status: { type: 'status' },
        'Publication Status': { type: 'status' },
      }, 'database', true);

      expect(query.mock.calls[0][0]).toMatchObject({
        filter: {
          or: [
            {
              property: 'Publication Status',
              status: { does_not_equal: 'Published' },
            },
            {
              and: [
                {
                  property: 'Publication Status',
                  status: { equals: 'Published' },
                },
                {
                  property: 'Publish packet ready',
                  checkbox: { equals: true },
                },
              ],
            },
            {
              and: [
                {
                  property: 'Publication Status',
                  status: { equals: 'Published' },
                },
                {
                  property: 'Image URLs',
                  rich_text: { contains: '.mov' },
                },
              ],
            },
          ],
        },
      });
    });

    it('fails explicitly when a fallback scan exceeds its safe cap', async () => {
      const query = vi.fn().mockResolvedValue({ results: [], has_more: true });
      const client = { databases: { query } } as unknown as Client;

      await expect(queryReadyCandidatePages(client, schema, {
        'Publish packet ready': { type: 'formula' },
        'Image URLs': { type: 'files' },
      }, 'database')).rejects.toMatchObject({
        code: 'READY_POSTS_LIMIT_EXCEEDED',
        status: 503,
      });
      expect(query).toHaveBeenCalledWith(expect.not.objectContaining({ filter: expect.anything() }));
    });
  });

  it('uses CREATE canonical aliases and exposes a publishable MEDIA video', () => {
    const fixture = pageFixture();
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(resolved.xhsShareUrl).toBe('Rednote URL');
    expect(resolved.xhsNoteId).toBe('Rednote Note ID');
    expect(resolved.tags).toBe('Final Tags');
    expect(resolved.caption).toBe('Caption');
    expect(resolved.scheduledDate).toBe('ScheduledDate');
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
      tags: ['BTS', 'BehindTheScenes'],
      tagsSource: 'final-tags',
      scheduledDate: '2026-08-04T09:30:00-04:00',
      publishAt: '2026-08-04T13:30:00.000Z',
      publishBlockers: [],
    });
  });

  it('preserves a legacy date-only ScheduledDate without inventing a time', () => {
    const fixture = pageFixture();
    fixture.properties.ScheduledDate = {
      id: 'scheduled-date',
      type: 'date',
      date: { start: '2026-08-04', end: null, time_zone: null },
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(mapReadyXhsPost(fixture, resolved, duplicateAliases).scheduledDate).toBe('2026-08-04');
  });

  it('prefers Caption over temporary legacy aliases', () => {
    const fixture = pageFixture();
    fixture.properties['Caption text'] = {
      id: 'caption-text',
      type: 'rich_text',
      rich_text: richText('Caption text fallback'),
    };
    fixture.properties['Weibo text'] = {
      id: 'weibo-text',
      type: 'rich_text',
      rich_text: richText('Weibo text fallback'),
    };
    fixture.properties['Weibo Text'] = {
      id: 'weibo-text-case',
      type: 'rich_text',
      rich_text: richText('Weibo Text fallback'),
    };
    fixture.properties.Weibo = {
      id: 'weibo',
      type: 'rich_text',
      rich_text: richText('Weibo fallback'),
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(resolved.caption).toBe('Caption');
    expect(duplicateAliases.caption).toEqual([
      'Caption',
      'Caption text',
      'Weibo text',
      'Weibo Text',
      'Weibo',
    ]);
    expect(mapReadyXhsPost(fixture, resolved, duplicateAliases).caption).toBe(
      'Hot take: the BTS is often the best part of the drama.',
    );
  });

  it.each([
    ['Caption text', 'Caption text fallback'],
    ['Weibo text', 'Weibo text fallback'],
    ['Weibo Text', 'Weibo Text fallback'],
    ['Weibo', 'Weibo fallback'],
  ])('reads the temporary %s alias when Caption is absent', (alias, copy) => {
    const fixture = pageFixture();
    delete fixture.properties.Caption;
    fixture.properties[alias] = {
      id: 'legacy-caption',
      type: 'rich_text',
      rich_text: richText(copy),
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(resolved.caption).toBe(alias);
    expect(mapReadyXhsPost(fixture, resolved, duplicateAliases).caption).toBe(copy);
  });

  it('keeps an empty Caption behind the existing publish gate', () => {
    const fixture = pageFixture();
    fixture.properties.Caption = {
      id: 'caption',
      type: 'rich_text',
      rich_text: [],
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(mapReadyXhsPost(fixture, resolved, duplicateAliases).publishBlockers)
      .toContain('Caption is empty');
  });

  it('reports a missing cover as a manual warning without making it an automation blocker', () => {
    const fixture = pageFixture();
    delete fixture.properties.Thumbnail;
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    const post = mapReadyXhsPost(fixture, resolved, duplicateAliases);
    expect(post.manualWarnings).toContain('Cover thumbnail is missing');
    expect(post.automationBlockers).not.toContain('Cover thumbnail is missing');
  });

  it('uses only trailing Caption hashtags as an explicit legacy tags fallback', () => {
    const fixture = pageFixture();
    delete fixture.properties['Final Tags'];
    fixture.properties.Caption = {
      id: 'caption',
      type: 'rich_text',
      rich_text: richText('Keep #inline in the body.\n\n#Legacy #旧标签'),
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(mapReadyXhsPost(fixture, resolved, duplicateAliases)).toMatchObject({
      caption: 'Keep #inline in the body.',
      tags: ['Legacy', '旧标签'],
      tagsSource: 'legacy-caption',
    });
  });

  it('uses the legacy caption fallback when Final Tags is an empty multi-select', () => {
    const fixture = pageFixture();
    fixture.properties['Final Tags'] = {
      id: 'final-tags',
      type: 'multi_select',
      multi_select: [],
    };
    delete fixture.properties.Caption;
    fixture.properties['Weibo text'] = {
      id: 'caption',
      type: 'rich_text',
      rich_text: richText('Legacy body\n\n#Legacy'),
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(mapReadyXhsPost(fixture, resolved, duplicateAliases)).toMatchObject({
      caption: 'Legacy body',
      tags: ['Legacy'],
      tagsSource: 'legacy-caption',
    });
  });

  it('does not strip trailing hashtags when Final Tags is populated', () => {
    const fixture = pageFixture();
    fixture.properties.Caption = {
      id: 'caption',
      type: 'rich_text',
      rich_text: richText('Canonical body #stays'),
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(mapReadyXhsPost(fixture, resolved, duplicateAliases)).toMatchObject({
      caption: 'Canonical body #stays',
      tags: ['BTS', 'BehindTheScenes'],
      tagsSource: 'final-tags',
    });
  });

  it('does not parse a rich-text Final Tags value as a tag list', () => {
    const fixture = pageFixture();
    fixture.properties['Final Tags'] = {
      id: 'final-tags',
      type: 'rich_text',
      rich_text: richText('New Tag, Another Tag'),
    };
    fixture.properties.Caption = {
      id: 'caption',
      type: 'rich_text',
      rich_text: richText('Legacy body\n\n#Legacy #Fallback'),
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );

    expect(mapReadyXhsPost(fixture, resolved, duplicateAliases)).toMatchObject({
      caption: 'Legacy body',
      tags: ['Legacy', 'Fallback'],
      tagsSource: 'legacy-caption',
    });
  });

  it('fails closed when ScheduledDate lacks a publish time and timezone', () => {
    const fixture = pageFixture();
    fixture.properties.ScheduledDate = {
      id: 'scheduled-date',
      type: 'date',
      date: { start: '2026-08-04', end: null, time_zone: null },
    };
    const { resolved, duplicateAliases } = resolvePostsSchema(
      Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
      ),
    );
    const post = mapReadyXhsPost(fixture, resolved, duplicateAliases);

    expect(post.publishAt).toBeUndefined();
    expect(post.publishBlockers).toContain(
      'ScheduledDate must include a valid publish time and timezone',
    );
  });

  it('rejects calendar and time rollover instead of changing the intended instant', () => {
    const invalidValues = [
      '2026-02-30T09:30:00-04:00',
      '2026-08-04T24:00:00-04:00',
      '2026-08-04T09:60:00-04:00',
      '2026-08-04T09:30:00+14:30',
    ];
    for (const start of invalidValues) {
      const fixture = pageFixture();
      fixture.properties.ScheduledDate = {
        id: 'scheduled-date',
        type: 'date',
        date: { start, end: null, time_zone: null },
      };
      const { resolved, duplicateAliases } = resolvePostsSchema(
        Object.fromEntries(
          Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
        ),
      );
      expect(mapReadyXhsPost(fixture, resolved, duplicateAliases).publishBlockers)
        .toContain('ScheduledDate must include a valid publish time and timezone');
    }
  });

  it('does not use legacy tag or scheduling properties as canonical sources', () => {
    const { resolved } = resolvePostsSchema({
      Tags: { type: 'multi_select' },
      Topics: { type: 'multi_select' },
      'Publish Date': { type: 'date' },
      'Scheduled Date': { type: 'date' },
    });
    expect(resolved.tags).toBeNull();
    expect(resolved.scheduledDate).toBeNull();
  });

  it('builds the exact confirmed-success backfill using existing property types', () => {
      const fixture = pageFixture();
      fixture.properties['Publish packet ready'] = {
        id: 'packet',
        type: 'checkbox',
        checkbox: false,
      };
      fixture.properties['Needs media'] = {
        id: 'needs-media',
        type: 'checkbox',
        checkbox: true,
      };
      fixture.properties['Needs caption'] = {
        id: 'needs-caption',
        type: 'checkbox',
        checkbox: true,
      };
      fixture.properties['Published At'] = {
        id: 'published-at',
        type: 'date',
        date: null,
      };
      const schemaProperties = Object.fromEntries(
        Object.entries(fixture.properties).map(([name, value]) => {
          if (name === 'Publication Status') {
            return [name, {
              type: value.type,
              status: {
                options: [
                  { name: 'Not attempted' },
                  { name: 'Verify receipt' },
                  { name: 'Published' },
                ],
              },
            }];
          }
          if (name === 'Publication Next Step') {
            return [name, {
              type: value.type,
              select: {
                options: [
                  { name: 'Verify receipt' },
                  { name: 'Backfill metrics' },
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
          shareUrl: 'https://www.xiaohongshu.com/explore/note-123?source=creator',
        },
        '2026-07-31T20:00:00.000Z',
      )).toEqual({
        'Publication Status': { status: { name: 'Published' } },
        'Publication Next Step': { select: { name: 'Backfill metrics' } },
        'Rednote URL': { url: 'https://www.rednote.com/explore/note-123' },
        'Rednote Note ID': {
          rich_text: [{ type: 'text', text: { content: 'note-123' } }],
        },
        'Published At': { date: { start: '2026-07-31T20:00:00.000Z' } },
      });

      expect(buildPublishedProperties(
        fixture,
        resolved,
        duplicateAliases,
        schemaProperties,
        {
          status: 'success',
          noteId: 'note-123',
          shareUrl: 'https://www.rednote.com/explore/note-123',
        },
        '2026-07-31T20:00:00.000Z',
      )).not.toHaveProperty('ScheduledDate');
  });

  it('backfills a manual receipt without rewriting packet, media, or copy truth', () => {
    const fixture = pageFixture();
    fixture.properties.Platform = {
      id: 'platform',
      type: 'multi_select',
      multi_select: [{ id: 'instagram', name: 'Instagram', color: 'pink' }],
    };
    fixture.properties['Published At'] = {
      id: 'published-at',
      type: 'date',
      date: null,
    };
    const schemaProperties = Object.fromEntries(
      Object.entries(fixture.properties).map(([name, value]) => [
        name,
        name === 'Publication Status'
          ? {
              type: value.type,
              status: { options: [{ name: 'Published' }] },
            }
          : name === 'Publication Next Step'
          ? {
              type: value.type,
              select: { options: [{ name: 'Backfill metrics' }] },
            }
          : { type: value.type },
      ]),
    );
    const { resolved, duplicateAliases } = resolvePostsSchema(schemaProperties);
    const properties = buildManualPublishedProperties(
      resolved,
      duplicateAliases,
      schemaProperties,
      {
        noteId: 'note-123',
        shareUrl: 'https://www.rednote.com/explore/note-123',
        title: 'Observed title',
        caption: 'Observed caption',
        mediaType: 'video',
      },
      '2026-08-06T20:00:00.000Z',
      fixture,
    );

    expect(properties).toMatchObject({
      'Publication Status': { status: { name: 'Published' } },
      'Publication Next Step': { select: { name: 'Backfill metrics' } },
      'Rednote URL': { url: 'https://www.rednote.com/explore/note-123' },
      'Published At': { date: { start: '2026-08-06T20:00:00.000Z' } },
    });
    expect(properties).not.toHaveProperty('Platform');
    expect(properties).not.toHaveProperty('Status');
    expect(properties).not.toHaveProperty('Next action');
    expect(properties).not.toHaveProperty('Caption');
    expect(properties).not.toHaveProperty('Publish packet ready');
    expect(properties).not.toHaveProperty('Needs media');
    expect(properties).not.toHaveProperty('Needs caption');
    expect(properties).not.toHaveProperty('Image URLs');
  });

  it('marks unresolved operator evidence with only publication reconciliation fields', () => {
    const fixture = pageFixture();
    const schemaProperties = Object.fromEntries(
      Object.entries(fixture.properties).map(([name, value]) => [
        name,
        name === 'Publication Status'
          ? {
              type: value.type,
              status: { options: [{ name: 'Verify receipt' }, { name: 'Published' }] },
            }
          : name === 'Publication Next Step'
            ? {
                type: value.type,
                select: { options: [{ name: 'Verify receipt' }, { name: 'Backfill metrics' }] },
              }
            : { type: value.type },
      ]),
    );
    const { resolved, duplicateAliases } = resolvePostsSchema(schemaProperties);

    expect(buildPublicationAwaitingReceiptProperties(
      fixture,
      resolved,
      duplicateAliases,
      schemaProperties,
    )).toEqual({
      'Publication Status': { status: { name: 'Verify receipt' } },
      'Publication Next Step': { select: { name: 'Verify receipt' } },
    });
  });

  it('recognizes an identical published result without rewriting published metadata', () => {
        const fixture = pageFixture();
        fixture.properties['Publication Status'] = {
          id: 'publication-status',
          type: 'status',
          status: { id: 'published', name: 'Published', color: 'green' },
        };
        fixture.properties['Rednote URL'] = {
          id: 'share',
          type: 'url',
          url: 'https://www.rednote.com/explore/note-123',
        };
        fixture.properties['Rednote Note ID'] = {
          id: 'note-id',
          type: 'rich_text',
          rich_text: richText('note-123'),
        };
        fixture.properties['Publication Next Step'] = {
          id: 'publication-next-step',
          type: 'select',
          select: {
            id: 'backfill',
            name: 'Backfill metrics',
            color: 'blue',
          },
        };
        const { resolved, duplicateAliases } = resolvePostsSchema(
          Object.fromEntries(
            Object.entries(fixture.properties).map(([name, value]) => [name, { type: value.type }]),
          ),
        );

        expect(publishedResultState(fixture, resolved, duplicateAliases, {
          status: 'success',
          noteId: 'note-123',
          shareUrl: 'https://www.rednote.com/explore/note-123',
        })).toBe('match');
        fixture.properties['Rednote URL'] = {
          id: 'share',
          type: 'url',
          url: 'https://www.xiaohongshu.com/explore/note-123?source=legacy',
        };
        expect(publishedResultState(fixture, resolved, duplicateAliases, {
          status: 'success',
          noteId: 'note-123',
          shareUrl: 'https://www.rednote.com/explore/note-123',
        })).toBe('unpublished');
        fixture.properties['Rednote URL'] = {
          id: 'share',
          type: 'url',
          url: null,
        };
        fixture.properties['Rednote Note ID'] = {
          id: 'note-id',
          type: 'rich_text',
          rich_text: [],
        };
        expect(publishedResultState(fixture, resolved, duplicateAliases, {
          status: 'success',
          noteId: 'note-123',
          shareUrl: 'https://www.rednote.com/explore/note-123',
        })).toBe('unpublished');
        fixture.properties['Rednote URL'] = {
          id: 'share',
          type: 'url',
          url: 'https://www.rednote.com/explore/note-123',
        };
        fixture.properties['Rednote Note ID'] = {
          id: 'note-id',
          type: 'rich_text',
          rich_text: richText('note-123'),
        };
        expect(publishedResultState(fixture, resolved, duplicateAliases, {
          status: 'success',
          noteId: 'different-note',
          shareUrl: 'https://www.rednote.com/explore/different-note',
        })).toBe('conflict');
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

  it('always routes a verified receipt to Backfill metrics', () => {
    const fixture = pageFixture();
    fixture.properties['Publication Next Step'] = {
      id: 'publication-next-step',
      type: 'select',
      select: { id: 'verify', name: 'Verify receipt', color: 'gray' },
    };
    const schemaProperties = Object.fromEntries(
      Object.entries(fixture.properties).map(([name, value]) => [
        name,
        name === 'Publication Status'
          ? {
              type: value.type,
              status: { options: [{ name: 'Published' }] },
            }
          : name === 'Publication Next Step'
          ? {
              type: value.type,
              select: {
                options: [
                  { name: 'Backfill metrics' },
                  { name: 'Verify receipt' },
                ],
              },
            }
          : { type: value.type },
      ]),
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
        shareUrl: 'https://www.rednote.com/explore/note-123',
      },
      '2026-07-31T20:00:00.000Z',
    )).toMatchObject({
      'Publication Next Step': { select: { name: 'Backfill metrics' } },
    });
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
