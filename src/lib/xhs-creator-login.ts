export const CREATOR_COOKIE_COPY_VALUE_INSTRUCTION =
  'In browser DevTools, open Network and select a newly authenticated ' +
  'creator.rednote.com request. Under Request Headers, right-click the cookie ' +
  'request-header value and choose Copy value.';

export const CREATOR_COOKIE_COPY_WARNING =
  'Do not use Copy all, Copy request headers, Copy as cURL, or the Application ' +
  'cookie table or export.';

export const CREATOR_QR_UNAVAILABLE_DETAIL = {
  code: 'CREATOR_QR_UNAVAILABLE',
  message:
    'QR login is disabled because the available CAS flow targets ' +
    'merchant/Qianfan rather than a normal Rednote creator account. ' +
    'Use the manual cookie login instructions above.',
} as const;

export const QR_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};
