function responseLocation(response: Response) {
  return response.url ? ` Final URL: ${response.url}.` : '';
}

export async function responseJson<T>(
  response: Response,
  requestLabel: string,
): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const text = await response.text();

  if (!contentType.includes('application/json')) {
    throw new Error(
      `${requestLabel} returned ${response.status} ${response.statusText || 'Unknown status'} ` +
      `with ${contentType || 'no content type'}; expected JSON.${responseLocation(response)}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${requestLabel} returned invalid JSON (${response.status} ` +
      `${response.statusText || 'Unknown status'}).${responseLocation(response)}`,
    );
  }
  if (!body || typeof body !== 'object') {
    throw new Error(`${requestLabel} returned a non-object JSON response.`);
  }
  return body as T;
}

export async function responseJsonOrThrow<T extends object>(
  response: Response,
  requestLabel: string,
): Promise<T> {
  const body = await responseJson<T>(response, requestLabel);
  if (response.ok) return body;

  const error =
    ('error' in body && typeof body.error === 'string' && body.error.trim()) ||
    ('detail' in body && typeof body.detail === 'string' && body.detail.trim()) ||
    'Request failed';
  throw new Error(
    `${requestLabel} failed (${response.status} ${response.statusText || 'Unknown status'}): ${error}`,
  );
}
