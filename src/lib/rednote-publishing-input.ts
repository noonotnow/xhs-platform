import { createHash } from 'crypto';
import sharp from 'sharp';
import {
  REDNOTE_BROWSER_PAYLOAD_REVISION,
  REDNOTE_MEDIA_MIME_TYPES,
  REDNOTE_PUBLISHING_CONTRACT_REVISION,
  REDNOTE_TRANSACTION_REQUESTERS,
  type FrozenRednoteAttemptPayload,
  type FrozenRednoteMediaAsset,
  type RednoteMediaMimeType,
  type RednoteAttemptTransactionRequest,
  type RednoteTransactionRequester,
} from '@/lib/rednote-publishing-contract-v1';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const MAX_TEXT = 10_000;
const MAX_TAGS = 20;
const CANONICAL_MEDIA_HOST = 'images.xhs.justlikekatie.com';

export class RednotePublishingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function invalid(message: string, code = 'REDNOTE_VALIDATION_ERROR') {
  return new RednotePublishingError(message, code, 400);
}

function conflict(message: string, code: string) {
  return new RednotePublishingError(message, code, 409);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  const missing = required.filter((key) => !(key in value));
  const extra = keys.filter((key) => !allowed.has(key));
  if (missing.length || extra.length) {
    throw invalid(
      `${field} has invalid keys` +
      `${missing.length ? `; missing ${missing.join(', ')}` : ''}` +
      `${extra.length ? `; unexpected ${extra.join(', ')}` : ''}`,
      'REDNOTE_EXACT_KEYS_REQUIRED',
    );
  }
}

