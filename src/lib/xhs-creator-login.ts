export const CREATOR_QR_UNAVAILABLE_DETAIL = {
  code: 'CREATOR_QR_UNAVAILABLE',
  message:
    'QR login is disabled because the available CAS flow targets ' +
    'merchant/Qianfan rather than a normal Rednote creator account. ' +
    'Use manual cookie login with a fresh Request Headers Cookie value from ' +
    'an authenticated creator/webapi request at https://creator.rednote.com/login.',
} as const;

export const QR_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};
