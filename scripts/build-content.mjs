import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked, Renderer } from "marked";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chapterRoot = path.join(root, "content", "chapters");
const generatedFile = path.join(root, "lib", "generated-course.ts");
const generatedSearchFile = path.join(
  root,
  "lib",
  "generated-search.ts",
);
const checkpointManifestFile = path.join(root, "content", "checkpoints.json");
const upstreamRoot = process.env.PI_COURSE_ROOT
  ? path.resolve(process.env.PI_COURSE_ROOT)
  : path.resolve(root, "..", "pi-course");
let upstreamAvailable;

const parts = [
  {
    id: "orientation",
    number: "00",
    title: "序章 · 先看见完整系统",
    shortTitle: "序章",
    thesis: "先观察一条完整轨迹，再亲手重建每个因果环节。",
    accent: "ink",
  },
  {
    id: "foundations",
    number: "I",
    title: "第一部 · 建立可执行语言",
    shortTitle: "模型与协议",
    thesis: "把时间、消息和外部模型翻译成稳定的内部协议。",
    accent: "cyan",
  },
  {
    id: "core",
    number: "II",
    title: "第二部 · 闭合 Agent 核心",
    shortTitle: "工具与循环",
    thesis: "让模型的意图经过验证，成为可观察的环境动作。",
    accent: "green",
  },
  {
    id: "state",
    number: "III",
    title: "第三部 · 让 Harness 可靠",
    shortTitle: "状态与历史",
    thesis: "区分运行状态、持久历史和每次决策所见的上下文。",
    accent: "amber",
  },
  {
    id: "product",
    number: "IV",
    title: "第四部 · 从核心到产品",
    shortTitle: "扩展与验证",
    thesis: "在不污染核心的前提下组合产品，并用故障证明架构。",
    accent: "red",
  },
];

const expected = [
  ["00", "00-prologue.md", "prologue", "orientation"],
  ["01", "01-typescript-survival.md", "typescript-survival", "foundations"],
  ["02", "02-event-stream.md", "event-stream", "foundations"],
  ["03", "03-message-ir.md", "message-ir", "foundations"],
  ["04", "04-scripted-model.md", "scripted-model", "foundations"],
  ["05", "05-provider-adapter.md", "provider-adapter", "foundations"],
  ["06", "06-tool-contract.md", "tool-contract", "core"],
  ["07", "07-agent-loop.md", "agent-loop", "core"],
  ["08", "08-coding-tools.md", "coding-tools", "core"],
  ["09", "09-stateful-agent.md", "stateful-agent", "state"],
  ["10", "10-session-tree.md", "session-tree", "state"],
  ["11", "11-context-compaction.md", "context-compaction", "state"],
  ["12", "12-resources-extensions.md", "resources-extensions", "product"],
  ["13", "13-composition-root.md", "composition-root", "product"],
  ["14", "14-eval-capstone.md", "eval-capstone", "product"],
].map(([id, file, slug, part]) => ({ id, file, slug, part }));

const checkpointManifest = JSON.parse(
  await readFile(checkpointManifestFile, "utf8"),
);
if (
  !Array.isArray(checkpointManifest) ||
  checkpointManifest.length !== expected.length
) {
  fail(`content/checkpoints.json 必须包含 ${expected.length} 个 checkpoint`);
}
const checkpointHistory = Object.fromEntries(
  checkpointManifest.map((checkpoint) => [checkpoint.id, checkpoint]),
);
if (
  Object.keys(checkpointHistory).length !== expected.length ||
  expected.some(({ id }) => !checkpointHistory[id])
) {
  fail("content/checkpoints.json 的 checkpoint id 不完整或重复");
}

const requiredHeadingPatterns = [
  { label: "验收", pattern: /验收$/ },
  { label: "小结", pattern: /^小结$/ },
];

const directiveMinimums = {
  rebuild: 1,
  lab: 2,
  checkpoint: 1,
  pi: 1,
};

const directiveLabels = {
  rebuild: ["本章重建入口", "先跨过从理解到动手的第一步"],
  predict: ["先预测", "先写判断，再看推理"],
  lab: ["动手实现", "在真实文件中建立能力"],
  mechanism: ["关键机制", "把现象连接到不变量"],
  failure: ["故障实验", "寻找第一次偏差"],
  checkpoint: ["本章关卡", "以证据进入下一状态"],
  pi: ["Pi 源码对照", "课程模型与生产实现"],
  transfer: ["可选迁移", "完成引导重建后再减少脚手架"],
  note: ["旁注", "不阻断主线"],
};

