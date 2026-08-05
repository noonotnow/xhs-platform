import { describe, expect, it } from 'vitest';
import {
  compareReadyPostsBySchedule,
  getEditorialScheduleDisplay,
  parseEditorialSchedule,
} from '@/lib/editorial-schedule';

function post(
  id: string,
  scheduledDate: string | null,
  overrides: Partial<{
    headline: string;
    lastEditedTime: string;
    publishBlockers: string[];
  }> = {},
) {
  return {
    id,
    scheduledDate,
    headline: overrides.headline ?? id,
    lastEditedTime: overrides.lastEditedTime ?? '2026-08-01T12:00:00.000Z',
    publishBlockers: overrides.publishBlockers ?? [],
  };
}

describe('editorial schedule display', () => {
  it('formats ET and a China next-day time from the same instant', () => {
    expect(getEditorialScheduleDisplay(
      '2026-08-01T15:30:00-04:00',
      new Date('2026-08-01T18:00:00.000Z'),
    )).toMatchObject({
      status: 'upcoming',
      et: 'ET Aug 1, 3:30 PM',
      china: 'China Aug 2, 3:30 AM',
      dateOnly: false,
    });
  });

  it('uses IANA timezone DST rules instead of a fixed ET offset', () => {
    expect(getEditorialScheduleDisplay('2026-01-15T15:00:00-05:00').china)
      .toBe('China Jan 16, 4:00 AM');
    expect(getEditorialScheduleDisplay('2026-07-15T15:00:00-04:00').china)
      .toBe('China Jul 16, 3:00 AM');
  });

  it('keeps legacy dates date-only and assigns advisory day status in ET', () => {
    expect(getEditorialScheduleDisplay(
      '2026-08-01',
      new Date('2026-08-01T16:00:00.000Z'),
    )).toEqual({
      status: 'due',
      statusLabel: 'Due',
      et: 'Aug 1, 2026',
      china: null,
      dateOnly: true,
    });
  });

  it('treats missing, invalid, and offset-free datetimes as unscheduled', () => {
    for (const value of [
      null,
      '',
      'not-a-date',
      '2026-02-30',
      '2026-08-01T15:30:00',
      '2026-02-30T09:30:00-04:00',
      '2026-08-04T24:00:00-04:00',
      '2026-08-04T09:30:00+14:30',
    ]) {
      expect(parseEditorialSchedule(value)).toEqual({ kind: 'unscheduled' });
      expect(getEditorialScheduleDisplay(value).status).toBe('unscheduled');
    }
  });

  it('marks past, imminent, and later instants distinctly', () => {
    const now = new Date('2026-08-01T16:00:00.000Z');
    expect(getEditorialScheduleDisplay('2026-08-01T11:59:00-04:00', now).status)
      .toBe('overdue');
    expect(getEditorialScheduleDisplay('2026-08-01T12:20:00-04:00', now).status)
      .toBe('due');
    expect(getEditorialScheduleDisplay('2026-08-01T13:00:00-04:00', now).status)
      .toBe('upcoming');
  });
});

describe('editorial schedule ordering', () => {
  it('orders full datetimes ascending and places unscheduled posts last', () => {
    const posts = [
      post('missing', null),
      post('later', '2026-08-01T16:00:00-04:00'),
      post('invalid', 'invalid'),
      post('earlier', '2026-08-01T15:30:00-04:00'),
    ];

    expect(posts.sort(compareReadyPostsBySchedule).map(({ id }) => id))
      .toEqual(['earlier', 'later', 'invalid', 'missing']);
  });

  it('keeps actionable posts ahead of earlier blocked posts', () => {
    const posts = [
      post('blocked', '2026-08-01T12:00:00-04:00', {
        publishBlockers: ['Needs media is still checked'],
      }),
      post('actionable', '2026-08-02T12:00:00-04:00'),
    ];

    expect(posts.sort(compareReadyPostsBySchedule).map(({ id }) => id))
      .toEqual(['actionable', 'blocked']);
  });

  it('uses existing last-edited recency and stable identity tie-breakers', () => {
    const sameSchedule = '2026-08-01T15:30:00-04:00';
    const posts = [
      post('b', sameSchedule, { headline: 'Same' }),
      post('older', sameSchedule, {
        headline: 'Same',
        lastEditedTime: '2026-08-01T11:00:00.000Z',
      }),
      post('a', sameSchedule, { headline: 'Same' }),
    ];

    expect(posts.sort(compareReadyPostsBySchedule).map(({ id }) => id))
      .toEqual(['a', 'b', 'older']);
  });
});
