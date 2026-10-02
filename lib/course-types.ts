export type PartId =
  | "orientation"
  | "foundations"
  | "core"
  | "state"
  | "product"
  | "advanced";

export interface CoursePart {
  id: PartId;
  number: string;
  title: string;
  shortTitle: string;
  thesis: string;
  accent: "ink" | "cyan" | "green" | "amber" | "red" | "violet";
}

export interface TableOfContentsItem {
  id: string;
  title: string;
  level: 2 | 3;
}

export interface Chapter {
  id: string;
  slug: string;
  part: PartId;
  partTitle: string;
  chapter: string;
  title: string;
  summary: string;
  minutes: number;
  difficulty: string;
  artifact: string;
  prerequisites: string[];
  terms: string[];
  upstream: string[];
  courseBranch: string;
  commit: string;
  parentCommit: string;
  commitSubject: string;
  checkpointTest: string;
  html: string;
  toc: TableOfContentsItem[];
  searchText: string;
  sourceFile: string;
}

export interface SearchEntry {
  id: string;
  chapterId: string;
  chapterSlug: string;
  chapterTitle: string;
  title: string;
  href: string;
  partTitle: string;
  terms: string[];
  searchText: string;
}
