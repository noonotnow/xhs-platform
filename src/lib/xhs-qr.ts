export const UNSUPPORTED_CREATOR_QR_MESSAGE =
  'Merchant/Qianfan login is not supported for this Rednote creator account. ' +
  'Use manual cookie login from https://creator.rednote.com/login.';

export class UnsupportedCreatorQrError extends Error {
  constructor() {
    super(UNSUPPORTED_CREATOR_QR_MESSAGE);
  }
}

function recursivelyDecode(value: string) {
  let decoded = value.trim();
  for (let depth = 0; depth < 20; depth += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) break;
    decoded = next.trim();
    if (depth === 19) return null;
  }
  return decoded;
}

export function canonicalCreatorQrUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new UnsupportedCreatorQrError();
  }

  const decoded = recursivelyDecode(value);
  const normalized = decoded?.toLowerCase() ?? '';
  if (
    !decoded ||
    normalized.includes('xymerchant') ||
    normalized.includes('qianfan')
  ) {
    throw new UnsupportedCreatorQrError();
  }

  try {
    if (new URL(decoded).protocol.toLowerCase() !== 'xhsdiscover:') {
      throw new UnsupportedCreatorQrError();
    }
  } catch (error) {
    if (error instanceof UnsupportedCreatorQrError) throw error;
    throw new UnsupportedCreatorQrError();
  }
  return decoded;
}