function text(value: unknown, field: string, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw invalid(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function uuid(value: unknown, field: string) {
  const candidate = text(value, field, 64);
  if (!UUID.test(candidate)) throw invalid(`${field} must be a UUID`);
  return candidate.toLowerCase();
}

function instant(value: unknown, field: string) {
  const candidate = text(value, field, 64);
  if (
    !ISO_INSTANT.test(candidate) ||
    Number.isNaN(Date.parse(candidate)) ||
    new Date(candidate).toISOString() !== candidate
  ) {
    throw invalid(`${field} must be a canonical UTC ISO instant`);
  }
  return candidate;
}

function scheduledInstant(value: unknown, field: string) {
  const candidate = text(value, field, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/
      .test(candidate) ||
    Number.isNaN(Date.parse(candidate))
  ) {
    throw invalid(`${field} must be an ISO instant with an explicit timezone`);
  }
  return candidate;
}

function digest(value: unknown, field: string) {
  const candidate = text(value, field, 64);
  if (!SHA256.test(candidate)) {
    throw invalid(`${field} must be a lowercase SHA-256 digest`);
  }
  return candidate;
}

function optionalText(value: unknown, field: string, max = 256) {
  return value === undefined ? undefined : text(value, field, max);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function rednoteStableDigest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

export function normalizeNotionPageId(value: string) {
  const normalized = value.replaceAll('-', '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) {
    throw invalid('Notion page IDs must contain exactly 32 hexadecimal characters');
  }
  return normalized;
}

export function canonicalRednoteAssetId(deliveryUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(deliveryUrl);
  } catch {
    throw invalid('Asset deliveryUrl must be a canonical HTTPS URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== CANONICAL_MEDIA_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.length < 2 ||
    parsed.pathname.includes('//') ||
    /%2f|%5c/i.test(parsed.pathname)
  ) {
    throw invalid(
      `Asset deliveryUrl must be an unambiguous ${CANONICAL_MEDIA_HOST} object URL`,
      'REDNOTE_ASSET_URL_INVALID',
    );
  }
  return parsed.pathname.slice(1);
}

function parseAsset(
  value: unknown,
  field: string,
): FrozenRednoteMediaAsset {
  const asset = record(value, field);
  exactKeys(
    asset,
    ['assetId', 'deliveryUrl', 'sha256', 'mimeType', 'mediaType', 'role'],
    [],
    field,
  );
  const deliveryUrl = text(asset.deliveryUrl, `${field}.deliveryUrl`, 2_048);
  const assetId = text(asset.assetId, `${field}.assetId`, 2_048);
  if (assetId !== canonicalRednoteAssetId(deliveryUrl)) {
    throw invalid(
      `${field}.assetId must equal the canonical R2 object key`,
      'REDNOTE_ASSET_ID_MISMATCH',
    );
  }
  const mimeType = text(asset.mimeType, `${field}.mimeType`, 64);
  if (!REDNOTE_MEDIA_MIME_TYPES.some((candidate) => candidate === mimeType)) {
    throw invalid(`${field}.mimeType is not browser-ready`);
  }
  if (asset.mediaType !== 'image' && asset.mediaType !== 'video') {
    throw invalid(`${field}.mediaType must be image or video`);
  }
  if (asset.role !== 'content' && asset.role !== 'cover' && asset.role !== 'poster') {
    throw invalid(`${field}.role must be content, cover, or poster`);
  }
  if (
    (asset.mediaType === 'image' && !mimeType.startsWith('image/')) ||
    (asset.mediaType === 'video' && mimeType !== 'video/mp4')
  ) {
    throw invalid(`${field}.mediaType and mimeType disagree`);
  }
  return {
    assetId,
    deliveryUrl,
    sha256: digest(asset.sha256, `${field}.sha256`),
    mimeType: mimeType as RednoteMediaMimeType,
    mediaType: asset.mediaType,
    role: asset.role,
  };
}

function parseExecutor(value: unknown) {
  const executor = record(value, 'payload.executor');
  exactKeys(
    executor,
    ['type', 'kind', 'id'],
    ['workerRunId', 'playwrightRunId'],
    'payload.executor',
  );
  const id = text(executor.id, 'payload.executor.id', 256);
  const workerRunId = optionalText(
    executor.workerRunId,
    'payload.executor.workerRunId',
  );
  const playwrightRunId = optionalText(
    executor.playwrightRunId,
    'payload.executor.playwrightRunId',
  );
  if (executor.type === 'worker' && executor.kind === 'playwright') {
    return {
      type: 'worker' as const,
      kind: 'playwright' as const,
      id,
      ...(workerRunId ? { workerRunId } : {}),
      ...(playwrightRunId ? { playwrightRunId } : {}),
    };
  }
  if (
    executor.type === 'worker' &&
    executor.kind === 'microservice' &&
    !playwrightRunId
  ) {
    return {
      type: 'worker' as const,
      kind: 'microservice' as const,
      id,
      ...(workerRunId ? { workerRunId } : {}),
    };
  }
  if (
    executor.type === 'operator' &&
    executor.kind === 'operator' &&
    !workerRunId &&
    !playwrightRunId
  ) {
    return { type: 'operator' as const, kind: 'operator' as const, id };
  }
  throw invalid(
    'payload.executor type, kind, and run provenance are incompatible',
    'REDNOTE_EXECUTOR_INCOMPATIBLE',
  );
}

function stringArray(value: unknown, field: string, maxItems: number) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw invalid(`${field} must be an array with at most ${maxItems} entries`);
  }
  return value.map((item, index) => text(item, `${field}[${index}]`, 256));
}

function parseBrowserPayload(value: unknown) {
  const payload = record(value, 'payload.browserPayload');
  exactKeys(
    payload,
    [
      'sourcePostId',
      'title',
      'caption',
      'tags',
      'scheduledDate',
      'targetPublishAt',
      'timingMode',
      'visibility',
      'publishMode',
      'mediaAssets',
    ],
    ['coverAsset', 'posterAsset'],
    'payload.browserPayload',
  );
  const sourcePostId = text(
    payload.sourcePostId,
    'payload.browserPayload.sourcePostId',
    64,
  );
  normalizeNotionPageId(sourcePostId);
  const targetPublishAt = instant(
    payload.targetPublishAt,
    'payload.browserPayload.targetPublishAt',
  );
  const scheduledDate = payload.scheduledDate === null
    ? null
    : scheduledInstant(
        payload.scheduledDate,
        'payload.browserPayload.scheduledDate',
      );
  if (payload.timingMode !== 'scheduled' && payload.timingMode !== 'post_now') {
    throw invalid('payload.browserPayload.timingMode is invalid');
  }
  if (payload.visibility !== 'public' && payload.visibility !== 'private') {
    throw invalid('payload.browserPayload.visibility is invalid');
  }
  if (!Array.isArray(payload.mediaAssets) || payload.mediaAssets.length === 0) {
    throw invalid('payload.browserPayload.mediaAssets must not be empty');
  }
  const mediaAssets = payload.mediaAssets.map((asset, index) =>
    parseAsset(asset, `payload.browserPayload.mediaAssets[${index}]`));
  if (mediaAssets.some((asset) => asset.role !== 'content')) {
    throw invalid('All mediaAssets entries must have the content role');
  }
  if (payload.posterAsset !== undefined) {
    throw invalid(
      'posterAsset is unavailable until Posts exposes an authoritative poster field',
      'REDNOTE_POSTER_ASSET_UNSUPPORTED',
    );
  }
  const common = {
    sourcePostId,
    title: text(payload.title, 'payload.browserPayload.title', 100),
    caption: text(payload.caption, 'payload.browserPayload.caption'),
    tags: stringArray(payload.tags, 'payload.browserPayload.tags', MAX_TAGS),
    scheduledDate,
    targetPublishAt,
    timingMode: payload.timingMode as 'scheduled' | 'post_now',
    visibility: payload.visibility as 'public' | 'private',
  };
  if (payload.publishMode === 'image') {
    if (
      payload.coverAsset !== undefined ||
      mediaAssets.some((asset) => asset.mediaType !== 'image')
    ) {
      throw invalid('Image payloads accept only content image assets');
    }
    return {
      ...common,
      publishMode: 'image' as const,
      mediaAssets: mediaAssets as [
        FrozenRednoteMediaAsset & { mediaType: 'image'; role: 'content' },
        ...(FrozenRednoteMediaAsset & {
          mediaType: 'image';
          role: 'content';
        })[],
      ],
    };
  }
  if (payload.publishMode === 'video') {
    if (
      mediaAssets.length !== 1 ||
      mediaAssets[0].mediaType !== 'video'
    ) {
      throw invalid('Video payloads require exactly one content MP4');
    }
    const coverAsset = payload.coverAsset === undefined
      ? undefined
      : parseAsset(payload.coverAsset, 'payload.browserPayload.coverAsset');
    if (
      coverAsset &&
      (coverAsset.mediaType !== 'image' || coverAsset.role !== 'cover')
    ) {
      throw invalid('coverAsset must be an image with the cover role');
    }
    return {
      ...common,
      publishMode: 'video' as const,
      mediaAssets: mediaAssets as [
        FrozenRednoteMediaAsset & { mediaType: 'video'; role: 'content' },
      ],
      ...(coverAsset
        ? {
            coverAsset: coverAsset as FrozenRednoteMediaAsset & {
              mediaType: 'image';
              role: 'cover';
            },
          }
        : {}),
    };
  }
  throw invalid('payload.browserPayload.publishMode is invalid');
}

export function parseRednoteAttemptTransactionRequest(
  value: unknown,
  expectedRequester?: RednoteTransactionRequester,
): RednoteAttemptTransactionRequest {
  const request = record(value, 'request');
  exactKeys(
    request,
    ['requestedBy', 'idempotencyKey', 'payload'],
    [],
    'request',
  );
  if (
    !REDNOTE_TRANSACTION_REQUESTERS.some(
      (candidate) => candidate === request.requestedBy,
    )
  ) {
    throw invalid('requestedBy is invalid');
  }
  if (expectedRequester && request.requestedBy !== expectedRequester) {
    throw new RednotePublishingError(
      'The authenticated requester does not match requestedBy',
      'REDNOTE_REQUESTER_MISMATCH',
      403,
    );
  }
  const payload = record(request.payload, 'payload');
  exactKeys(
    payload,
    [
      'contractRevision',
      'sourceNotionPageId',
      'payloadRevision',
      'sourcePostRevision',
      'payloadDigest',
      'requestedAt',
      'executor',
      'browserPayload',
    ],
    ['sourceLocalPublishJobId'],
    'payload',
  );
  if (payload.contractRevision !== REDNOTE_PUBLISHING_CONTRACT_REVISION) {
    throw invalid('payload.contractRevision is unsupported');
  }
  if (payload.payloadRevision !== REDNOTE_BROWSER_PAYLOAD_REVISION) {
    throw invalid('payload.payloadRevision is unsupported');
  }
  const sourceNotionPageId = text(
    payload.sourceNotionPageId,
    'payload.sourceNotionPageId',
    64,
  );
  const sourcePageIdentity = normalizeNotionPageId(sourceNotionPageId);
  const browserPayload = parseBrowserPayload(payload.browserPayload);
  if (normalizeNotionPageId(browserPayload.sourcePostId) !== sourcePageIdentity) {
    throw conflict(
      'sourceNotionPageId and browserPayload.sourcePostId disagree',
      'REDNOTE_SOURCE_POST_MISMATCH',
    );
  }
  const parsedPayload: FrozenRednoteAttemptPayload = {
    contractRevision: REDNOTE_PUBLISHING_CONTRACT_REVISION,
    sourceNotionPageId,
    ...(payload.sourceLocalPublishJobId !== undefined
      ? {
          sourceLocalPublishJobId: uuid(
            payload.sourceLocalPublishJobId,
            'payload.sourceLocalPublishJobId',
          ),
        }
      : {}),
    payloadRevision: REDNOTE_BROWSER_PAYLOAD_REVISION,
    sourcePostRevision: instant(
      payload.sourcePostRevision,
      'payload.sourcePostRevision',
    ),
    payloadDigest: digest(payload.payloadDigest, 'payload.payloadDigest'),
    requestedAt: instant(payload.requestedAt, 'payload.requestedAt'),
    executor: parseExecutor(payload.executor),
    browserPayload,
  };
  const { payloadDigest, ...digestablePayload } = parsedPayload;
  if (rednoteStableDigest(digestablePayload) !== payloadDigest) {
    throw conflict(
      'payloadDigest does not match the normalized frozen payload',
      'REDNOTE_PAYLOAD_DIGEST_MISMATCH',
    );
  }
  if (browserPayload.timingMode === 'scheduled') {
    if (
      !browserPayload.scheduledDate ||
      Date.parse(browserPayload.scheduledDate) !==
        Date.parse(browserPayload.targetPublishAt)
    ) {
      throw conflict(
        'Scheduled payload timing fields must identify the same instant',
        'REDNOTE_TIMING_MISMATCH',
      );
    }
  } else if (browserPayload.targetPublishAt !== parsedPayload.requestedAt) {
    throw conflict(
      'Post-now payload must target requestedAt',
      'REDNOTE_TIMING_MISMATCH',
    );
  } else if (
    browserPayload.scheduledDate &&
    Date.parse(browserPayload.scheduledDate) > Date.parse(parsedPayload.requestedAt)
  ) {
    throw conflict(
      'Post-now cannot bypass a future canonical schedule',
      'REDNOTE_TIMING_MISMATCH',
    );
  }
  return {
    requestedBy: request.requestedBy as RednoteTransactionRequester,
    idempotencyKey: uuid(request.idempotencyKey, 'idempotencyKey'),
    payload: parsedPayload,
  };
}

export interface RednoteAuthoritativePostSnapshot {
  id: string;
  lastEditedTime: string;
  status: string;
  packetAuthorized: boolean;
  title: string;
  caption: string;
  tags: readonly string[];
  scheduledDate: string | null;
  mediaUrls: readonly string[];
  thumbnailUrl?: string;
}

export function validateRednoteAttemptSources(
  request: RednoteAttemptTransactionRequest,
  post: RednoteAuthoritativePostSnapshot,
  localJob?: { id: string; snapshot: LocalPublishSnapshot },
) {
  const payload = request.payload;
  const browser = payload.browserPayload;
  if (
    normalizeNotionPageId(post.id) !==
      normalizeNotionPageId(payload.sourceNotionPageId) ||
    post.lastEditedTime !== payload.sourcePostRevision
  ) {
    throw conflict(
      'The source Post identity or revision changed',
      'REDNOTE_SOURCE_REVISION_MISMATCH',
    );
  }
  if (!post.packetAuthorized) {
    throw conflict(
      'The source Post is not packet-authorized',
      'REDNOTE_PACKET_NOT_AUTHORIZED',
    );
  }
  const contentUrls = browser.mediaAssets.map((asset) => asset.deliveryUrl);
  if (
    post.title !== browser.title ||
    post.caption !== browser.caption ||
    JSON.stringify(post.tags) !== JSON.stringify(browser.tags) ||
    JSON.stringify(post.mediaUrls) !== JSON.stringify(contentUrls) ||
    post.scheduledDate !== browser.scheduledDate
  ) {
    throw conflict(
      'The frozen copy, ordered tags, or ordered media differ from Posts',
      'REDNOTE_SOURCE_PACKET_MISMATCH',
    );
  }
  if (
    browser.timingMode === 'scheduled' &&
    (
      !post.scheduledDate ||
      Date.parse(post.scheduledDate) !== Date.parse(browser.targetPublishAt)
    )
  ) {
    throw conflict(
      'The frozen scheduled time differs from Posts',
      'REDNOTE_SOURCE_TIMING_MISMATCH',
    );
  }
  if (browser.publishMode === 'video' && browser.coverAsset) {
    if (!post.thumbnailUrl || post.thumbnailUrl !== browser.coverAsset.deliveryUrl) {
      throw conflict(
        'The frozen cover differs from the authoritative Posts Thumbnail',
        'REDNOTE_COVER_ASSET_MISMATCH',
      );
    }
  }
  if (payload.sourceLocalPublishJobId) {
    if (!localJob || localJob.id !== payload.sourceLocalPublishJobId) {
      throw conflict(
        'The frozen local publish job is unavailable',
        'REDNOTE_LOCAL_JOB_MISMATCH',
      );
    }
    const snapshot = localJob.snapshot;
    if (
      normalizeNotionPageId(snapshot.notionPageId) !==
        normalizeNotionPageId(post.id) ||
      snapshot.notionLastEditedTime !== payload.sourcePostRevision ||
      snapshot.title !== browser.title ||
      snapshot.caption !== browser.caption ||
      JSON.stringify(snapshot.tags) !== JSON.stringify(browser.tags) ||
      snapshot.mediaUrl !== contentUrls[0] ||
      (snapshot.publishAt ?? null) !== post.scheduledDate
    ) {
      throw conflict(
        'The local publish job snapshot differs from the frozen packet',
        'REDNOTE_LOCAL_JOB_MISMATCH',
      );
    }
  } else if (localJob) {
    throw conflict(
      'An unreferenced local publish job cannot authorize this packet',
      'REDNOTE_LOCAL_JOB_MISMATCH',
    );
  }
}

export type RednoteAssetFetcher = (
  url: string,
) => Promise<{ bytes: Uint8Array; contentType: string | null }>;

function normalizedContentType(value: string | null) {
  return value?.split(';', 1)[0].trim().toLowerCase() ?? '';
}

async function byteMimeType(bytes: Uint8Array): Promise<RednoteMediaMimeType | null> {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return 'video/mp4';
  }
  return null;
}

