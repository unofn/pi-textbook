import {
  executeToolCall as executeCoreToolCall,
  type ToolExecutor,
  type ToolRegistry,
} from "./tool.js";
import {
  assistantMessage,
  currentTools,
  toolStateChanges,
  type AgentContext,
  type AgentMessage,
  type AssistantMessage,
  type Model,
  type ModelEvent,
  type SystemMessage,
  type TextContent,
  type ThinkingLevel,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "./types.js";

export type LoopEvent =
  | { type: "model_event"; event: ModelEvent }
  | { type: "assistant_message"; message: AssistantMessage }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_progress"; callId: string; content: TextContent[] }
  | { type: "tool_end"; result: ToolResultMessage }
  | { type: "tool_skipped"; result: ToolResultMessage }
  | { type: "turn_end"; reason: AgentRunResult["reason"] };

export interface AgentRunResult {
  reason:
    | "stop"
    | "length"
    | "error"
    | "aborted"
    | "maxSteps";
  messages: AgentMessage[];
  steps: number;
}

/**
 * 为什么发出这次请求：
 * - user：最近一次回复之后有用户写的消息（prompt、steering、follow-up）；
 * - continuation：loop 内的其他请求，例如工具结果之后；
 * - retry：transcript 以失败回复结尾且其后没有任何消息——调用方直接重发。
 */
export type RequestReason = "user" | "continuation" | "retry";

export interface AgentRequest {
  context: AgentContext;
  /** 配置的模型；钩子可以换成本次真正要用的物理模型。 */
  model: Model;
  reason: RequestReason;
  /** retry 时：那条失败回复。 */
  failed?: AssistantMessage;
}

export interface PreparedRequest {
  model?: Model;
  thinkingLevel?: ThinkingLevel;
}

/**
 * 每次请求前的钩子：可以换掉本次的模型与推理强度，不能改写 transcript。
 * 抛错或 reject 以一条 error 回复结束本次请求。
 */
export type PrepareRequestHook = (
  request: AgentRequest,
  signal?: AbortSignal,
) =>
  | PreparedRequest
  | undefined
  | void
  | Promise<PreparedRequest | undefined | void>;

export interface AgentLoopOptions {
  model: Model;
  tools: ToolRegistry;
  context: AgentContext;
  signal?: AbortSignal;
  prepareRequest?: PrepareRequestHook;
  onEvent?(event: LoopEvent): void;
  takeSteeringMessages?(): UserMessage[];
  takeFollowUpMessages?(): UserMessage[];
  executeToolCall?: ToolExecutor;
  /**
   * 课程增强：防止错误脚本无限循环。它不是上游 Pi 核心的同名保证。
   */
  maxSteps?: number;
}

function emit(
  options: AgentLoopOptions,
  event: LoopEvent,
): void {
  options.onEvent?.(event);
}

function toolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
}

function skippedCall(
  call: ToolCall,
  reason: "length" | "error" | "aborted" | "unexpected-stop",
): ToolResultMessage {
  const explanation =
    reason === "length"
      ? "the model response was truncated"
      : reason === "unexpected-stop"
        ? "the model returned stop with a tool call"
        : `the model turn ended with ${reason}`;
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [
      {
        type: "text",
        text: `Tool call was not executed because ${explanation}.`,
      },
    ],
    details: { skipped: true, reason },
    isError: true,
    timestamp: Date.now(),
  };
}

function declaresTools(messages: readonly AgentMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "system" &&
      (message.toolsAdded !== undefined ||
        message.toolsRemoved !== undefined),
  );
}

/**
 * 把本次请求的声明集合与 transcript 重放出的工具集合比较，只在有差异时生成
 * 一条只含 toolsAdded / toolsRemoved 的 system 补丁。全 direct 的注册表不写
 * 补丁（那时 context.tools 就是全部事实，前几章的 transcript 保持不变）；一旦
 * 注册表用上 exposure，或 transcript 已经声明过工具，差异就必须落进 transcript。
 */
export function declareToolChanges(
  messages: readonly AgentMessage[],
  registry: ToolRegistry,
): SystemMessage | undefined {
  if (!registry.usesExposure() && !declaresTools(messages)) return undefined;
  const { toolsAdded, toolsRemoved } = toolStateChanges(
    currentTools(messages),
    registry.definitions(),
  );
  if (toolsAdded.length === 0 && toolsRemoved.length === 0) return undefined;
  return {
    role: "system",
    content: "",
    ...(toolsAdded.length > 0 ? { toolsAdded } : {}),
    ...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
    timestamp: Date.now(),
  };
}

