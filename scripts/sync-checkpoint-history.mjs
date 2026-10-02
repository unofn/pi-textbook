import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expected } from "./build-content.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historyRoot = process.env.PI_COURSE_ROOT
  ? path.resolve(process.env.PI_COURSE_ROOT)
  : path.resolve(root, "..", "pi-course");
const manifestFile = path.join(root, "content", "checkpoints.json");
const courseBranch = process.env.PI_COURSE_BRANCH ?? "course/build-your-own-pi";
const expectedIds = expected.map(({ id }) => id);

function fail(message) {
  throw new Error(`[checkpoint-history] ${message}`);
}

function git(...args) {
  try {
    return execFileSync("git", ["-C", historyRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : String(error);
    fail(`git ${args.join(" ")} 失败${detail ? `：${detail}` : ""}`);
  }
}

function nonEmptyLines(value) {
  return value.split("\n").filter(Boolean);
}

function changedFiles(commit, ...paths) {
  return nonEmptyLines(
    git(
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "--diff-filter=AM",
      commit,
      "--",
      ...paths,
    ),
  ).sort();
}

function testTitles(source, focusedTest) {
  const titles = [];
  const declaration =
    /\btest(?:\.(?:only|skip|todo))?\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)\s*,/g;

  for (const match of source.matchAll(declaration)) {
    titles.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'`\\])/g, "$1"));
  }
  if (titles.length === 0) {
    fail(`${focusedTest} 未找到静态 test title`);
  }
  return titles;
}

function buildManifest() {
  const commits = nonEmptyLines(
    git(
      "log",
      courseBranch,
      "--reverse",
      "--format=%H%x09%P%x09%s",
    ),
  ).flatMap((line) => {
    const [commit, parents, ...subjectParts] = line.split("\t");
    const subject = subjectParts.join("\t");
    const match = subject.match(/^course\((\d{2})\): (.+)$/);
    if (!match) return [];
    const parentCommits = parents.split(" ").filter(Boolean);
    if (parentCommits.length !== 1) {
      fail(`${commit} 必须是单父提交，实际为 ${parents || "无父提交"}`);
    }
    return [{
      id: match[1],
      commit,
      parentCommit: parentCommits[0],
      subject,
    }];
  });

  if (commits.length !== expectedIds.length) {
    fail(
      `${courseBranch} 应含 ${expectedIds.length} 个课程提交，实际为 ${commits.length}`,
    );
  }
  const actualIds = commits.map(({ id }) => id);
  if (actualIds.join(",") !== expectedIds.join(",")) {
    fail(`课程提交必须严格覆盖 ${expectedIds.join(",")}，实际为 ${actualIds.join(",")}`);
  }

  return commits.map((checkpoint, index) => {
    if (
      index > 0 &&
      checkpoint.parentCommit !== commits[index - 1].commit
    ) {
      fail(
        `course(${checkpoint.id}) parent ${checkpoint.parentCommit} 不是上章 ${commits[index - 1].commit}`,
      );
    }

    const teachingPaths = checkpoint.id === "14"
      ? [
          "packages/pi-course/test-support",
          "packages/pi-course/tsconfig.json",
        ]
      : ["packages/pi-course/src"];
    const sourceDelta = changedFiles(
      checkpoint.commit,
      ...teachingPaths,
    );
    if (sourceDelta.length === 0) {
      fail(
        `course(${checkpoint.id}) 没有新增或修改本章声明的教学文件`,
      );
    }

    const focusedTests = changedFiles(
      checkpoint.commit,
      "packages/pi-course/test",
    ).filter((file) =>
      new RegExp(
        `^packages/pi-course/test/${checkpoint.id}-.+\\.test\\.ts$`,
      ).test(file)
    );
    if (focusedTests.length !== 1) {
      fail(
        `course(${checkpoint.id}) 应有一个同编号聚焦测试，实际为 ${focusedTests.join(",") || "无"}`,
      );
    }
    const focusedTest = focusedTests[0];
    const testSource = git("show", `${checkpoint.commit}:${focusedTest}`);

    return {
      ...checkpoint,
      sourceDelta,
      focusedTest,
      testTitles: testTitles(testSource, focusedTest),
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    fail("仅支持无参数写入，或使用 --check 检查");
  }

  const serialized = `${JSON.stringify(buildManifest(), null, 2)}\n`;
  if (args[0] === "--check") {
    const current = await readFile(manifestFile, "utf8").catch((error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (current !== serialized) {
      process.stderr.write(
        "[checkpoint-history] content/checkpoints.json 已过期；运行 npm run history:sync 更新。\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `已确认 ${expectedIds.length} 个 checkpoint 与实时课程历史一致。\n`,
    );
    return;
  }

  await writeFile(manifestFile, serialized, "utf8");
  process.stdout.write(
    `已从 ${courseBranch} 同步 ${expectedIds.length} 个 checkpoint。\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
