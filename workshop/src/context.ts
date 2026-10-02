import {
  pathTo,
  type CompactionSummary,
  type SessionEntry,
  type SessionStore,
} from "./session.js";
import {
  currentSystemMessage,
  systemMessageText,
  text,
  type AgentContext,
  type AgentMessage,
} from "./types.js";

type MessageEntry = Extract<SessionEntry, { type: "message" }>;
type SessionCompactionEntry = Extract<
  SessionEntry,
  { type: "compaction" }
>;

export interface ContextUsage {
  system: number;
  messages: number;
  total: number;
  budget: number;
  overflow: boolean;
  reservedOutput: number;
  safetyMargin: number;
  tokensBefore: number;
}

export type ContextSelectionReason =
  | "within_budget"
  | "budget_tail"
  | "single_group_overflow";

export interface ContextBuildResult {
  /**
   * 正文 API：projection 本身可以直接交给 model.stream。
   * messages = [当前 system message?, compaction 摘要?, ...保留的后缀]。
   */
  messages: AgentMessage[];
  usage: ContextUsage;
  sourceEntryIds: string[];
  firstKeptEntryId?: string;
  safeCutEntryId?: string;
  tokensBefore: number;
  selection: {
    reason: ContextSelectionReason;
    firstKeptEntryId?: string;
  };

  /**
   * 第 11 章之前的兼容 API。它们与上面的字段引用同一份投影，
   * 不形成第二个可写 transcript。
   */
  context: AgentContext;
  usedEntryIds: string[];
  omittedEntryIds: string[];
  estimatedTokens: number;
}

export interface ContextOptions {
  /**
   * 模型窗口中可供本次请求使用的总额度。输出预留与安全余量会先扣除。
   */
  tokenBudget: number;
  reservedOutputTokens?: number;
  safetyMarginTokens?: number;
  estimateTokens?(message: AgentMessage): number;
  estimateTextTokens?(value: string): number;
}

export interface InteractionGroup {
  messages: AgentMessage[];
  sourceEntryIds: string[];
  toolCallIds: string[];
}

export interface MessageSource {
  entryId: string;
  message: AgentMessage;
}

export interface DetailedCompactionSummary extends CompactionSummary {
  constraints: string[];
  completed: string[];
  changedFiles: string[];
  unresolved: string[];
  next: string[];
}

export type CompactionSummaryInput =
  | CompactionSummary
  | {
      goal: string;
      constraints: string[];
      completed: string[];
      decisions: string[];
      changedFiles: string[];
      unresolved: string[];
      next: string[];
    };

export type CompactionEntry = SessionCompactionEntry & {
  firstKeptEntryId: string;
  tokensBefore: number;
};

export interface AppendCompactionInput {
  id: string;
  parentId: string;
  timestamp: number | string;
  firstKeptEntryId: string;
  summary: CompactionSummaryInput;
  tokensBefore: number;
}

export interface StoreCompactionOptions {
  store: SessionStore;
  leafId: string;
  summarizer: Summarizer;
  id: string;
  timestamp?: number;
}

interface SelectedGroups {
  groups: InteractionGroup[];
  reason: ContextSelectionReason;
}

function isSystemEntry(entry: MessageEntry): boolean {
  return entry.message.role === "system";
}

function defaultEstimate(message: AgentMessage): number {
  return Math.ceil(JSON.stringify(message).length / 4);
}

