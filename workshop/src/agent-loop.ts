import {
  executeToolCall as executeCoreToolCall,
  type ToolExecutor,
  type ToolRegistry,
} from "./tool.js";
import {
  type AgentContext,
  type AgentMessage,
  type AssistantMessage,
  type Model,
  type ModelEvent,
  type TextContent,
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

export interface AgentLoopOptions {
  model: Model;
  tools: ToolRegistry;
  context: AgentContext;
  signal?: AbortSignal;
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
    // 请求只由 messages 与 tools 组成：system prompt 已在 messages 里。
    // loop 自己从不写入 system message，只追加 assistant 与 toolResult。
    const stream = options.model.stream(
      {
        messages,
        tools: options.tools.definitions(),
      },
      { signal: options.signal },
    );

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
