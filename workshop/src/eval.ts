import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "./agent.js";
import type {
  AgentRunResult,
  LoopEvent,
} from "./agent-loop.js";
import {
  createRuntime,
  type Runtime,
} from "./composition.js";
import type { ResourceCatalog } from "./resources.js";
import { ScriptedModel, type ScriptedTurn } from "./scripted-model.js";
import {
  InMemorySessionStore,
  type SessionEntry,
} from "./session.js";
import {
  ToolRegistry,
  type Tool,
} from "./tool.js";
import type {
  AgentMessage,
  Model,
  ToolCall,
} from "./types.js";

export type EvalStatus =
  | "passed"
  | "task_failed"
  | "protocol_failed"
  | "infra_failed";

export interface EvalFailure {
  layer: string;
  firstDivergence: string;
  observed?: string;
  expected?: string;
  violatedInvariant?: string;
  nextSignal?: string;
}

export interface EvalMetrics {
  turns: number;
  toolCalls: number;
}

export interface EvalResult {
  id: string;
  /** 与旧版 EvalResult 兼容；新 case 通常与 id 相同。 */
  name: string;
  status: EvalStatus;
  passed: boolean;
  transcript: AgentMessage[];
  events: AgentEvent[];
  files: Record<string, string>;
  session: SessionEntry[];
  metrics: EvalMetrics;
  failure?: EvalFailure;
  /** 评测报告不记录真实耗时，固定为 0，避免破坏可重复比较。 */
  durationMs: number;
  error?: string;
}

export interface DeterministicEvalCase {
  id: string;
  name?: string;
  prompt: string;
  files: Record<string, string>;
  script: readonly ScriptedTurn[];
  tools?: ToolRegistry | readonly Tool[];
  resources?: ResourceCatalog;
  systemPrompt?: string;
  maxSteps?: number;
  assert(result: EvalResult): void | Promise<void>;
  model?: never;
}

/**
 * 兼容前几章已有的轻量 eval API。它仍走 composition root，只是 assertion
 * 继续接收原始 AgentRunResult 与 LoopEvent[]。
 */
export interface LegacyEvalCase {
  name: string;
  id?: never;
  prompt: string;
  model: Model;
  tools?: ToolRegistry;
  maxSteps?: number;
  assert(
    result: AgentRunResult,
    events: LoopEvent[],
  ): void | Promise<void>;
  files?: never;
  script?: never;
}

export type EvalCase = DeterministicEvalCase | LegacyEvalCase;

export class EvalAssertionError extends Error {
  constructor(
    readonly status: Exclude<EvalStatus, "passed">,
    readonly failure: EvalFailure,
  ) {
    super(failure.firstDivergence);
    this.name = "EvalAssertionError";
  }
}

function isLegacyEvalCase(testCase: EvalCase): testCase is LegacyEvalCase {
  return "model" in testCase && testCase.model !== undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeRelativePath(root: string, candidate: string): string {
  if (!candidate || path.isAbsolute(candidate)) {
    throw new Error(`fixture 路径必须是相对路径：${candidate}`);
  }
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (
    relative === ""
    || relative.startsWith("..")
    || path.isAbsolute(relative)
  ) {
    throw new Error(`fixture 路径越过临时 workspace：${candidate}`);
  }
  return relative;
}

async function arrangeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const name of Object.keys(files).sort()) {
    const relative = safeRelativePath(root, name);
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, files[name], "utf8");
  }
}

async function collectFiles(
  root: string,
  directory = root,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await collectFiles(root, absolute));
    } else if (entry.isFile()) {
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      result[relative] = await readFile(absolute, "utf8");
    }
  }
  return result;
}

function sanitize<T>(value: T, root: string): T {
  const visit = (input: unknown, key?: string): unknown => {
    if (key === "timestamp") return 0;
    if (typeof input === "string") {
      if (!root) return input;
      if (input === root) return ".";
      if (input.startsWith(`${root}${path.sep}`)) {
        return input.slice(root.length + 1).split(path.sep).join("/");
      }
      return input.split(root).join("<workspace>");
    }
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([childKey, child]) => [
          childKey,
          visit(child, childKey),
        ]),
      );
    }
    return input;
  };
  return visit(structuredClone(value)) as T;
}

function toolCalls(messages: AgentMessage[]): ToolCall[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter(
          (block): block is ToolCall => block.type === "toolCall",
        )
      : [],
  );
}

