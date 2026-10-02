import type { JsonValue } from "./session.js";
import { executeToolCall, ToolRegistry, type Tool } from "./tool.js";
import {
  assistantMessage,
  userMessage,
  type AgentMessage,
  type AssistantMessage,
  type Model,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "./types.js";

/*
 * 只实现四个机制：
 * 1. 先提交再可见：单一变更线 + 原子批量提交 + 快照重开；
 * 2. 重新打开时 running 任务改回 pending；
 * 3. execute() 之前提交意图，恢复时按 replay 决定重跑或 interrupted；
 * 4. 已提交的部分输出转成 aborted entry，再用同样的消息从头重发。
 * JSONL 存储、poison、输出节流、文档与分叉都不在这里。
 */

export type DurableCollection = "entries" | "tasks";

/** 一次提交里的一条写入：按 id 整条替换。 */
export interface DurableWrite {
  collection: DurableCollection;
  id: string;
  value: JsonValue;
}

export interface DurableSnapshot {
  seq: number;
  entries: Record<string, JsonValue>;
  tasks: Record<string, JsonValue>;
}

export class StorageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageRejected";
  }
}

const COLLECTIONS: readonly DurableCollection[] = ["entries", "tasks"];

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) return value.every(isJsonValue);
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      return Object.values(value).every(isJsonValue);
    }
    default:
      return false;
  }
}

type Tables = Record<DurableCollection, Map<string, JsonValue>>;

function emptyTables(): Tables {
  return { entries: new Map(), tasks: new Map() };
}

function rows(table: Map<string, JsonValue>): { id: string; value: JsonValue }[] {
  return [...table].map(([id, value]) => ({ id, value: structuredClone(value) }));
}

/**
 * 内存存储。一次 commit 是一个原子批量写：先检查整批，有一条不合法就整批拒绝
 * （StorageRejected），一条都不落；通过后一起写入并分配递增的 seq。快照可以
 * 导出再导入，用来模拟进程重启。
 */
export class DurableStore {
  private seq = 0;
  private readonly collections = emptyTables();
  private readonly listeners = new Set<
    (seq: number, writes: readonly DurableWrite[]) => void
  >();
  private tail: Promise<void> = Promise.resolve();

  static fromSnapshot(snapshot: DurableSnapshot): DurableStore {
    const store = new DurableStore();
    store.seq = snapshot.seq;
    for (const collection of COLLECTIONS) {
      for (const [id, value] of Object.entries(snapshot[collection])) {
        store.collections[collection].set(id, structuredClone(value));
      }
    }
    return store;
  }

