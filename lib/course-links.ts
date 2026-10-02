export const COURSE_REPOSITORY_URL = "https://github.com/unofn/pi";
export const UPSTREAM_REPOSITORY_URL = "https://github.com/earendil-works/pi";

export function courseBranchUrl(branch: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error(`Invalid course branch: ${branch}`);
  }
  return `${COURSE_REPOSITORY_URL}/tree/${branch}`;
}

function assertCommit(commit: string): string {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Invalid course commit: ${commit}`);
  }
  return commit;
}

export function courseCommitUrl(commit: string): string {
  return `${COURSE_REPOSITORY_URL}/commit/${assertCommit(commit)}`;
}

export function courseComparisonUrl(
  parentCommit: string,
  commit: string,
): string {
  return `${COURSE_REPOSITORY_URL}/compare/${assertCommit(parentCommit)}...${assertCommit(commit)}`;
}

export function courseFileUrl(commit: string, file: string): string {
  if (!file.startsWith("packages/pi-course/")) {
    throw new Error(`Invalid course file: ${file}`);
  }
  return `${COURSE_REPOSITORY_URL}/blob/${assertCommit(commit)}/${file}`;
}