/** 从 transcript 尾部判断请求原因；retry 时附带那条失败回复。 */
export function requestReason(
  messages: readonly AgentMessage[],
): { reason: RequestReason; failed?: AssistantMessage } {
  const lastAssistant = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const tail = messages.slice(lastAssistant + 1);
  if (tail.some((message) => message.role === "user")) {
    return { reason: "user" };
  }
  const last = messages[lastAssistant];
  if (
    last?.role === "assistant" &&
    (last.stopReason === "error" || last.stopReason === "aborted") &&
    tail.length === 0
  ) {
    return { reason: "retry", failed: last };
  }
  return { reason: "continuation" };
}

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentRunResult> {
  const messages = structuredClone(options.context.messages);
  const maxSteps = options.maxSteps ?? 32;
  const executeToolCall: ToolExecutor =
    options.executeToolCall ??
    ((call, context) =>
      executeCoreToolCall(call, options.tools, context));

  for (let steps = 1; steps <= maxSteps; steps += 1) {
    if (options.signal?.aborted) {
      emit(options, { type: "turn_end", reason: "aborted" });
      return { reason: "aborted", messages, steps: steps - 1 };
    }
    // 请求前先让 transcript 说出本次声明的工具集合：有差异才追加一条声明补丁，
    // 跟在本轮已有消息之后（用户消息或工具结果之后），紧贴即将发出的请求。
    const declaration = declareToolChanges(messages, options.tools);
    if (declaration) messages.push(declaration);
    // 请求只由 messages 与 tools 组成：system prompt 已在 messages 里。
    // 除工具声明补丁外，loop 只追加 assistant 与 toolResult。
    const context: AgentContext = {
      messages,
      tools: options.tools.definitions(),
    };
    let prepared: PreparedRequest | undefined | void;
    if (options.prepareRequest) {
      // 钩子只决定本次用哪个模型、什么推理强度；它失败时本次请求以 error 回复结束。
      try {
        prepared = await options.prepareRequest(
          { context, model: options.model, ...requestReason(messages) },
          options.signal,
        );
      } catch (error) {
        const aborted = options.signal?.aborted === true;
        const failed = assistantMessage([], aborted ? "aborted" : "error", {
          errorMessage:
            error instanceof Error ? error.message : String(error),
        });
        messages.push(failed);
        emit(options, { type: "assistant_message", message: failed });
        const reason = aborted ? "aborted" : "error";
        emit(options, { type: "turn_end", reason });
        return { reason, messages, steps };
      }
    }
    const stream = (prepared?.model ?? options.model).stream(context, {
      signal: options.signal,
      ...(prepared?.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: prepared.thinkingLevel }),
    });

    for await (const event of stream) {
      emit(options, { type: "model_event", event });
    }
    const assistant = await stream.result();
    messages.push(assistant);
    emit(options, { type: "assistant_message", message: assistant });
    const calls = toolCalls(assistant);

    if (assistant.stopReason === "length") {
      // length 可能截断 arguments，绝不执行；但已经形成的 call 仍要获得配对结果，
      // 避免把悬空 toolCall 写进 transcript。
      for (const call of calls) {
        const result = skippedCall(call, "length");
        messages.push(result);
        emit(options, { type: "tool_skipped", result });
      }
      emit(options, { type: "turn_end", reason: "length" });
      return { reason: "length", messages, steps };
    }

    if (
      assistant.stopReason === "error" ||
      assistant.stopReason === "aborted"
    ) {
      const reason = assistant.stopReason;
      for (const call of calls) {
        const result = skippedCall(call, reason);
        messages.push(result);
        emit(options, { type: "tool_skipped", result });
      }
      emit(options, { type: "turn_end", reason });
      return { reason, messages, steps };
    }

    if (assistant.stopReason === "stop") {
      if (calls.length > 0) {
        for (const call of calls) {
          const result = skippedCall(call, "unexpected-stop");
          messages.push(result);
          emit(options, { type: "tool_skipped", result });
        }
        emit(options, { type: "turn_end", reason: "error" });
        return { reason: "error", messages, steps };
      }
      const followUps = options.takeFollowUpMessages?.() ?? [];
      if (followUps.length > 0) {
        messages.push(...followUps);
        continue;
      }
      emit(options, { type: "turn_end", reason: "stop" });
      return { reason: "stop", messages, steps };
    }

    if (calls.length === 0) {
      emit(options, { type: "turn_end", reason: "error" });
      return { reason: "error", messages, steps };
    }

    calls.forEach((call) => emit(options, { type: "tool_start", call }));
    const results = await Promise.all(
      calls.map((call) =>
        executeToolCall(call, {
          signal: options.signal,
          reportProgress: (content) => {
            emit(options, {
              type: "tool_progress",
              callId: call.id,
              content,
            });
          },
        }).then((result) => {
          // 观察事件反映真实完成顺序；Promise.all 返回值仍保持 call 顺序。
          emit(options, { type: "tool_end", result });
          return result;
        }),
      ),
    );

    // Promise 完成顺序可以不同，但 transcript 必须按原始 call 顺序配对追加。
    for (const result of results) {
      messages.push(result);
    }

    const steering = options.takeSteeringMessages?.() ?? [];
    messages.push(...steering);
    if (options.signal?.aborted) {
      emit(options, { type: "turn_end", reason: "aborted" });
      return { reason: "aborted", messages, steps };
    }
  }

  emit(options, { type: "turn_end", reason: "maxSteps" });
  return { reason: "maxSteps", messages, steps: maxSteps };
}
