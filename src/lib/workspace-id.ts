import { LocalPublishJobError } from '@/lib/local-publish-job-input';

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseWorkspaceId(value: string | null): string {
  const workspaceId = value?.trim();
  if (!workspaceId || !WORKSPACE_ID.test(workspaceId)) {
    throw new LocalPublishJobError(
      'X-Workspace-Id is required and must be a safe workspace identifier',
      'INVALID_WORKSPACE_ID',
      400,
    );
  }
  return workspaceId;
}