function protocolFailure(
  run: AgentRunResult,
  events: AgentEvent[],
  entries: SessionEntry[],
): EvalFailure | undefined {
  const starts = events.filter((event) => event.type === "run_start");
  const ends = events.filter((event) => event.type === "run_end");
  if (starts.length !== 1 || ends.length !== 1) {
    return {
      layer: "agent/protocol",
      firstDivergence: "run 必须恰好拥有一个 start 和一个 end",
      observed: `run_start=${starts.length}, run_end=${ends.length}`,
      expected: "run_start=1, run_end=1",
      violatedInvariant: "每次 run 只有一个公开终态",
      nextSignal: "检查 AgentEvent 尾部",
    };
  }
  if (events.at(-1)?.type !== "run_end") {
    return {
      layer: "agent/protocol",
      firstDivergence: "run_end 不是最后一个 AgentEvent",
      observed: events.at(-1)?.type ?? "no event",
      expected: "run_end",
      violatedInvariant: "终态之后不能再产生内部事件",
      nextSignal: "检查 subscriber 收到的最后三个事件",
    };
  }

  const calls = toolCalls(run.messages);
  const callsById = new Map<string, ToolCall>();
  for (const call of calls) {
    if (callsById.has(call.id)) {
      return {
        layer: "model/protocol",
        firstDivergence: `tool call id 重复：${call.id}`,
        observed: call.id,
        expected: "每个 call id 唯一",
        violatedInvariant: "call/result 必须一一配对",
        nextSignal: "检查 assistant content",
      };
    }
    callsById.set(call.id, call);
  }

  const paired = new Set<string>();
  for (const message of run.messages) {
    if (message.role !== "toolResult") continue;
    if (!callsById.has(message.toolCallId)) {
      return {
        layer: "tool/protocol",
        firstDivergence: `孤立 toolResult：${message.toolCallId}`,
        observed: message.toolCallId,
        expected: "此前存在同 id 的 toolCall",
        violatedInvariant: "toolResult 不能脱离 call",
        nextSignal: "从该 result 向前搜索 assistant toolCall",
      };
    }
    if (paired.has(message.toolCallId)) {
      return {
        layer: "tool/protocol",
        firstDivergence: `toolResult 重复：${message.toolCallId}`,
        observed: message.toolCallId,
        expected: "每个 call 只有一个 result",
        violatedInvariant: "call/result 必须一一配对",
        nextSignal: "检查工具完成与 transcript append 的所有权",
      };
    }
    paired.add(message.toolCallId);
  }
  const unpaired = calls.find((call) => !paired.has(call.id));
  if (unpaired) {
    return {
      layer: "model/protocol",
      firstDivergence: `toolCall 没有配对结果：${unpaired.id}`,
      observed: unpaired.id,
      expected: "同 id 的 toolResult 或 skipped result",
      violatedInvariant: "每个已记录的 toolCall 都必须闭合",
      nextSignal: "检查 stopReason 与 tool_skipped/tool_end",
    };
  }

  const messageEntries = entries.filter(
    (entry): entry is Extract<SessionEntry, { type: "message" }> =>
      entry.type === "message",
  );
  if (messageEntries.length !== run.messages.length) {
    return {
      layer: "session",
      firstDivergence: "session 未单调追加完整 transcript",
      observed: `${messageEntries.length} message entries`,
      expected: `${run.messages.length} message entries`,
      violatedInvariant: "session 是 run 事实的 append-only 记录",
      nextSignal: "比较 run_end messages 与 SessionStore.append",
    };
  }
  for (let index = 0; index < run.messages.length; index += 1) {
    if (
      JSON.stringify(messageEntries[index].message)
      !== JSON.stringify(run.messages[index])
    ) {
      return {
        layer: "session",
        firstDivergence: `session message ${index + 1} 与 transcript 不同`,
        observed: messageEntries[index].message.role,
        expected: run.messages[index].role,
        violatedInvariant: "持久化不能改写 canonical message",
        nextSignal: `检查第 ${index + 1} 次 append`,
      };
    }
  }
  return undefined;
}

function failedResult(
  id: string,
  name: string,
  status: Exclude<EvalStatus, "passed">,
  failure: EvalFailure,
  error: string,
  partial: Partial<EvalResult> = {},
): EvalResult {
  const completeFailure: EvalFailure = {
    ...failure,
    observed: failure.observed ?? "case reported a divergence",
    expected: failure.expected ?? "the owning invariant remains true",
    violatedInvariant:
      failure.violatedInvariant ?? "see firstDivergence",
    nextSignal:
      failure.nextSignal ?? "inspect the event tail and file/session delta",
  };
  return {
    id,
    name,
    status,
    passed: false,
    transcript: partial.transcript ?? [],
    events: partial.events ?? [],
    files: partial.files ?? {},
    session: partial.session ?? [],
    metrics: partial.metrics ?? { turns: 0, toolCalls: 0 },
    durationMs: 0,
    failure: completeFailure,
    error,
  };
}

