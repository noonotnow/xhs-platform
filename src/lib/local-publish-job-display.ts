import type { LocalPublishJobSummary } from '@/types/local-publish-job';

export function isActiveLocalPublishJob(job: LocalPublishJobSummary) {
  return job.status !== 'failed' && job.status !== 'reconciled';
}

export function displayedLocalPublishJob(
  jobs: LocalPublishJobSummary[],
  notionPageId: string,
) {
  const matching = jobs.filter((job) => job.notionPageId === notionPageId);
  return matching.find(isActiveLocalPublishJob) ?? matching[0];
}
