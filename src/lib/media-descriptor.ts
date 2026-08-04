const CANONICAL_MEDIA_ORIGIN = 'https://images.xhs.justlikekatie.com';
const CANONICAL_MOV_PATH =
  /^\/videos\/assets\/[0-9a-f]{2}\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.mov$/i;
const DEFAULT_TIMEOUT_MS = 3_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 10_000;

export type MediaDescriptorFailureCode =
  | 'configuration'
  | 'authentication'
  | 'timeout'
  | 'fetch'
  | 'parse'
  | 'identity'
  | 'verdict';

export type MediaDescriptorVerdict =
  | { compatible: true; assetId: string }
  | { compatible: false; code: MediaDescriptorFailureCode; assetId?: string };

interface DescriptorConfig {
  baseUrl: string;
  authorization: string;
  timeoutMs: number;
}

function configuredTimeout() {
  const parsed = Number(process.env.MEDIA_DESCRIPTOR_TIMEOUT_MS);
  if (!Number.isInteger(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, parsed));
}

function descriptorConfig(): DescriptorConfig | null {
  const baseUrl = process.env.MEDIA_API_BASE_URL?.trim();
  const authorization = process.env.MEDIA_ASSETS_READ_CREDENTIAL?.trim();
  if (!baseUrl || !authorization) return null;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    return {
      baseUrl: parsed.href.replace(/\/$/, ''),
      authorization,
      timeoutMs: configuredTimeout(),
    };
  } catch {
    return null;
  }
}

export function parseCanonicalMovAssetUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (
      parsed.origin !== CANONICAL_MEDIA_ORIGIN ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const match = parsed.pathname.match(CANONICAL_MOV_PATH);
    return match ? { assetId: match[1], canonicalUrl: url } : null;
  } catch {
    return null;
  }
}

function isCompatibleDescriptor(
  value: unknown,
  assetId: string,
  canonicalUrl: string,
) {
  if (!value || typeof value !== 'object') return false;
  const descriptor = value as Record<string, unknown>;
  const compatibility = descriptor.compatibility;
  return descriptor.assetId === assetId &&
    descriptor.deliveryUrl === canonicalUrl &&
    descriptor.mediaType === 'video' &&
    descriptor.mimeType === 'video/quicktime' &&
    descriptor.containerFormat === 'quicktime' &&
    descriptor.processingState === 'ready' &&
    Boolean(compatibility) &&
    typeof compatibility === 'object' &&
    (compatibility as Record<string, unknown>).xhsPublishing === 'compatible' &&
    (compatibility as Record<string, unknown>).reason === null;
}

export async function fetchCanonicalMovDescriptorVerdict(
  canonicalUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MediaDescriptorVerdict> {
  const parsedAsset = parseCanonicalMovAssetUrl(canonicalUrl);
  if (!parsedAsset) return { compatible: false, code: 'identity' };

  const config = descriptorConfig();
  if (!config) {
    return { compatible: false, code: 'configuration', assetId: parsedAsset.assetId };
  }

  let response: Response;
  try {
    response = await fetchImpl(
      `${config.baseUrl}/v1/assets/${encodeURIComponent(parsedAsset.assetId)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: config.authorization,
        },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      },
    );
  } catch (error) {
    return {
      compatible: false,
      code: error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'fetch',
      assetId: parsedAsset.assetId,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { compatible: false, code: 'authentication', assetId: parsedAsset.assetId };
  }
  if (!response.ok) {
    return { compatible: false, code: 'fetch', assetId: parsedAsset.assetId };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { compatible: false, code: 'parse', assetId: parsedAsset.assetId };
  }
  if (!body || typeof body !== 'object' || !('data' in body)) {
    return { compatible: false, code: 'parse', assetId: parsedAsset.assetId };
  }

  const descriptor = (body as { data: unknown }).data;
  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    (descriptor as Record<string, unknown>).assetId !== parsedAsset.assetId ||
    (descriptor as Record<string, unknown>).deliveryUrl !== parsedAsset.canonicalUrl
  ) {
    return { compatible: false, code: 'identity', assetId: parsedAsset.assetId };
  }
  return isCompatibleDescriptor(descriptor, parsedAsset.assetId, parsedAsset.canonicalUrl)
    ? { compatible: true, assetId: parsedAsset.assetId }
    : { compatible: false, code: 'verdict', assetId: parsedAsset.assetId };
}

export async function compatibleCanonicalMovUrls(
  urls: string[],
  {
    requestId,
    concurrency = 4,
    fetchImpl = fetch,
  }: {
    requestId: string;
    concurrency?: number;
    fetchImpl?: typeof fetch;
  },
) {
  const pending = Array.from(new Set(urls.filter((url) => parseCanonicalMovAssetUrl(url))));
  const compatible = new Set<string>();
  const workerCount = Math.min(Math.max(1, concurrency), pending.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < pending.length) {
      const url = pending[nextIndex];
      nextIndex += 1;
      const verdict = await fetchCanonicalMovDescriptorVerdict(url, fetchImpl);
      if (verdict.compatible) {
        compatible.add(url);
      } else {
        console.warn('MEDIA descriptor rejected canonical MOV', {
          requestId,
          assetId: verdict.assetId,
          code: verdict.code,
        });
      }
    }
  }));

  return compatible;
}