function fail(message) {
  throw new Error(`[content] ${message}`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stripHtml(value) {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#039);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugBase(value) {
  return stripHtml(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function parseFrontmatter(raw, file) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") fail(`${file} 缺少 frontmatter 起始线`);
  const end = lines.indexOf("---", 1);
  if (end < 0) fail(`${file} 缺少 frontmatter 结束线`);

  const meta = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (!match) fail(`${file} frontmatter 无法解析：${line}`);
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[match[1]] = value;
  }

  return { meta, body: lines.slice(end + 1).join("\n").trim() };
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractDirectives(markdown, file) {
  const lines = markdown.split("\n");
  const directives = [];
  const counts = {};
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index].match(
      /^:::(rebuild|predict|lab|mechanism|failure|checkpoint|pi|transfer|note)(?:\s+title="([^"]+)")?\s*$/,
    );
    if (!start) {
      output.push(lines[index]);
      continue;
    }

    const type = start[1];
    const title = start[2] ?? directiveLabels[type][0];
    const body = [];
    let cursor = index + 1;
    for (; cursor < lines.length && lines[cursor] !== ":::"; cursor += 1) {
      if (lines[cursor].startsWith(":::")) {
        fail(`${file} 的 ${type} directive 不允许嵌套`);
      }
      body.push(lines[cursor]);
    }
    if (cursor >= lines.length) fail(`${file} 的 ${type} directive 没有结束`);

    counts[type] = (counts[type] ?? 0) + 1;
    const id = directives.length;
    directives.push({ type, title, body: body.join("\n").trim() });
    output.push(`<div data-pi-directive="${id}"></div>`);
    index = cursor;
  }

  return { markdown: output.join("\n"), directives, counts };
}

function createRenderer(toc, usedSlugs) {
  const renderer = new Renderer();

  renderer.heading = function ({ tokens, depth }) {
    const inline = this.parser.parseInline(tokens);
    const plain = stripHtml(inline);
    let id = slugBase(plain) || "section";
    const seen = usedSlugs.get(id) ?? 0;
    usedSlugs.set(id, seen + 1);
    if (seen > 0) id = `${id}-${seen + 1}`;
    if (depth === 2 || depth === 3) {
      toc.push({ id, title: plain, level: depth });
    }
    return `<h${depth} id="${escapeHtml(id)}"><a class="heading-anchor" href="#${escapeHtml(id)}" aria-label="链接到 ${escapeHtml(plain)}">#</a>${inline}</h${depth}>`;
  };

  renderer.code = function ({ text, lang }) {
    const info = (lang ?? "").trim();
    const language = info.split(/\s+/)[0] || "text";
    const titleMatch = info.match(/(?:title|file)="([^"]+)"/);
    const title = titleMatch?.[1] ?? language;
    return `<figure class="code-frame"><figcaption><span>${escapeHtml(title)}</span><button type="button" data-copy-code aria-label="复制 ${escapeHtml(title)} 代码">复制</button></figcaption><pre tabindex="0"><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre></figure>`;
  };

  renderer.link = function ({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    const safeHref = escapeHtml(href);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const external = /^https?:\/\//.test(href)
      ? ' target="_blank" rel="noreferrer"'
      : "";
    return `<a href="${safeHref}"${titleAttr}${external}>${label}</a>`;
  };

  return renderer;
}

function renderFragment(markdown) {
  const renderer = createRenderer([], new Map());
  return marked.parse(markdown, { gfm: true, renderer, async: false });
}

function renderDirective(directive, file) {
  const { type, title, body } = directive;
  const [label, hint] = directiveLabels[type];

  if (type === "predict") {
    const parts = body.split(/\n---answer\s*\n/);
    if (parts.length !== 2) {
      fail(`${file} 的 predict 必须包含单独一行 ---answer`);
    }
    return `<section class="learning-block learning-block--predict" aria-label="${escapeHtml(title)}"><header><span class="block-kicker">${label}</span><h4>${escapeHtml(title)}</h4><small>${hint}</small></header><div class="block-body prediction-question">${renderFragment(parts[0])}</div><details class="prediction-answer"><summary>展开参考推理</summary><div>${renderFragment(parts[1])}</div></details></section>`;
  }

  const tag = type === "note" || type === "pi" ? "aside" : "section";
  return `<${tag} class="learning-block learning-block--${type}" aria-label="${escapeHtml(title)}"><header><span class="block-kicker">${label}</span><h4>${escapeHtml(title)}</h4><small>${hint}</small></header><div class="block-body">${renderFragment(body)}</div></${tag}>`;
}

