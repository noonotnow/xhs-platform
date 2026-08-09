const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export function adminApiHeaders(contract: string) {
  return {
    ...NO_STORE_HEADERS,
    'X-XHS-Admin-API-Contract': contract,
    'X-XHS-State-Authority': 'postgresql',
    'X-XHS-Local-Worker-State': 'excluded',
    'X-XHS-Source-Commit':
      process.env.VERCEL_GIT_COMMIT_SHA?.trim() || 'development',
  };
}