  commit(writes: readonly DurableWrite[]): Promise<number> {
    const operation = this.tail.then(() => {
      // 先验整批，再写整批：中途发现坏记录时还什么都没写。
      for (const write of writes) {
        if (
          !COLLECTIONS.includes(write.collection) ||
          typeof write.id !== "string" ||
          write.id.length === 0 ||
          !isJsonValue(write.value)
        ) {
          throw new StorageRejected(
            `写入 ${String(write.collection)}/${String(write.id)} 不是合法 JSON 记录`,
          );
        }
      }
      const batch = writes.map((write) => ({
        ...write,
        value: structuredClone(write.value),
      }));
      for (const write of batch) {
        this.collections[write.collection].set(write.id, write.value);
      }
      this.seq += 1;
      for (const listener of [...this.listeners]) listener(this.seq, batch);
      return this.seq;
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get(collection: DurableCollection, id: string): JsonValue | undefined {
    const value = this.collections[collection].get(id);
    return value === undefined ? undefined : structuredClone(value);
  }

  list(collection: DurableCollection): { id: string; value: JsonValue }[] {
    return rows(this.collections[collection]);
  }

  snapshot(): DurableSnapshot {
    return structuredClone({
      seq: this.seq,
      entries: Object.fromEntries(this.collections.entries),
      tasks: Object.fromEntries(this.collections.tasks),
    });
  }

  /** 每次成功提交后同步调用；测试用它在第 N 次提交后拍快照。 */
  onCommit(
    listener: (seq: number, writes: readonly DurableWrite[]) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** change 里能看到的、已提交的状态，以及本次要写的东西。 */
export interface Transaction {
  get(collection: DurableCollection, id: string): JsonValue | undefined;
  list(collection: DurableCollection): { id: string; value: JsonValue }[];
  put(collection: DurableCollection, id: string, value: JsonValue): void;
}

/**
 * 单一变更线：所有提交排在一条 promise 链上，一次只有一个 change 在跑。change
 * 只收集写入；它返回后整批交给存储，存储成功后才更新可见状态（adopt）。change
 * 抛错或存储拒绝都不留下任何可见进展。副作用（调模型、跑工具）绝不在 change 里做。
 */
export class DurableSession {
  private readonly view = emptyTables();
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly store: DurableStore) {
    for (const collection of COLLECTIONS) {
      for (const { id, value } of store.list(collection)) {
        this.view[collection].set(id, value);
      }
    }
  }

  get(collection: DurableCollection, id: string): JsonValue | undefined {
    const value = this.view[collection].get(id);
    return value === undefined ? undefined : structuredClone(value);
  }

  list(collection: DurableCollection): { id: string; value: JsonValue }[] {
    return rows(this.view[collection]);
  }

  commit<T>(change: (tx: Transaction) => T | Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const writes: DurableWrite[] = [];
      const result = await change({
        get: (collection, id) => this.get(collection, id),
        list: (collection) => this.list(collection),
        // 不在这里复制或校验：合法性由存储整批检查，坏值让整批被拒绝。
        put: (collection, id, value) => {
          writes.push({ collection, id, value });
        },
      });
      if (writes.length === 0) return result;
      await this.store.commit(writes);
      // adopt：存储成功之后，才让这批写入对本进程可见。
      for (const write of writes) {
        this.view[write.collection].set(write.id, structuredClone(write.value));
      }
      return result;
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export type DurableEntry =
  | { type: "user"; message: UserMessage }
  | { type: "assistant"; message: AssistantMessage }
  | { type: "toolResult"; message: ToolResultMessage };

export interface EntryRecord {
  id: string;
  conversationId: string;
  /** 会话内的顺序号。 */
  index: number;
  entry: DurableEntry;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export type ReplayPolicy = "safe" | "unsafe";

export type GenerationCheckpoint = {
  phase: "request";
  /** 已提交的部分输出；崩溃恢复时变成 aborted entry。 */
  partial?: AssistantMessage;
};

export type ToolCheckpoint =
  | { phase: "call" }
  /** 持久化的意图：最终参数与 replay 策略，记录在 execute() 之前。 */
  | { phase: "execute"; arguments: JsonValue; replay: ReplayPolicy };

export type TaskRecord =
  | {
      id: string;
      kind: "generation";
      conversationId: string;
      order: number;
      status: TaskStatus;
      /** 请求用的消息 = 会话里 index < inputEntryCount 的 entry。 */
      input: { inputEntryCount: number };
      checkpoint: GenerationCheckpoint;
      error?: string;
    }
  | {
      id: string;
      kind: "tool";
      conversationId: string;
      order: number;
      status: TaskStatus;
      input: { assistantEntryId: string; callId: string };
      checkpoint: ToolCheckpoint;
      error?: string;
    };

type GenerationTask = Extract<TaskRecord, { kind: "generation" }>;
type ToolTask = Extract<TaskRecord, { kind: "tool" }>;

export interface DurableToolRegistration {
  tool: Tool;
  /** safe：中断后可以从头重跑；缺省 unsafe。 */
  replay?: ReplayPolicy;
}

export interface DurableHarnessOptions {
  store: DurableStore;
  model: Model;
  tools?: readonly DurableToolRegistration[];
  createId(): string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toolCallsOf(message: AgentMessage): ToolCall[] {
  if (message.role !== "assistant") return [];
  return message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
}

function failedToolResult(
  call: ToolCall,
  code: string,
  message: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: `Tool ${call.name} failed: ${message}` }],
    details: { error: code, message },
    isError: true,
    timestamp: Date.now(),
  };
}

const isSettled = (task: TaskRecord) =>
  task.status === "completed" || task.status === "failed";

/**
 * 一个最小 durable harness：prompt 提交用户 entry 与 generation 任务；run 按顺序
 * 取 pending 任务执行；每个任务的可见进展都先提交再发生。打开时把 running
 * 的任务改回 pending——上一个进程可能正跑到一半。
 */
export class DurableHarness {
  private readonly session: DurableSession;
  private readonly registry = new ToolRegistry();
  private readonly replay = new Map<string, ReplayPolicy>();
  private nextOrder: number;

  private constructor(
    private readonly options: DurableHarnessOptions,
    session: DurableSession,
  ) {
    this.session = session;
    for (const { tool, replay } of options.tools ?? []) {
      this.registry.register(tool);
      this.replay.set(tool.name, replay ?? "unsafe");
    }
    this.nextOrder = Math.max(0, ...this.tasks().map((task) => task.order + 1));
  }

  /** 打开 = 读取已提交状态，并把 running 的任务改回 pending（一次提交）。 */
  static async open(options: DurableHarnessOptions): Promise<DurableHarness> {
    const session = new DurableSession(options.store);
    const harness = new DurableHarness(options, session);
    await session.commit((tx) => {
      for (const { id, value } of tx.list("tasks")) {
        const task = value as unknown as TaskRecord;
        if (task.status === "running") {
          tx.put("tasks", id, toJson({ ...task, status: "pending" }));
        }
      }
    });
    return harness;
  }

  entries(conversationId: string): EntryRecord[] {
    return this.session
      .list("entries")
      .map(({ value }) => value as unknown as EntryRecord)
      .filter((record) => record.conversationId === conversationId)
      .sort((left, right) => left.index - right.index);
  }

  messages(conversationId: string): AgentMessage[] {
    return this.entries(conversationId).map((record) => record.entry.message);
  }

  tasks(): TaskRecord[] {
    return this.session
      .list("tasks")
      .map(({ value }) => value as unknown as TaskRecord)
      .sort((left, right) => left.order - right.order);
  }

  private task(id: string): TaskRecord {
    const task = this.session.get("tasks", id) as unknown as
      | TaskRecord
      | undefined;
    if (!task) throw new Error(`未知任务 ${id}`);
    return task;
  }

  private generationTask(id: string): GenerationTask {
    const task = this.task(id);
    if (task.kind !== "generation") throw new Error(`任务 ${id} 不是 generation`);
    return task;
  }

  private toolTask(id: string): ToolTask {
    const task = this.task(id);
    if (task.kind !== "tool") throw new Error(`任务 ${id} 不是 tool`);
    return task;
  }

  private entry(id: string): EntryRecord {
    const record = this.session.get("entries", id) as unknown as
      | EntryRecord
      | undefined;
    if (!record) throw new Error(`未知 entry ${id}`);
    return record;
  }

  /** index 按事务里已提交的条数分配；同一次提交里只追加一条。 */
  private putEntry(
    tx: Transaction,
    conversationId: string,
    entry: DurableEntry,
  ): EntryRecord {
    const index = tx
      .list("entries")
      .filter(
        ({ value }) =>
          (value as unknown as EntryRecord).conversationId === conversationId,
      ).length;
    const record: EntryRecord = {
      id: this.options.createId(),
      conversationId,
      index,
      entry,
    };
    tx.put("entries", record.id, toJson(record));
    return record;
  }

  private putTask(tx: Transaction, task: TaskRecord): void {
    tx.put("tasks", task.id, toJson(task));
  }

  private newGeneration(
    tx: Transaction,
    conversationId: string,
    inputEntryCount: number,
  ): void {
    this.putTask(tx, {
      id: this.options.createId(),
      kind: "generation",
      conversationId,
      order: this.nextOrder++,
      status: "pending",
      input: { inputEntryCount },
      checkpoint: { phase: "request" },
    });
  }

  /** 用户消息与它触发的 generation 任务在同一次提交里出现：要么都可见，要么都不。 */
  prompt(conversationId: string, value: string): Promise<void> {
    return this.session.commit((tx) => {
      const record = this.putEntry(tx, conversationId, {
        type: "user",
        message: userMessage(value),
      });
      this.newGeneration(tx, conversationId, record.index + 1);
    });
  }

  /**
   * 按 order 取 pending 任务执行，直到没有 pending 任务或 signal 触发。
   * signal 触发时正在跑的任务停在 running：对存储来说这就像进程崩溃。
   */
  async run(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    while (!signal?.aborted) {
      const next = this.tasks().find((task) => task.status === "pending");
      if (!next) return;
      await this.session.commit((tx) => {
        this.putTask(tx, { ...this.task(next.id), status: "running" });
      });
      const finished =
        next.kind === "generation"
          ? await this.runGeneration(next.id, signal)
          : await this.runTool(next.id, signal);
      if (!finished) return;
    }
  }

  /** 返回 false 表示被 signal 打断：任务留在 running，像进程在这里崩溃。 */
  private async runGeneration(
    taskId: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const { conversationId } = this.generationTask(taskId);

    // 恢复：已提交的部分输出成为 aborted entry，检查点清空，再从头重发同样的请求。
    const partial = this.generationTask(taskId).checkpoint.partial;
    if (partial) {
      await this.session.commit((tx) => {
        this.putEntry(tx, conversationId, {
          type: "assistant",
          message: { ...partial, stopReason: "aborted" },
        });
        this.putTask(tx, {
          ...this.generationTask(taskId),
          checkpoint: { phase: "request" },
        });
      });
    }

    const { inputEntryCount } = this.generationTask(taskId).input;
    const messages = this.entries(conversationId)
      .filter((record) => record.index < inputEntryCount)
      .map((record) => record.entry.message);
    const stream = this.options.model.stream(
      { messages, tools: this.registry.definitions() },
      { signal },
    );
    // signal 触发时立刻停止等待模型：对存储来说这就是“进程在这里崩溃”。
    const crashed = new Promise<"crashed">((resolve) => {
      if (signal?.aborted) resolve("crashed");
      signal?.addEventListener("abort", () => resolve("crashed"), {
        once: true,
      });
    });
    let message: AssistantMessage;
    try {
      const events = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([events.next(), crashed]);
        if (next === "crashed") return false;
        if (next.done) break;
        const event = next.value;
        if (event.type !== "text_delta") continue;
        // 部分输出先提交；参考实现每个增量提交一次，不做节流。
        await this.session.commit((tx) => {
          this.putTask(tx, {
            ...this.generationTask(taskId),
            checkpoint: { phase: "request", partial: event.partial },
          });
        });
      }
      const result = await Promise.race([stream.result(), crashed]);
      if (result === "crashed") return false;
      message = result;
    } catch (error) {
      message = assistantMessage([], signal?.aborted ? "aborted" : "error", {
        errorMessage: errorMessage(error),
      });
    }
    if (signal?.aborted) return false;

    // 回复、它的工具任务与本任务完成在同一次提交里出现。
    await this.session.commit((tx) => {
      const record = this.putEntry(tx, conversationId, {
        type: "assistant",
        message,
      });
      if (message.stopReason === "toolUse") {
        for (const call of toolCallsOf(message)) {
          this.putTask(tx, {
            id: this.options.createId(),
            kind: "tool",
            conversationId,
            order: this.nextOrder++,
            status: "pending",
            input: { assistantEntryId: record.id, callId: call.id },
            checkpoint: { phase: "call" },
          });
        }
      }
      this.putTask(tx, {
        ...this.generationTask(taskId),
        status: "completed",
        checkpoint: { phase: "request" },
      });
    });
    return true;
  }

  private readCall(task: ToolTask): ToolCall {
    const record = this.entry(task.input.assistantEntryId);
    const call = toolCallsOf(record.entry.message).find(
      (candidate) => candidate.id === task.input.callId,
    );
    if (!call) {
      throw new Error(`entry ${record.id} 没有 tool call ${task.input.callId}`);
    }
    return call;
  }

  private async runTool(
    taskId: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const task = this.toolTask(taskId);
    const call = this.readCall(task);

    if (task.checkpoint.phase === "execute") {
      // 恢复：存储的意图与当前注册都说 safe 才重跑，否则给模型 interrupted 结果。
      const intent = task.checkpoint;
      if (intent.replay === "safe" && this.replay.get(call.name) === "safe") {
        return this.execute(task, { ...call, arguments: intent.arguments }, signal);
      }
      await this.settle(
        task,
        failedToolResult(
          call,
          "interrupted",
          `Tool ${call.name} was interrupted and may have partially run`,
        ),
        "failed",
        `Tool ${call.name} was interrupted`,
      );
      return true;
    }

    const tool = this.registry.get(call.name);
    if (!tool) {
      await this.settle(task, failedToolResult(call, "unknown_tool", "未知工具"), "completed");
      return true;
    }
    let parameters: unknown;
    try {
      parameters = tool.schema.parse(call.arguments);
    } catch (error) {
      await this.settle(
        task,
        failedToolResult(call, "invalid_arguments", errorMessage(error)),
        "completed",
      );
      return true;
    }
    // 意图先落盘：最终参数与 replay 策略。execute() 在提交之外发生。
    await this.session.commit((tx) => {
      this.putTask(tx, {
        ...this.toolTask(taskId),
        checkpoint: {
          phase: "execute",
          arguments: toJson(parameters),
          replay: this.replay.get(call.name) ?? "unsafe",
        },
      });
    });
    return this.execute(task, { ...call, arguments: parameters }, signal);
  }

  private async execute(
    task: ToolTask,
    call: ToolCall,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const result = await executeToolCall(call, this.registry, { signal });
    if (signal?.aborted) return false;
    await this.settle(task, result, "completed");
    return true;
  }

  /** 结果 entry 与任务终态同一次提交；本轮工具都有结果后，同一次提交里创建下一轮 generation。 */
  private settle(
    task: ToolTask,
    result: ToolResultMessage,
    status: "completed" | "failed",
    error?: string,
  ): Promise<void> {
    return this.session.commit((tx) => {
      const record = this.putEntry(tx, task.conversationId, {
        type: "toolResult",
        message: result,
      });
      this.putTask(tx, {
        ...this.toolTask(task.id),
        status,
        ...(error === undefined ? {} : { error }),
      });
      const siblingsSettled = this.tasks()
        .filter(
          (candidate) =>
            candidate.kind === "tool" &&
            candidate.input.assistantEntryId === task.input.assistantEntryId &&
            candidate.id !== task.id,
        )
        .every(isSettled);
      if (siblingsSettled) {
        this.newGeneration(tx, task.conversationId, record.index + 1);
      }
    });
  }
}