function assertValidMp4(bytes: Uint8Array) {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  interface Mp4Box {
    type: string;
    size: number;
    contentStart: number;
    end: number;
  }
  const parseBoxes = (start: number, end: number): Mp4Box[] => {
    const boxes: Mp4Box[] = [];
    let offset = start;
    while (offset + 8 <= end) {
      let boxSize = view.getUint32(offset);
      const type = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
      );
      let headerSize = 8;
      if (boxSize === 1) {
        if (offset + 16 > end) return [];
        const extendedSize = view.getBigUint64(offset + 8);
        if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return [];
        boxSize = Number(extendedSize);
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = end - offset;
      }
      if (boxSize < headerSize || offset + boxSize > end) return [];
      boxes.push({
        type,
        size: boxSize,
        contentStart: offset + headerSize,
        end: offset + boxSize,
      });
      offset += boxSize;
    }
    return offset === end ? boxes : [];
  };
  const topLevel = parseBoxes(0, bytes.byteLength);
  const ftyp = topLevel[0]?.type === 'ftyp' ? topLevel[0] : undefined;
  const moov = topLevel.find((box) => box.type === 'moov');
  const mdat = topLevel.find((box) => box.type === 'mdat' && box.size > 8);
  const moovChildren = moov
    ? parseBoxes(moov.contentStart, moov.end)
    : [];
  const hasMediaTrack = moovChildren
    .filter((box) => box.type === 'trak')
    .some((track) => {
      const trackChildren = parseBoxes(track.contentStart, track.end);
      const media = trackChildren.find((box) => box.type === 'mdia');
      if (!media) return false;
      const mediaChildren = parseBoxes(media.contentStart, media.end);
      const handler = mediaChildren.find((box) => box.type === 'hdlr');
      const handlerType = handler && handler.contentStart + 12 <= handler.end
        ? String.fromCharCode(
            bytes[handler.contentStart + 8],
            bytes[handler.contentStart + 9],
            bytes[handler.contentStart + 10],
            bytes[handler.contentStart + 11],
          )
        : null;
      return (
        handlerType === 'vide' &&
        mediaChildren.some((box) => box.type === 'minf')
      );
    });
  if (
    !ftyp ||
    ftyp.size < 16 ||
    !moov ||
    !mdat ||
    !hasMediaTrack
  ) {
    throw invalid(
      'Asset bytes are not a structurally complete MP4 container',
      'REDNOTE_ASSET_BYTES_INVALID',
    );
  }
}

