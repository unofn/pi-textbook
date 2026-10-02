import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "./types.js";

interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: number;
}

export interface CompactionSummary {
  goal: string;
  decisions: string[];
  files: string[];
  nextSteps: string[];
  invariants: string[];
}

export type SessionEntry =
  | (EntryBase & {
      type: "message";
      message: AgentMessage;
    })
  | (EntryBase & {
      type: "compaction";
      summary: CompactionSummary;
      compactedEntryIds: string[];
      firstKeptEntryId?: string;
      tokensBefore?: number;
    })
  | (EntryBase & {
      type: "metadata";
      key: string;
      value: unknown;
    });

export interface SessionStore {
  append(entry: SessionEntry): Promise<void>;
  entries(): Promise<SessionEntry[]>;
}

export interface SessionReadResult {
  entries: SessionEntry[];
  warnings: string[];
}

function assertEntry(value: unknown): asserts value is SessionEntry {
  if (!value || typeof value !== "object") {
    throw new Error("session entry 不是 object");
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    (entry.parentId !== null && typeof entry.parentId !== "string") ||
    typeof entry.timestamp !== "number" ||
    !["message", "compaction", "metadata"].includes(String(entry.type))
  ) {
    throw new Error("session entry 缺少基础字段");
  }
  if (entry.type === "message") assertMessage(entry.message);
}

const MESSAGE_ROLES = ["system", "user", "assistant", "toolResult"];

/**
 * system message 没有新的 entry 类型，就是普通 message entry；
 * 它的形状在这里校验：content 为字符串，sections 的值只能是 string 或 null。
 */
function assertMessage(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("message entry 缺少 message");
  }
  const message = value as Record<string, unknown>;
  if (!MESSAGE_ROLES.includes(String(message.role))) {
    throw new Error(`未知 message role：${String(message.role)}`);
  }
  if (typeof message.timestamp !== "number") {
    throw new Error("message 缺少 timestamp");
  }
  if (message.role !== "system") return;
  if (typeof message.content !== "string") {
    throw new Error("system message content 必须是字符串");
  }
  const sections = message.sections;
  if (sections === undefined) return;
  if (
    !sections ||
    typeof sections !== "object" ||
    Array.isArray(sections) ||
    Object.values(sections).some(
      (section) => section !== null && typeof section !== "string",
    )
  ) {
    throw new Error("system message sections 的值必须是 string 或 null");
  }
}

export function recoverJsonl(value: string): {
  entries: SessionEntry[];
  warnings: string[];
} {
  const lines = value.split("\n");
  const entries: SessionEntry[] = [];
  const warnings: string[] = [];

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed: unknown = JSON.parse(line);
      assertEntry(parsed);
      entries.push(parsed);
    } catch (error) {
      const isLastNonEmpty =
        lines.slice(index + 1).every((candidate) => !candidate.trim());
      if (isLastNonEmpty) {
        warnings.push(`忽略被截断的最后一行 ${index + 1}`);
        return;
      }
      throw new Error(
        `JSONL 中段第 ${index + 1} 行损坏：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  return { entries, warnings };
}

export class InMemorySessionStore implements SessionStore {
  private readonly log: SessionEntry[] = [];

  async append(entry: SessionEntry): Promise<void> {
    this.log.push(structuredClone(entry));
  }

  async entries(): Promise<SessionEntry[]> {
    return structuredClone(this.log);
  }
}

export class JsonlSessionStore implements SessionStore {
  private tail: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<JsonlSessionStore> {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, "", "utf8");
    return new JsonlSessionStore(file);
  }

  append(entry: SessionEntry): Promise<void> {
    const operation = this.tail.then(() =>
      appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8"),
    );
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async entries(): Promise<SessionEntry[]> {
    return (await this.read()).entries;
  }

  async read(): Promise<SessionReadResult> {
    await this.tail;
    const value = await readFile(this.file, "utf8");
    return recoverJsonl(value);
  }
}

export function pathTo(
  entries: SessionEntry[],
  leafId: string,
): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new Error(`session entry id 重复：${entry.id}`);
    }
    byId.set(entry.id, entry);
  }
  const reverse: SessionEntry[] = [];
  const visited = new Set<string>();
  let current: SessionEntry | undefined = byId.get(leafId);

  if (!current) throw new Error(`未知 session leaf：${leafId}`);
  while (current) {
    if (visited.has(current.id)) throw new Error("session parent 形成环");
    visited.add(current.id);
    reverse.push(current);
    if (current.parentId === null) break;
    current = byId.get(current.parentId);
    if (!current) throw new Error("session parent 缺失");
  }
  return reverse.reverse();
}