function renderChapter(markdown, directives, file) {
  const toc = [];
  const usedSlugs = new Map();
  const renderer = createRenderer(toc, usedSlugs);
  let html = marked.parse(markdown, {
    gfm: true,
    renderer,
    async: false,
  });

  directives.forEach((directive, index) => {
    const placeholder = `<div data-pi-directive="${index}"></div>`;
    if (!html.includes(placeholder)) {
      fail(`${file} 的 directive ${index} 在 Markdown 编译后丢失`);
    }
    html = html.replace(placeholder, renderDirective(directive, file));
  });

  return { html, toc };
}

async function validateUpstreamPaths(paths, file) {
  upstreamAvailable ??= await access(upstreamRoot).then(
    () => true,
    () => false,
  );
  if (!upstreamAvailable) return;

  for (const upstreamPath of paths) {
    if (/^https?:\/\//.test(upstreamPath)) continue;
    const cleanPath = upstreamPath.split("#")[0].trim();
    if (!cleanPath) continue;
    try {
      await access(path.join(upstreamRoot, cleanPath));
    } catch {
      fail(`${file} 指向不存在的上游路径：${upstreamPath}`);
    }
  }
}

async function readChapter(spec) {
  const filePath = path.join(chapterRoot, spec.file);
  const raw = await readFile(filePath, "utf8");
  const { meta, body } = parseFrontmatter(raw, spec.file);

  for (const field of [
    "id",
    "slug",
    "part",
    "partTitle",
    "chapter",
    "title",
    "summary",
    "minutes",
    "difficulty",
    "artifact",
    "terms",
    "upstream",
  ]) {
    if (!meta[field]) fail(`${spec.file} 缺少 frontmatter 字段 ${field}`);
  }

  if (meta.id !== spec.id || meta.chapter !== spec.id) {
    fail(`${spec.file} 的 id/chapter 必须是 ${spec.id}`);
  }
  if (meta.slug !== spec.slug) {
    fail(`${spec.file} 的 slug 必须是 ${spec.slug}`);
  }
  if (meta.part !== spec.part) {
    fail(`${spec.file} 的 part 必须是 ${spec.part}`);
  }
  if (!Number.isFinite(Number(meta.minutes)) || Number(meta.minutes) < 15) {
    fail(`${spec.file} 的 minutes 必须是大于等于 15 的数字`);
  }
  if (stripHtml(body).length < 1000) {
    fail(`${spec.file} 正文过短，尚未达到教材深度`);
  }
  if (/\bTODO\b|待补充|占位/.test(body)) {
    fail(`${spec.file} 仍含 TODO 或占位内容`);
  }

  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((match) =>
    stripHtml(match[1]),
  );
  for (const required of requiredHeadingPatterns) {
    if (!headings.some((heading) => required.pattern.test(heading))) {
      fail(`${spec.file} 缺少二级标题：${required.label}`);
    }
  }

  const codeFenceCount = (body.match(/^```/gm)?.length ?? 0) / 2;
  if (codeFenceCount < 3) fail(`${spec.file} 至少需要 3 个代码或 trace 块`);

  const extracted = extractDirectives(body, spec.file);
  for (const [type, minimum] of Object.entries(directiveMinimums)) {
    if ((extracted.counts[type] ?? 0) < minimum) {
      fail(`${spec.file} 至少需要 ${minimum} 个 ${type} directive`);
    }
  }

  const prerequisites = splitList(meta.prerequisites);
  for (const prerequisite of prerequisites) {
    if (!expected.some((chapter) => chapter.id === prerequisite)) {
      fail(`${spec.file} 含未知前置章节 ${prerequisite}`);
    }
    if (Number(prerequisite) >= Number(spec.id)) {
      fail(`${spec.file} 的前置章节 ${prerequisite} 必须早于当前章节`);
    }
  }

  const upstream = splitList(meta.upstream);
  await validateUpstreamPaths(upstream, spec.file);
  const { html, toc } = renderChapter(
    extracted.markdown,
    extracted.directives,
    spec.file,
  );
  const checkpoint = checkpointHistory[spec.id];
  if (!checkpoint) fail(`${spec.file} 缺少真实 checkpoint commit`);
  const subjectPrefix = `course(${spec.id}): `;
  if (!checkpoint.subject.startsWith(subjectPrefix)) {
    fail(`${spec.file} 的 checkpoint subject 与章节编号不匹配`);
  }

  return {
    id: spec.id,
    slug: spec.slug,
    part: spec.part,
    partTitle: meta.partTitle,
    chapter: meta.chapter,
    title: meta.title,
    summary: meta.summary,
    minutes: Number(meta.minutes),
    difficulty: meta.difficulty,
    artifact: meta.artifact,
    prerequisites,
    terms: splitList(meta.terms),
    upstream,
    courseBranch: "course/build-your-own-pi",
    commit: checkpoint.commit,
    parentCommit: checkpoint.parentCommit,
    commitSubject: checkpoint.subject.slice(subjectPrefix.length),
    checkpointTest: checkpoint.focusedTest,
    html,
    toc,
    searchText: [
      meta.title,
      meta.summary,
      meta.partTitle,
      meta.terms,
      ...toc.map((item) => item.title),
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    sourceFile: `content/chapters/${spec.file}`,
  };
}

function validateCourseLinks(chapters) {
  const validSlugs = new Set(chapters.map((chapter) => chapter.slug));
  const validAnchors = new Map(
    chapters.map((chapter) => [
      chapter.slug,
      new Set(chapter.toc.map((item) => item.id)),
    ]),
  );

  for (const chapter of chapters) {
    for (const match of chapter.html.matchAll(
      /href="\/learn\/([^"#]+)(?:#([^"]+))?"/g,
    )) {
      const [, slug, anchor] = match;
      if (!validSlugs.has(slug)) {
        fail(`${chapter.sourceFile} 链接到未知章节 ${slug}`);
      }
      if (anchor && !validAnchors.get(slug)?.has(anchor)) {
        fail(`${chapter.sourceFile} 链接到未知章节锚点 ${slug}#${anchor}`);
      }
    }
  }
}