async function assertDecodableImage(
  bytes: Uint8Array,
  mimeType: RednoteMediaMimeType,
) {
  if (mimeType === 'video/mp4') {
    assertValidMp4(bytes);
    return;
  }
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
  const expectedFormat = mimeType === 'image/jpeg'
    ? 'jpeg'
    : mimeType === 'image/png'
      ? 'png'
      : 'webp';
  if (metadata.format !== expectedFormat) {
    throw invalid(
      'Asset bytes do not decode as the declared image type',
      'REDNOTE_ASSET_BYTES_INVALID',
    );
  }
  await sharp(bytes, { failOn: 'error' }).raw().toBuffer();
}

export async function verifyRednoteAssetBytes(
  request: RednoteAttemptTransactionRequest,
  fetchAsset: RednoteAssetFetcher = fetchCanonicalRednoteAsset,
) {
  const browser = request.payload.browserPayload;
  const assets = [
    ...browser.mediaAssets,
    ...(browser.publishMode === 'video' && browser.coverAsset
      ? [browser.coverAsset]
      : []),
  ];
  for (const asset of assets) {
    let fetched: Awaited<ReturnType<RednoteAssetFetcher>>;
    try {
      fetched = await fetchAsset(asset.deliveryUrl);
    } catch (error) {
      if (error instanceof RednotePublishingError) throw error;
      throw new RednotePublishingError(
        'Canonical asset could not be fetched',
        'REDNOTE_ASSET_UNAVAILABLE',
        503,
      );
    }
    if (fetched.bytes.byteLength === 0 || fetched.bytes.byteLength > MAX_ASSET_BYTES) {
      throw invalid(
        'Asset byte length is empty or exceeds the limit',
        'REDNOTE_ASSET_SIZE_INVALID',
      );
    }
    const headerMime = normalizedContentType(fetched.contentType);
    const detectedMime = await byteMimeType(fetched.bytes);
    if (
      headerMime !== asset.mimeType ||
      detectedMime !== asset.mimeType
    ) {
      throw conflict(
        'Asset MIME header, bytes, and frozen packet disagree',
        'REDNOTE_ASSET_MIME_MISMATCH',
      );
    }
    await assertDecodableImage(fetched.bytes, asset.mimeType);
    const actualDigest = createHash('sha256').update(fetched.bytes).digest('hex');
    if (actualDigest !== asset.sha256) {
      throw conflict(
        'Asset bytes do not match the frozen checksum',
        'REDNOTE_ASSET_DIGEST_MISMATCH',
      );
    }
  }
}