function defaultEstimateText(value: string): number {
  return value.length === 0 ? 0 : Math.ceil(value.length / 4);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数`);
  }
}

function messageSources(
  input:
    | readonly AgentMessage[]
    | readonly MessageSource[]
    | readonly MessageEntry[],
  explicitIds?: readonly string[],
): MessageSource[] {
  if (explicitIds && explicitIds.length !== input.length) {
    throw new Error("sourceEntryIds 与 messages 数量不一致");
  }

  return input.map((item, index) => {
    if (
      "entryId" in item &&
      typeof item.entryId === "string" &&
      "message" in item
    ) {
      return { entryId: item.entryId, message: item.message };
    }
    if ("type" in item && item.type === "message" && "id" in item) {
      return { entryId: item.id, message: item.message };
    }
    return {
      entryId: explicitIds?.[index] ?? `message:${index}`,
      message: item as AgentMessage,
    };
  });
}

/**
 * 把 canonical messages 分成可独立裁剪的 interaction。
 *
 * 每个 user message 开启一个新组；其后的 assistant/toolResult 往返都留在
 * 同一组。toolResult 依靠 call id 配对，而不是依靠完成顺序或数组相邻性。
 * system message 是固定成本，不属于任何 interaction，分组时直接跳过。
 */
export function groupInteractions(
  input:
    | readonly AgentMessage[]
    | readonly MessageSource[]
    | readonly MessageEntry[],
  sourceEntryIds?: readonly string[],
): InteractionGroup[] {
  const sources = messageSources(input, sourceEntryIds);
  const groups: InteractionGroup[] = [];
  let current: InteractionGroup | undefined;
  let pendingCalls = new Set<string>();
  let seenResults = new Set<string>();

  const finish = (): void => {
    if (!current) return;
    if (pendingCalls.size > 0) {
      throw new Error(
        `incomplete_tool_calls:${[...pendingCalls].sort().join(",")}`,
      );
    }
    groups.push(current);
    current = undefined;
    pendingCalls = new Set();
    seenResults = new Set();
  };

  for (const source of sources) {
    const message = source.message;
    if (message.role === "system") continue;
    if (message.role === "user") {
      finish();
      current = {
        messages: [],
        sourceEntryIds: [],
        toolCallIds: [],
      };
    } else if (!current) {
      if (message.role === "toolResult") {
        throw new Error(`orphan_tool_result:${message.toolCallId}`);
      }
      current = {
        messages: [],
        sourceEntryIds: [],
        toolCallIds: [],
      };
    }

    if (message.role === "toolResult") {
      if (!pendingCalls.has(message.toolCallId)) {
        const code = seenResults.has(message.toolCallId)
          ? "duplicate_tool_result"
          : "orphan_tool_result";
        throw new Error(`${code}:${message.toolCallId}`);
      }
      pendingCalls.delete(message.toolCallId);
      seenResults.add(message.toolCallId);
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (
          pendingCalls.has(block.id) ||
          seenResults.has(block.id) ||
          current.toolCallIds.includes(block.id)
        ) {
          throw new Error(`duplicate_tool_call:${block.id}`);
        }
        pendingCalls.add(block.id);
        current.toolCallIds.push(block.id);
      }
    }

    current.messages.push(message);
    current.sourceEntryIds.push(source.entryId);
  }
  finish();
  return groups;
}

function selectGroups(
  groups: InteractionGroup[],
  tokenBudget: number,
  estimate: (message: AgentMessage) => number,
): SelectedGroups {
  if (groups.length === 0) {
    return { groups: [], reason: "within_budget" };
  }
  const costs = groups.map((group) =>
    group.messages.reduce((sum, message) => sum + estimate(message), 0),
  );
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (total <= tokenBudget) {
    return { groups, reason: "within_budget" };
  }

  const selected: InteractionGroup[] = [];
  let used = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const cost = costs[index];
    if (selected.length === 0 && cost > tokenBudget) {
      return {
        groups: [groups[index]],
        reason: "single_group_overflow",
      };
    }
    if (used + cost > tokenBudget) break;
    selected.unshift(groups[index]);
    used += cost;
  }
  return { groups: selected, reason: "budget_tail" };
}

/**
 * 第 11 章早期练习使用的兼容 helper。它保证 assistant toolCall 与紧随其后的
 * results 不会被拆开；完整的 user-turn 安全边界由 groupInteractions/buildContext
 * 提供。
 */
function legacySemanticGroups(input: AgentMessage[]): AgentMessage[][] {
  // system message 不参与尾部裁剪：它总是由 buildContext 作为固定成本重放。
  const messages = input.filter((message) => message.role !== "system");
  const groups: AgentMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message.role === "assistant" &&
      message.content.some((block) => block.type === "toolCall")
    ) {
      const callIds = new Set(
        message.content
          .filter((block) => block.type === "toolCall")
          .map((block) => block.id),
      );
      const group: AgentMessage[] = [message];
      while (index + 1 < messages.length) {
        const next = messages[index + 1];
        if (
          next.role !== "toolResult" ||
          !callIds.has(next.toolCallId)
        ) {
          break;
        }
        group.push(next);
        index += 1;
      }
      groups.push(group);
    } else {
      groups.push([message]);
    }
  }
  return groups;
}

export function safeTail(
  messages: AgentMessage[],
  tokenBudget: number,
  estimate: (message: AgentMessage) => number = defaultEstimate,
): AgentMessage[] {
  const groups = legacySemanticGroups(messages);
  const selected: AgentMessage[][] = [];
  let used = 0;

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const cost = groups[index].reduce(
      (sum, message) => sum + estimate(message),
      0,
    );
    if (selected.length > 0 && used + cost > tokenBudget) break;
    selected.unshift(groups[index]);
    used += cost;
    if (used >= tokenBudget) break;
  }
  return selected.flat();
}

function summaryValues(
  summary: CompactionSummary | DetailedCompactionSummary,
): {
  constraints: string[];
  completed: string[];
  changedFiles: string[];
  unresolved: string[];
  next: string[];
} {
  const detailed = summary as Partial<DetailedCompactionSummary>;
  return {
    constraints: detailed.constraints ?? summary.invariants,
    completed: detailed.completed ?? [],
    changedFiles: detailed.changedFiles ?? summary.files,
    unresolved: detailed.unresolved ?? [],
    next: detailed.next ?? summary.nextSteps,
  };
}

function summaryText(
  summary: CompactionSummary | DetailedCompactionSummary,
): string {
  const values = summaryValues(summary);
  return [
    `Goal: ${summary.goal}`,
    `Constraints: ${values.constraints.join("; ")}`,
    `Completed: ${values.completed.join("; ")}`,
    `Decisions: ${summary.decisions.join("; ")}`,
    `Changed files: ${values.changedFiles.join(", ")}`,
    `Unresolved: ${values.unresolved.join("; ")}`,
    `Next: ${values.next.join("; ")}`,
    `Invariants: ${summary.invariants.join("; ")}`,
  ].join("\n");
}

function normalizeSummary(
  input: CompactionSummaryInput,
): CompactionSummary | DetailedCompactionSummary {
  if (!input || typeof input !== "object") {
    throw new Error("invalid_compaction_summary: summary 必须是 object");
  }
  if (typeof input.goal !== "string" || input.goal.trim() === "") {
    throw new Error("invalid_compaction_summary: goal 不能为空");
  }

  if ("changedFiles" in input) {
    for (const field of [
      "constraints",
      "completed",
      "decisions",
      "changedFiles",
      "unresolved",
      "next",
    ] as const) {
      const value = input[field];
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string")
      ) {
        throw new Error(
          `invalid_compaction_summary: ${field} 必须是 string[]`,
        );
      }
    }
    return {
      goal: input.goal,
      constraints: [...input.constraints],
      completed: [...input.completed],
      decisions: [...input.decisions],
      changedFiles: [...input.changedFiles],
      unresolved: [...input.unresolved],
      next: [...input.next],
      // 保持第 10 章既有 SessionEntry union 可持久化。
      files: [...input.changedFiles],
      nextSteps: [...input.next],
      invariants: [...input.constraints],
    };
  }
  for (const field of [
    "decisions",
    "files",
    "nextSteps",
    "invariants",
  ] as const) {
    const value = input[field];
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string")
    ) {
      throw new Error(
        `invalid_compaction_summary: ${field} 必须是 string[]`,
      );
    }
  }
  return {
    goal: input.goal,
    decisions: [...input.decisions],
    files: [...input.files],
    nextSteps: [...input.nextSteps],
    invariants: [...input.invariants],
  };
}

function compactionProjectionFields(
  entry: SessionCompactionEntry,
): { firstKeptEntryId?: string; tokensBefore?: number } {
  const candidate = entry as SessionCompactionEntry &
    Partial<Pick<CompactionEntry, "firstKeptEntryId" | "tokensBefore">>;
  return {
    firstKeptEntryId: candidate.firstKeptEntryId,
    tokensBefore: candidate.tokensBefore,
  };
}

function buildProjection(
  activePath: SessionEntry[],
  options: ContextOptions,
): ContextBuildResult {
  assertNonNegativeInteger(options.tokenBudget, "tokenBudget");
  const reservedOutput = options.reservedOutputTokens ?? 0;
  const safetyMargin = options.safetyMarginTokens ?? 0;
  assertNonNegativeInteger(reservedOutput, "reservedOutputTokens");
  assertNonNegativeInteger(safetyMargin, "safetyMarginTokens");

  const estimate = options.estimateTokens ?? defaultEstimate;
  const estimateText = options.estimateTextTokens ?? defaultEstimateText;
  const compactionIndex = activePath.findLastIndex(
    (entry) => entry.type === "compaction",
  );
  const latestCompaction =
    compactionIndex >= 0
      ? (activePath[compactionIndex] as SessionCompactionEntry)
      : undefined;
  const projectionFields = latestCompaction
    ? compactionProjectionFields(latestCompaction)
    : {};

  let suffixStart = compactionIndex + 1;
  if (latestCompaction && projectionFields.firstKeptEntryId) {
    const firstKeptIndex = activePath.findIndex(
      (entry) => entry.id === projectionFields.firstKeptEntryId,
    );
    if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) {
      throw new Error(
        `invalid_compaction_boundary:${projectionFields.firstKeptEntryId}`,
      );
    }
    suffixStart = firstKeptIndex;
  }

  const allMessageEntries = activePath.filter(
    (entry): entry is MessageEntry => entry.type === "message",
  );
  // system message 从整条 active path（包括 compaction 之前）收集并重放，
  // 作为固定成本放在最前面；它们不进入 interaction 分组。
  const systemEntries = allMessageEntries.filter(isSystemEntry);
  const systemIds = systemEntries.map((entry) => entry.id);
  const systemMessage = currentSystemMessage(
    systemEntries.map((entry) => entry.message),
  );
  const candidateEntries = activePath
    .slice(suffixStart)
    .filter(
      (entry): entry is MessageEntry =>
        entry.type === "message" && !isSystemEntry(entry),
    );
  const candidateGroups = groupInteractions(candidateEntries);

  const summaryMessage = latestCompaction
    ? ({
        role: "user",
        content: [
          text(
            `[Earlier session summary]\n${summaryText(
              latestCompaction.summary,
            )}`,
          ),
        ],
        timestamp: latestCompaction.timestamp,
      } satisfies AgentMessage)
    : undefined;
  const summaryCost = summaryMessage ? estimate(summaryMessage) : 0;
  const systemTokens = systemMessage
    ? estimateText(systemMessageText(systemMessage))
    : 0;
  const availableInput = Math.max(
    0,
    options.tokenBudget - reservedOutput - safetyMargin,
  );
  const availableForTail = Math.max(
    0,
    availableInput - systemTokens - summaryCost,
  );
  const selected = selectGroups(
    candidateGroups,
    availableForTail,
    estimate,
  );
  const selectedMessages = selected.groups.flatMap(
    (group) => group.messages,
  );
  const selectedIds = selected.groups.flatMap(
    (group) => group.sourceEntryIds,
  );
  const selectedIdSet = new Set(selectedIds);
  // system entry 总是被使用；used ∪ omitted 仍覆盖全部 message entry。
  const omittedIds = allMessageEntries
    .filter(
      (entry) => !isSystemEntry(entry) && !selectedIdSet.has(entry.id),
    )
    .map((entry) => entry.id);
  const conversationMessages = summaryMessage
    ? [summaryMessage, ...selectedMessages]
    : selectedMessages;
  const contextMessages = systemMessage
    ? [systemMessage, ...conversationMessages]
    : conversationMessages;
  const messageTokens = conversationMessages.reduce(
    (sum, message) => sum + estimate(message),
    0,
  );
  const total = systemTokens + messageTokens;
  const sourceEntryIds = [
    ...systemIds,
    ...(latestCompaction ? [latestCompaction.id] : []),
    ...selectedIds,
  ];
  const firstKeptEntryId =
    selected.groups[0]?.sourceEntryIds[0] ??
    projectionFields.firstKeptEntryId;
  const estimatedBefore =
    systemTokens +
    summaryCost +
    candidateEntries.reduce(
      (sum, entry) => sum + estimate(entry.message),
      0,
    );
  const tokensBefore =
    projectionFields.tokensBefore ?? estimatedBefore;
  const context: AgentContext = { messages: contextMessages };

  return {
    ...context,
    usage: {
      system: systemTokens,
      messages: messageTokens,
      total,
      budget: availableInput,
      overflow:
        total > availableInput ||
        selected.reason === "single_group_overflow",
      reservedOutput,
      safetyMargin,
      tokensBefore,
    },
    sourceEntryIds,
    firstKeptEntryId,
    safeCutEntryId: firstKeptEntryId,
    tokensBefore,
    selection: {
      reason: selected.reason,
      firstKeptEntryId,
    },
    context,
    usedEntryIds: [...systemIds, ...selectedIds],
    omittedEntryIds: omittedIds,
    estimatedTokens: messageTokens,
  };
}

/**
 * 正文 API：调用者先用 pathTo 选择 active path，builder 只做投影。
 */
export function buildContext(
  activePath: SessionEntry[],
  options: ContextOptions,
): ContextBuildResult;
/**
 * 兼容 API：保留早期 workshop 中的 entries + leafId 入口。
 */
export function buildContext(
  entries: SessionEntry[],
  leafId: string,
  options: ContextOptions,
): ContextBuildResult;
export function buildContext(
  entriesOrPath: SessionEntry[],
  leafOrOptions: string | ContextOptions,
  maybeOptions?: ContextOptions,
): ContextBuildResult {
  if (typeof leafOrOptions === "string") {
    if (!maybeOptions) throw new Error("ContextOptions 缺失");
    return buildProjection(
      pathTo(entriesOrPath, leafOrOptions),
      maybeOptions,
    );
  }
  return buildProjection(entriesOrPath, leafOrOptions);
}

function timestampValue(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("timestamp 非法");
    return value;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("timestamp 非法");
  return parsed;
}

function appendCompaction(
  entries: SessionEntry[],
  input: AppendCompactionInput,
): SessionEntry[] {
  if (entries.some((entry) => entry.id === input.id)) {
    throw new Error(`session entry id 重复：${input.id}`);
  }
  assertNonNegativeInteger(input.tokensBefore, "tokensBefore");
  const branch = pathTo(entries, input.parentId);
  // system message 不进入摘要，也不被 compaction 覆盖：buildContext 总会重放它们。
  const messageEntries = branch.filter(
    (entry): entry is MessageEntry =>
      entry.type === "message" && !isSystemEntry(entry),
  );
  const groups = groupInteractions(messageEntries);
  const safeStarts = new Set(
    groups.map((group) => group.sourceEntryIds[0]),
  );
  const firstKeptIndex = messageEntries.findIndex(
    (entry) => entry.id === input.firstKeptEntryId,
  );
  if (firstKeptIndex < 0 || !safeStarts.has(input.firstKeptEntryId)) {
    throw new Error(
      `unsafe_compaction_boundary:${input.firstKeptEntryId}`,
    );
  }

  const entry: CompactionEntry = {
    id: input.id,
    parentId: input.parentId,
    timestamp: timestampValue(input.timestamp),
    type: "compaction",
    summary: normalizeSummary(input.summary),
    compactedEntryIds: messageEntries
      .slice(0, firstKeptIndex)
      .map((item) => item.id),
    firstKeptEntryId: input.firstKeptEntryId,
    tokensBefore: input.tokensBefore,
  };
  return [...entries, entry];
}

export interface Summarizer {
  summarize(messages: AgentMessage[]): Promise<CompactionSummary>;
}

async function compactStore(
  options: StoreCompactionOptions,
): Promise<CompactionEntry> {
  const entries = await options.store.entries();
  const branch = pathTo(entries, options.leafId);
  const branchMessages = branch.filter(
    (entry): entry is MessageEntry => entry.type === "message",
  );
  // 摘要输入与分组都排除 system message。
  const messageEntries = branchMessages.filter(
    (entry) => !isSystemEntry(entry),
  );
  const previousCompaction = branch.findLast(
    (entry): entry is SessionCompactionEntry =>
      entry.type === "compaction",
  );
  const summarizerMessages = previousCompaction
    ? [
        summaryAsUserMessage(
          previousCompaction.summary,
          previousCompaction.timestamp,
        ),
        ...messageEntries.map((entry) => entry.message),
      ]
    : messageEntries.map((entry) => entry.message);
  const summary = normalizeSummary(
    await options.summarizer.summarize(summarizerMessages),
  );
  if (messageEntries.length === 0) {
    throw new Error("cannot_compact_empty_history");
  }
  const groups = groupInteractions(messageEntries);
  const firstKeptEntryId =
    groups.at(-1)?.sourceEntryIds[0] ?? messageEntries.at(-1)!.id;
  const firstKeptIndex = messageEntries.findIndex(
    (entry) => entry.id === firstKeptEntryId,
  );
  const entry: CompactionEntry = {
    id: options.id,
    parentId: options.leafId,
    timestamp: options.timestamp ?? Date.now(),
    type: "compaction",
    summary,
    compactedEntryIds: messageEntries
      .slice(0, firstKeptIndex)
      .map((item) => item.id),
    firstKeptEntryId,
    tokensBefore: branchMessages.reduce(
      (sum, item) => sum + defaultEstimate(item.message),
      0,
    ),
  };
  await options.store.append(entry);
  return entry;
}

/**
 * 正文 API：返回新数组，旧 history 不做任何原地修改。
 */
export function compact(
  entries: SessionEntry[],
  input: AppendCompactionInput,
): SessionEntry[];
/**
 * 兼容 API：把新 compaction entry 追加到现有 SessionStore。
 */
export function compact(
  options: StoreCompactionOptions,
): Promise<CompactionEntry>;
export function compact(
  entriesOrOptions: SessionEntry[] | StoreCompactionOptions,
  input?: AppendCompactionInput,
): SessionEntry[] | Promise<CompactionEntry> {
  if (Array.isArray(entriesOrOptions)) {
    if (!input) throw new Error("AppendCompactionInput 缺失");
    return appendCompaction(entriesOrOptions, input);
  }
  return compactStore(entriesOrOptions);
}

export function summaryAsUserMessage(
  summary: CompactionSummary,
  timestamp = Date.now(),
): AgentMessage {
  return {
    role: "user",
    content: [text(`[Earlier session summary]\n${summaryText(summary)}`)],
    timestamp,
  };
}