function buildSearchIndex(chapters) {
  return chapters.flatMap((chapter) => [
    {
      id: chapter.id,
      chapterId: chapter.id,
      chapterSlug: chapter.slug,
      chapterTitle: chapter.title,
      title: chapter.title,
      href: `/learn/${chapter.slug}`,
      partTitle: chapter.partTitle,
      terms: chapter.terms,
      searchText: chapter.searchText,
    },
    ...chapter.toc
      .filter((item) => item.level === 2)
      .map((item) => ({
        id: `${chapter.id}-${item.id}`,
        chapterId: chapter.id,
        chapterSlug: chapter.slug,
        chapterTitle: chapter.title,
        title: item.title,
        href: `/learn/${chapter.slug}#${item.id}`,
        partTitle: chapter.partTitle,
        terms: chapter.terms,
        searchText: `${chapter.title} ${item.title} ${chapter.terms.join(" ")}`,
      })),
  ]);
}

async function main() {
  await mkdir(chapterRoot, { recursive: true });
  const files = (await readdir(chapterRoot)).filter((file) => file.endsWith(".md"));
  const expectedFiles = new Set(expected.map((chapter) => chapter.file));
  for (const file of files) {
    if (!expectedFiles.has(file)) fail(`发现未登记章节文件 ${file}`);
  }
  for (const spec of expected) {
    if (!files.includes(spec.file)) fail(`缺少章节文件 ${spec.file}`);
  }

  const chapters = [];
  for (const spec of expected) {
    chapters.push(await readChapter(spec));
  }
  validateCourseLinks(chapters);

  const source = `/* 此文件由 scripts/build-content.mjs 生成，请勿手改。 */
import type { Chapter, CoursePart } from "./course-types";

export const courseParts: CoursePart[] = ${JSON.stringify(parts, null, 2)};

export const chapters: Chapter[] = ${JSON.stringify(chapters, null, 2)};

export const chapterBySlug: Record<string, Chapter> = Object.fromEntries(
  chapters.map((chapter) => [chapter.slug, chapter]),
);

export const chapterById: Record<string, Chapter> = Object.fromEntries(
  chapters.map((chapter) => [chapter.id, chapter]),
);
`;
  const searchSource = `/* 此文件由 scripts/build-content.mjs 生成，请勿手改。 */
import type { SearchEntry } from "./course-types";

export const searchIndex: SearchEntry[] = ${JSON.stringify(buildSearchIndex(chapters), null, 2)};
`;

  await Promise.all([
    writeFile(generatedFile, source, "utf8"),
    writeFile(generatedSearchFile, searchSource, "utf8"),
  ]);
  process.stdout.write(
    `已验证并生成 ${chapters.length} 章、${chapters.reduce((sum, chapter) => sum + chapter.toc.length, 0)} 个目录项。\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