export async function fetchCanonicalRednoteAsset(url: string) {
  canonicalRednoteAssetId(url);
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new RednotePublishingError(
      `Canonical asset returned HTTP ${response.status}`,
      'REDNOTE_ASSET_UNAVAILABLE',
      503,
    );
  }
  const lengthHeader = response.headers.get('content-length');
  const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    (declaredLength <= 0 || declaredLength > MAX_ASSET_BYTES)
  ) {
    throw invalid(
      'Asset Content-Length is empty or exceeds the limit',
      'REDNOTE_ASSET_SIZE_INVALID',
    );
  }
  if (!response.body) {
    throw new RednotePublishingError(
      'Canonical asset response has no body',
      'REDNOTE_ASSET_UNAVAILABLE',
      503,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_ASSET_BYTES) {
      await reader.cancel();
      throw invalid(
        'Asset byte length exceeds the limit',
        'REDNOTE_ASSET_SIZE_INVALID',
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    contentType: response.headers.get('content-type'),
  };
}

export function validateRednoteReceiptIdentity(value: {
  rednoteUrl: string;
  rednoteNoteId: string;
}) {
  const noteId = text(value.rednoteNoteId, 'rednoteNoteId', 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(noteId)) {
    throw invalid('rednoteNoteId contains unsupported characters');
  }
  let url: URL;
  try {
    url = new URL(value.rednoteUrl);
  } catch {
    throw invalid('rednoteUrl must be a URL');
  }
  if (
    url.protocol !== 'https:' ||
    !['www.xiaohongshu.com', 'www.rednote.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/explore/${noteId}`
  ) {
    throw invalid(
      'rednoteUrl must be an HTTPS platform receipt URL for rednoteNoteId',
      'REDNOTE_RECEIPT_IDENTITY_INVALID',
    );
  }
  return { rednoteUrl: url.toString(), rednoteNoteId: noteId };
}
