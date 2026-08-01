const OPERATOR_TIME_ZONE = 'America/New_York';
const CHINA_TIME_ZONE = 'Asia/Shanghai';
const DUE_WINDOW_MS = 30 * 60 * 1000;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_DATETIME_PATTERN = /T.*(?:Z|[+-]\d{2}:\d{2})$/i;

export type EditorialScheduleStatus = 'overdue' | 'due' | 'upcoming' | 'unscheduled';

type ParsedEditorialSchedule =
  | { kind: 'date'; date: string }
  | { kind: 'instant'; instantMs: number }
  | { kind: 'unscheduled' };

export interface EditorialScheduleDisplay {
  status: EditorialScheduleStatus;
  statusLabel: string;
  et: string;
  china: string | null;
  dateOnly: boolean;
}

interface SchedulableReadyPost {
  id: string;
  headline: string;
  scheduledDate: string | null;
  lastEditedTime: string;
  publishBlockers: string[];
}

function isValidDateOnly(value: string) {
  if (!DATE_ONLY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseEditorialSchedule(value: string | null | undefined): ParsedEditorialSchedule {
  const normalized = value?.trim();
  if (!normalized) return { kind: 'unscheduled' };
  if (isValidDateOnly(normalized)) return { kind: 'date', date: normalized };
  if (!OFFSET_DATETIME_PATTERN.test(normalized)) return { kind: 'unscheduled' };

  const instantMs = Date.parse(normalized);
  return Number.isNaN(instantMs) ? { kind: 'unscheduled' } : { kind: 'instant', instantMs };
}

function formatDateOnly(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function formatInstant(instantMs: number, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instantMs));
}

function dateInTimeZone(instantMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function statusLabel(status: EditorialScheduleStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function getEditorialScheduleDisplay(
  value: string | null | undefined,
  now = new Date(),
): EditorialScheduleDisplay {
  const schedule = parseEditorialSchedule(value);
  if (schedule.kind === 'unscheduled') {
    return {
      status: 'unscheduled',
      statusLabel: 'Unscheduled',
      et: 'No editorial date',
      china: null,
      dateOnly: false,
    };
  }

  if (schedule.kind === 'date') {
    const operatorToday = dateInTimeZone(now.getTime(), OPERATOR_TIME_ZONE);
    const status = schedule.date < operatorToday
      ? 'overdue'
      : schedule.date === operatorToday
        ? 'due'
        : 'upcoming';
    return {
      status,
      statusLabel: statusLabel(status),
      et: formatDateOnly(schedule.date),
      china: null,
      dateOnly: true,
    };
  }

  const deltaMs = schedule.instantMs - now.getTime();
  const status = deltaMs < 0
    ? 'overdue'
    : deltaMs <= DUE_WINDOW_MS
      ? 'due'
      : 'upcoming';
  return {
    status,
    statusLabel: statusLabel(status),
    et: `ET ${formatInstant(schedule.instantMs, OPERATOR_TIME_ZONE)}`,
    china: `China ${formatInstant(schedule.instantMs, CHINA_TIME_ZONE)}`,
    dateOnly: false,
  };
}

function compareSchedules(
  left: ParsedEditorialSchedule,
  right: ParsedEditorialSchedule,
) {
  if (left.kind === 'unscheduled' || right.kind === 'unscheduled') {
    if (left.kind === right.kind) return 0;
    return left.kind === 'unscheduled' ? 1 : -1;
  }

  if (left.kind === 'instant' && right.kind === 'instant') {
    return left.instantMs - right.instantMs;
  }
  if (left.kind === 'date' && right.kind === 'date') {
    return left.date.localeCompare(right.date);
  }

  const leftDate = left.kind === 'date'
    ? left.date
    : dateInTimeZone(left.instantMs, OPERATOR_TIME_ZONE);
  const rightDate = right.kind === 'date'
    ? right.date
    : dateInTimeZone(right.instantMs, OPERATOR_TIME_ZONE);
  const dateComparison = leftDate.localeCompare(rightDate);
  if (dateComparison !== 0) return dateComparison;
  return left.kind === 'date' ? -1 : 1;
}

export function compareReadyPostsBySchedule(
  left: SchedulableReadyPost,
  right: SchedulableReadyPost,
) {
  const readinessComparison =
    Number(left.publishBlockers.length > 0) - Number(right.publishBlockers.length > 0);
  if (readinessComparison !== 0) return readinessComparison;

  const scheduleComparison = compareSchedules(
    parseEditorialSchedule(left.scheduledDate),
    parseEditorialSchedule(right.scheduledDate),
  );
  if (scheduleComparison !== 0) return scheduleComparison;

  const editedComparison = Date.parse(right.lastEditedTime) - Date.parse(left.lastEditedTime);
  if (!Number.isNaN(editedComparison) && editedComparison !== 0) return editedComparison;

  const headlineComparison = left.headline.localeCompare(right.headline, 'en', {
    sensitivity: 'base',
  });
  return headlineComparison || left.id.localeCompare(right.id);
}