function classify(
  error: unknown,
  phase: "setup" | "run" | "protocol" | "assert" | "cleanup",
): {
  status: Exclude<EvalStatus, "passed">;
  failure: EvalFailure;
  message: string;
} {
  if (error instanceof EvalAssertionError) {
    return {
      status: error.status,
      failure: error.failure,
      message: error.message,
    };
  }
  const message = errorMessage(error);
  if (phase === "assert") {
    return {
      status: "task_failed",
      message,
      failure: {
        layer: "task/assertion",
        firstDivergence: message,
        observed: "任务断言失败",
        expected: "case assertion 通过",
        violatedInvariant: "任务结果必须满足 case 的可执行规格",
        nextSignal: "先比较协议结果，再检查最终文件",
      },
    };
  }
  return {
    status: "infra_failed",
    message,
    failure: {
      layer: phase,
      firstDivergence: `${phase}: ${message}`,
      observed: message,
      expected: `${phase} 阶段可完成`,
      violatedInvariant: "评测基础设施错误不能伪装成任务失败",
      nextSignal: `检查 ${phase} phase 与 cause`,
    },
  };
}

function caseIdentity(testCase: EvalCase): {
  id: string;
  name: string;
} {
  return "id" in testCase && typeof testCase.id === "string"
    ? { id: testCase.id, name: testCase.name ?? testCase.id }
    : { id: testCase.name, name: testCase.name };
}

export async function runEvalCase(testCase: EvalCase): Promise<EvalResult> {
  const identity = caseIdentity(testCase);
  let root = "";
  let runtime: Runtime | undefined;
  let phase: "setup" | "run" | "protocol" | "assert" | "cleanup" = "setup";
  let partial: Partial<EvalResult> = {};
  let outcome: EvalResult | undefined;

  try {
    root = await mkdtemp(path.join(os.tmpdir(), "pi-eval-"));
    const legacy = isLegacyEvalCase(testCase);
    const initialFiles = legacy ? {} : testCase.files;
    await arrangeFiles(root, initialFiles);

    const session = new InMemorySessionStore();
    let entrySequence = 0;
    let logicalTime = 0;
    const model = legacy
      ? testCase.model
      : new ScriptedModel(Array.from(testCase.script));
    const tools = legacy
      ? testCase.tools ?? new ToolRegistry()
      : testCase.tools;
    runtime = await createRuntime(
      {
        cwd: root,
        systemPrompt: legacy ? undefined : testCase.systemPrompt,
        maxSteps: testCase.maxSteps,
      },
      {
        model,
        tools,
        session,
        resources: legacy ? undefined : testCase.resources,
        createId: () => `${identity.id}-entry-${++entrySequence}`,
        now: () => ++logicalTime,
      },
    );

    const rawEvents: AgentEvent[] = [];
    const unsubscribe = runtime.agent.subscribe((event) => {
      rawEvents.push(event);
    });
    phase = "run";
    let run: AgentRunResult;
    try {
      run = await runtime.prompt(testCase.prompt);
      await runtime.flush();
    } finally {
      unsubscribe();
    }

    const rawEntries = await runtime.session.entries();
    const rawFiles = await collectFiles(root);
    const metrics: EvalMetrics = {
      turns: run.steps,
      toolCalls: rawEvents.filter(
        (event) =>
          event.type === "loop" && event.event.type === "tool_start",
      ).length,
    };
    partial = {
      transcript: sanitize(run.messages, root),
      events: sanitize(rawEvents, root),
      files: sanitize(rawFiles, root),
      session: sanitize(rawEntries, root),
      metrics,
    };

    phase = "protocol";
    const violation = protocolFailure(run, rawEvents, rawEntries);
    if (violation) {
      throw new EvalAssertionError("protocol_failed", violation);
    }

    const provisional: EvalResult = {
      id: identity.id,
      name: identity.name,
      status: "passed",
      passed: true,
      transcript: partial.transcript ?? [],
      events: partial.events ?? [],
      files: partial.files ?? {},
      session: partial.session ?? [],
      metrics,
      durationMs: 0,
    };

    phase = "assert";
    if (isLegacyEvalCase(testCase)) {
      const loopEvents = rawEvents.flatMap((event) =>
        event.type === "loop" ? [event.event] : [],
      );
      await testCase.assert(run, loopEvents);
    } else {
      await testCase.assert(provisional);
    }
    outcome = provisional;
  } catch (error) {
    const classified = classify(error, phase);
    outcome = failedResult(
      identity.id,
      identity.name,
      classified.status,
      sanitize(classified.failure, root),
      sanitize(classified.message, root),
      partial,
    );
  }

  phase = "cleanup";
  let cleanupError: unknown;
  try {
    await runtime?.dispose();
  } catch (error) {
    cleanupError = error;
  }
  try {
    if (root) await rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError !== undefined) {
    const classified = classify(cleanupError, phase);
    outcome = failedResult(
      identity.id,
      identity.name,
      classified.status,
      sanitize(classified.failure, root),
      sanitize(classified.message, root),
      partial,
    );
  }

  return outcome ?? failedResult(
    identity.id,
    identity.name,
    "infra_failed",
    {
      layer: "runner",
      firstDivergence: "runner 未产生结果",
    },
    "runner 未产生结果",
  );
}

export async function runEvalSuite(
  cases: readonly EvalCase[],
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const testCase of cases) {
    results.push(await runEvalCase(testCase));
  }
  return results;
}
