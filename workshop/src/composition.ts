import { randomUUID } from "node:crypto";
import path from "node:path";
import { Agent, type AgentEvent, type SystemUpdate } from "./agent.js";
import type {
  AgentRequest,
  AgentRunResult,
  PreparedRequest,
} from "./agent-loop.js";
import { createCodingTools, type ContainmentMode } from "./coding-tools.js";
import {
  activateSkill,
  createExtensionHost,
  formatResourceContext,
  RESOURCE_SECTION,
  type ActivatedSkill,
  type ExtensionHost,
  type ResourceCatalog,
} from "./resources.js";
import {
  InMemorySessionStore,
  JsonlSessionStore,
  pathTo,
  type JsonValue,
  type SessionEntry,
  type SessionStore,
} from "./session.js";
import {
  ToolRegistry,
  type Tool,
} from "./tool.js";
import {
  currentSystemMessage,
  type AgentMessage,
  type AssistantMessage,
  type Model,
} from "./types.js";

/**
 * RuntimeConfig 只描述产品策略；可替换的副作用依赖放在 RuntimeDeps。
 *
 * model 暂时保留在 config 上，以兼容前几章的
 * createRuntime({ cwd, model }) 调用。新代码应使用第二个 deps 参数。
 */
export interface RuntimeConfig {
  cwd: string;
  systemPrompt?: string;
  sessionFile?: string;
  containment?: ContainmentMode;
  maxSteps?: number;
  tokenBudget?: number;
  activeSkills?: string[];
  /** @deprecated 请通过 RuntimeDeps.model 注入。 */
  model?: Model;
}

/**
 * 额外的 system 段落来源（例如 MCP 服务器清单）。每次 prompt 前调用一次，
 * 返回的段落并入期望 system 状态，仍只在变化时打补丁。
 */
export interface SystemSectionProvider {
  sections(): Promise<Record<string, string>> | Record<string, string>;
}

/**
 * 请求前钩子看到的 session 视角：branch 是当前 active path 加上本轮已记录但
 * 尚未落盘的 metadata；record 只是缓冲，等本轮消息 suffix 落盘后再追加。
 */
export interface RuntimeRequestSession {
  branch(): readonly SessionEntry[];
  record(key: string, value: JsonValue): void;
}

export type RuntimePrepareRequest = (
  request: AgentRequest,
  session: RuntimeRequestSession,
  signal?: AbortSignal,
) =>
  | PreparedRequest
  | undefined
  | void
  | Promise<PreparedRequest | undefined | void>;

export interface RuntimeDeps {
  model: Model;
  tools?: ToolRegistry | readonly Tool[];
  session?: SessionStore;
  resources?: ResourceCatalog;
  extensionHost?: ExtensionHost;
  sectionProviders?: readonly SystemSectionProvider[];
  prepareRequest?: RuntimePrepareRequest;
  createId?: () => string;
  now?: () => number;
}

export interface ResolvedRuntimeConfig {
  cwd: string;
  /** 期望的基础 prompt；只在 transcript 还没有 system message 时写入一次。 */
  systemPrompt?: string;
  /** 期望的具名段落；资源为空时不含 RESOURCE_SECTION。 */
  systemSections: Readonly<Record<string, string>>;
  containment: ContainmentMode;
  maxSteps?: number;
  tokenBudget: number;
  activeSkills: readonly string[];
}

