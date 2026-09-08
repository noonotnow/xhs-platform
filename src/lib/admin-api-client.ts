export function adminApiFetch(
  workspaceId: string,
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set('X-Workspace-Id', workspaceId);
  return fetch(input, { ...init, headers });
}