export interface Runtime {
  agent: Agent;
  /**
   * 产品入口：先把期望的 system 状态与 transcript 重放结果比较，只在有变化时
   * 通过 agent.prompt(value, { system }) 追加补丁。直接调用 agent.prompt
   * 会跳过这一步。
   */
  prompt(value: string): Promise<AgentRunResult>;
  /**
   * 在当前 leaf 之后追加一条 metadata entry（例如虚拟模型的 model_change）；
   * 进行中的 prompt 先结束、它的 suffix 先排队，再追加这一条。
   */
  appendMetadata(key: string, value: JsonValue): Promise<void>;
  /** active path 的最后一条 entry；空 session 为 null。 */
  getActiveLeafId(): string | null;
  session: SessionStore;
  resources: ResourceCatalog;
  activatedSkills: readonly ActivatedSkill[];
  extensions: ExtensionHost;
  config: Readonly<ResolvedRuntimeConfig>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

function emptyResources(): ResourceCatalog {
  return {
    resources: [],
    templates: [],
    skills: [],
    diagnostics: [],
    diagnosticMessages: [],
  };
}

function resolveDeps(
  config: RuntimeConfig,
  deps: RuntimeDeps | undefined,
): RuntimeDeps {
  if (deps) return deps;
  if (config.model) return { model: config.model };
  throw new Error("createRuntime 需要通过 RuntimeDeps 注入 model");
}

function resolveTools(
  config: ResolvedRuntimeConfig,
  tools: RuntimeDeps["tools"],
): ToolRegistry {
  if (tools instanceof ToolRegistry) return tools;
  if (tools) return new ToolRegistry(Array.from(tools));
  return createCodingTools({
    cwd: config.cwd,
    containment: config.containment,
  });
}

/**
 * 比较重放出的段落与期望段落，返回 SystemMessage.sections 补丁；
 * 期望中不存在的段落写 null，没有变化时返回 undefined。
 */
export function diffSystemSections(
  previous: Readonly<Record<string, string | null>>,
  desired: Readonly<Record<string, string>>,
): Record<string, string | null> | undefined {
  const patch: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(desired)) {
    if (previous[name] !== value) patch[name] = value;
  }
  for (const name of Object.keys(previous)) {
    if (desired[name] === undefined) patch[name] = null;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * transcript 是事实：还没有 system message 时写入开头一条（基础 prompt + 段落）；
 * 已有时只为变化的段落生成补丁，基础 prompt 的配置差异被忽略。
 */
function planSystemUpdate(
  messages: readonly AgentMessage[],
  config: Pick<ResolvedRuntimeConfig, "systemPrompt" | "systemSections">,
): SystemUpdate | undefined {
  const current = currentSystemMessage(messages);
  const hasSections = Object.keys(config.systemSections).length > 0;
  if (!current) {
    if (!config.systemPrompt && !hasSections) return undefined;
    return {
      content: config.systemPrompt ?? "",
      ...(hasSections ? { sections: { ...config.systemSections } } : {}),
    };
  }
  const sections = diffSystemSections(
    current.sections ?? {},
    config.systemSections,
  );
  return sections ? { sections } : undefined;
}

/**
 * Composition root 是具体依赖唯一相遇的地方。Mode adapter 只能借用这里
 * 构造出的 Runtime，不能自行创建第二份 Agent 或 SessionStore。
 */
export function createRuntime(
  config: RuntimeConfig & { model: Model },
): Promise<Runtime>;
export function createRuntime(
  config: RuntimeConfig,
  deps: RuntimeDeps,
): Promise<Runtime>;
export async function createRuntime(
  config: RuntimeConfig,
  deps?: RuntimeDeps,
): Promise<Runtime> {
  const injected = resolveDeps(config, deps);
  if (injected.session && config.sessionFile) {
    throw new Error("session 与 sessionFile 不能同时指定");
  }

  const resources = injected.resources ?? emptyResources();
  const activeSkills = [...new Set(config.activeSkills ?? [])];
  const activatedSkills: ActivatedSkill[] = [];
  for (const name of activeSkills) {
    activatedSkills.push(await activateSkill(resources, name));
  }
  const resourceText = formatResourceContext(resources, activatedSkills);
  const resolvedConfig: ResolvedRuntimeConfig = {
    cwd: path.resolve(config.cwd),
    systemPrompt: config.systemPrompt?.trim() || undefined,
    systemSections: Object.freeze<Record<string, string>>(
      resourceText ? { [RESOURCE_SECTION]: resourceText } : {},
    ),
    containment: config.containment ?? "workspace",
    maxSteps: config.maxSteps,
    tokenBudget: config.tokenBudget ?? 32_000,
    activeSkills,
  };
  const tools = resolveTools(resolvedConfig, injected.tools);
  const extensions =
    injected.extensionHost ?? createExtensionHost(tools);
  const session = injected.session
    ?? (config.sessionFile
      ? await JsonlSessionStore.open(path.resolve(config.sessionFile))
      : new InMemorySessionStore());
  const createId = injected.createId ?? randomUUID;
  const now = injected.now ?? Date.now;
  const existingEntries = await session.entries();
  const leaf = existingEntries.at(-1);
  // active path 在内存里保留一份：请求前钩子同步读取分支，不必等落盘。
  const activePath: SessionEntry[] = leaf
    ? pathTo(existingEntries, leaf.id)
    : [];
  // 恢复 active path 上的 transcript；之后只在其后追加，前缀永不改写。
  const restored = activePath.flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
  /** 本轮请求前钩子记录、尚未落盘的 metadata。 */
  const pendingMetadata: { key: string; value: JsonValue }[] = [];

  const metadataEntry = (
    key: string,
    value: JsonValue,
    parentId: string | null,
    id = createId(),
  ): SessionEntry => ({
    id,
    parentId,
    timestamp: now(),
    type: "metadata",
    key,
    value: structuredClone(value),
  });

  const requestSession: RuntimeRequestSession = {
    branch: () => {
      let parentId = activePath.at(-1)?.id ?? null;
      const pending = pendingMetadata.map(({ key, value }, index) => {
        const entry = metadataEntry(
          key,
          value,
          parentId,
          `__runtime_pending_${index}`,
        );
        parentId = entry.id;
        return entry;
      });
      return [...structuredClone(activePath), ...pending];
    },
    record: (key, value) => {
      pendingMetadata.push({ key, value: structuredClone(value) });
    },
  };
  const prepareRequest = injected.prepareRequest;

  const agent = new Agent({
    model: injected.model,
    tools,
    toolExecutor: extensions.executeToolCall,
    messages: restored,
    maxSteps: resolvedConfig.maxSteps,
    ...(prepareRequest
      ? {
          prepareRequest: (request, signal) =>
            prepareRequest(request, requestSession, signal),
        }
      : {}),
  });

  let persistedMessages = restored.length;
  let persistence = Promise.resolve();
  /** 先同步接到 active path，再排进落盘队列；顺序就是 parent 链。 */
  const enqueue = (
    build: (parentId: string | null) => SessionEntry,
  ): void => {
    const entry = build(activePath.at(-1)?.id ?? null);
    activePath.push(structuredClone(entry));
    persistence = persistence.then(() => session.append(entry));
  };
  const unsubscribePersistence = agent.subscribe((event) => {
    if (event.type !== "run_end") return;
    const additions = event.result.messages.slice(persistedMessages);
    persistedMessages = event.result.messages.length;
    for (const message of additions) {
      enqueue((parentId) => ({
        id: createId(),
        parentId,
        timestamp: now(),
        type: "message",
        message,
      }));
    }
    // 本轮记录的 metadata 跟在消息 suffix 之后落盘，顺序是一个有记录的事实。
    for (const { key, value } of pendingMetadata.splice(0)) {
      enqueue((parentId) => metadataEntry(key, value, parentId));
    }
  });

  const sectionProviders = injected.sectionProviders ?? [];
  /** 期望段落 = 配置与资源的段落 + 各段落提供者本次给出的段落。 */
  const desiredSections = async (): Promise<Record<string, string>> => {
    const sections = { ...resolvedConfig.systemSections };
    for (const provider of sectionProviders) {
      Object.assign(sections, await provider.sections());
    }
    return sections;
  };

  let running: Promise<unknown> = Promise.resolve();
  let disposed = false;
  return {
    agent,
    async prompt(value) {
      const systemSections = await desiredSections();
      const system = planSystemUpdate(agent.getState().messages, {
        systemPrompt: resolvedConfig.systemPrompt,
        systemSections,
      });
      // 缓冲的 metadata 由 run_end 处理器在消息 suffix 之后取走；这里不清空，
      // 否则一次被 "Agent is busy" 拒绝的并发调用会丢掉进行中那轮的记录。
      const run = agent.prompt(value, system ? { system } : {});
      running = Promise.all([running, run.catch(() => undefined)]);
      return run;
    },
    async appendMetadata(key, value) {
      if (disposed) throw new Error("Runtime 已 dispose");
      await running;
      enqueue((parentId) => metadataEntry(key, value, parentId));
      await persistence;
    },
    getActiveLeafId: () => activePath.at(-1)?.id ?? null,
    session,
    resources,
    activatedSkills,
    extensions,
    config: Object.freeze(resolvedConfig),
    flush: () => persistence,
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribePersistence();
      await persistence;
    },
  };
}

export type WirePayload =
  | { type: "text_delta"; text: string }
  | { type: "tool_end"; callId: string; isError: boolean }
  | {
      type: "result";
      status: "ok" | "error" | "aborted";
    };

export type WireEvent = WirePayload & {
  v: 1;
  seq: number;
};

export function createWireSequencer(): (
  payload: WirePayload,
) => WireEvent {
  let sequence = 0;
  return (payload) => ({
    ...payload,
    v: 1,
    seq: ++sequence,
  });
}

function publicPayload(event: AgentEvent): WirePayload | undefined {
  if (
    event.type === "loop"
    && event.event.type === "model_event"
    && event.event.event.type === "text_delta"
  ) {
    return {
      type: "text_delta",
      text: event.event.event.delta,
    };
  }
  if (
    event.type === "loop"
    && (event.event.type === "tool_end"
      || event.event.type === "tool_skipped")
  ) {
    return {
      type: "tool_end",
      callId: event.event.result.toolCallId,
      isError: event.event.result.isError,
    };
  }
  if (event.type === "run_end") {
    return {
      type: "result",
      status: wireStatus(event.result.reason),
    };
  }
  return undefined;
}

function wireStatus(
  reason: AgentRunResult["reason"],
): Extract<WirePayload, { type: "result" }>["status"] {
  if (reason === "stop") return "ok";
  if (reason === "aborted") return "aborted";
  return "error";
}

function exitCode(reason: AgentRunResult["reason"]): number {
  if (reason === "stop") return 0;
  if (reason === "aborted") return 130;
  return 1;
}

function finalAssistant(
  result: AgentRunResult,
): AssistantMessage | undefined {
  return result.messages.findLast(
    (message): message is AssistantMessage => message.role === "assistant",
  );
}

function finalText(result: AgentRunResult): string {
  return (finalAssistant(result)?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function diagnostic(result: AgentRunResult): string {
  const assistant = finalAssistant(result);
  return assistant?.errorMessage
    ? `[${result.reason}] ${assistant.errorMessage}\n`
    : `[${result.reason}] Agent run did not complete successfully\n`;
}

export interface ModeIO {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  setExitCode?(code: number): void;
}

export type ProductMode = "interactive" | "print" | "json";

export interface ModeRunResult {
  result: AgentRunResult;
  transcript: AgentRunResult["messages"];
  wireEvents: WireEvent[];
  status: Extract<WirePayload, { type: "result" }>["status"];
  exitCode: number;
}

const DISCARD_IO: ModeIO = {
  stdout() {},
  stderr() {},
};

/**
 * 三种产品入口共用同一次 Agent run；这里仅映射 I/O 协议。
 * JSON 输出只包含白名单 WireEvent，绝不序列化内部 AgentEvent。
 */
export async function runMode(
  runtime: Runtime,
  mode: ProductMode,
  prompt: string,
  io: ModeIO = DISCARD_IO,
): Promise<ModeRunResult> {
  const internalEvents: AgentEvent[] = [];
  const unsubscribe = runtime.agent.subscribe((event) => {
    internalEvents.push(event);
  });

  let result: AgentRunResult;
  try {
    result = await runtime.prompt(prompt);
    await runtime.flush();
  } finally {
    unsubscribe();
  }

  const sequence = createWireSequencer();
  const wireEvents = internalEvents.flatMap((event) => {
    const payload = publicPayload(event);
    return payload ? [sequence(payload)] : [];
  });
  const status = wireStatus(result.reason);
  const code = exitCode(result.reason);

  for (const message of runtime.resources.diagnosticMessages) {
    io.stderr(`[diagnostic] ${message}\n`);
  }
  if (mode === "json") {
    for (const event of wireEvents) {
      io.stdout(`${JSON.stringify(event)}\n`);
    }
  } else if (status === "ok") {
    if (mode === "interactive") {
      const streamed = wireEvents
        .filter(
          (event): event is WireEvent & { type: "text_delta"; text: string } =>
            event.type === "text_delta",
        )
        .map((event) => event.text)
        .join("");
      io.stdout(streamed || finalText(result));
    } else {
      io.stdout(finalText(result));
    }
  }

  if (code !== 0) io.stderr(diagnostic(result));
  io.setExitCode?.(code);

  return {
    result,
    transcript: structuredClone(result.messages),
    wireEvents,
    status,
    exitCode: code,
  };
}

export function runPrint(
  runtime: Runtime,
  prompt: string,
  io: ModeIO = DISCARD_IO,
): Promise<ModeRunResult> {
  return runMode(runtime, "print", prompt, io);
}

export function runJson(
  runtime: Runtime,
  prompt: string,
  io: ModeIO = DISCARD_IO,
): Promise<ModeRunResult> {
  return runMode(runtime, "json", prompt, io);
}

export function runInteractive(
  runtime: Runtime,
  prompt: string,
  io: ModeIO = DISCARD_IO,
): Promise<ModeRunResult> {
  return runMode(runtime, "interactive", prompt, io);
}

function memoryIO(): {
  io: ModeIO;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    },
  };
}

/** 兼容前几章返回字符串的 helper。 */
export async function runPrintMode(
  runtime: Runtime,
  prompt: string,
): Promise<string> {
  const output = memoryIO();
  await runPrint(runtime, prompt, output.io);
  return output.stdout.join("");
}

/** 兼容前几章返回 JSONL 字符串的 helper。 */
export async function runJsonMode(
  runtime: Runtime,
  prompt: string,
): Promise<string> {
  const output = memoryIO();
  await runJson(runtime, prompt, output.io);
  return output.stdout.join("");
}

/** 交互入口的无 UI 参考 adapter，真实 TTY 只需替换 ModeIO。 */
export async function runInteractiveMode(
  runtime: Runtime,
  prompt: string,
): Promise<string> {
  const output = memoryIO();
  await runInteractive(runtime, prompt, output.io);
  return output.stdout.join("");
}
