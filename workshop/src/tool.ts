import {
  text,
  type TextContent,
  type ToolCall,
  type ToolDefinition,
  type ToolResultMessage,
} from "./types.js";

export interface Schema<T> {
  parse(value: unknown): T;
  jsonSchema?: Record<string, unknown>;
}

export type Validator<T> = ((value: unknown) => T) & {
  jsonSchema?: Record<string, unknown>;
  optional?: boolean;
};

export const stringValue: Validator<string> = Object.assign(
  (value: unknown) => {
    if (typeof value !== "string") throw new Error("必须是 string");
    return value;
  },
  { jsonSchema: { type: "string" } },
);

export const optionalString: Validator<string | undefined> = Object.assign(
  (value: unknown) => {
    if (value === undefined) return undefined;
    return stringValue(value);
  },
  { jsonSchema: { type: "string" }, optional: true },
);

export const optionalPositiveInteger: Validator<number | undefined> =
  Object.assign(
    (value: unknown) => {
      if (value === undefined) return undefined;
      if (!Number.isInteger(value) || Number(value) < 1) {
        throw new Error("必须是正整数");
      }
      return Number(value);
    },
    {
      jsonSchema: { type: "integer", minimum: 1 },
      optional: true,
    },
  );

export function objectSchema<
  TShape extends Record<string, Validator<unknown>>,
>(shape: TShape): Schema<{
  [TKey in keyof TShape]: ReturnType<TShape[TKey]>;
}> {
  return {
    jsonSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(shape).map(([key, validator]) => [
          key,
          validator.jsonSchema ?? {},
        ]),
      ),
      required: Object.entries(shape)
        .filter(([, validator]) => !validator.optional)
        .map(([key]) => key),
      additionalProperties: false,
    },
    parse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("参数必须是 object");
      }
      const result = {} as {
        [TKey in keyof TShape]: ReturnType<TShape[TKey]>;
      };
      for (const [key, validator] of Object.entries(shape)) {
        result[key as keyof TShape] = validator(
          (value as Record<string, unknown>)[key],
        ) as ReturnType<TShape[keyof TShape]>;
      }
      return result;
    },
  };
}

export interface ToolContext {
  callId: string;
  signal?: AbortSignal;
  reportProgress?(content: TextContent[]): void;
}

export interface ToolOutput<TDetails = unknown> {
  content: TextContent[];
  details?: TDetails;
  isError?: boolean;
}

export type ToolExecutor = (
  call: ToolCall,
  context?: Omit<ToolContext, "callId">,
) => Promise<ToolResultMessage>;

/**
 * 工具暴露级别，与上游 Pi 1.0 同名：
 * - direct：声明给模型，也可被脚本调用（默认）；
 * - model-only：只声明给模型，脚本不能调用（tool_search、codemode 本身）；
 * - codemode / deferred：注册即可被脚本调用，但不声明给模型，
 *   `tool_search` 激活后才进入声明集合；
 * - hidden：既不声明也不能调用。
 */
export type ToolExposure =
  | "direct"
  | "model-only"
  | "codemode"
  | "deferred"
  | "hidden";

/** 谁在发起调用：模型只能调用声明集合，脚本只能调用可调用集合。 */
export type ToolCallScope = "model" | "script";

export interface Tool<TParameters = unknown, TDetails = unknown> {
  name: string;
  description: string;
  schema: Schema<TParameters>;
  /** 缺省为 direct。 */
  exposure?: ToolExposure;
  execute(
    parameters: TParameters,
    context: ToolContext,
  ): Promise<ToolOutput<TDetails>>;
}

function exposureOf(tool: Tool<unknown, unknown>): ToolExposure {
  return tool.exposure ?? "direct";
}

/**
 * 一张注册表推导出两个集合：声明集合（模型看得到的）与可调用集合（脚本能
 * 执行的）。direct 与 model-only 注册即激活；codemode 与 deferred 激活后才
 * 声明；hidden 永远不激活。两个集合都按注册顺序排列。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();
  private readonly active = new Set<string>();

  constructor(tools: Tool<never, unknown>[] | Tool[] = []) {
    tools.forEach((tool) => this.register(tool));
  }

  register<TParameters, TDetails>(
    tool: Tool<TParameters, TDetails>,
  ): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool 已存在：${tool.name}`);
    }
    const registered = tool as Tool<unknown, unknown>;
    this.tools.set(tool.name, registered);
    const exposure = exposureOf(registered);
    if (exposure === "direct" || exposure === "model-only") {
      this.active.add(tool.name);
    }
  }

  get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<unknown, unknown>[] {
    return [...this.tools.values()];
  }

  exposureOf(name: string): ToolExposure | undefined {
    const tool = this.tools.get(name);
    return tool ? exposureOf(tool) : undefined;
  }

  /** 是否有任何工具不是 direct：只有这时声明集合才可能与全集不同。 */
  usesExposure(): boolean {
    return this.list().some((tool) => exposureOf(tool) !== "direct");
  }

  /** 把 codemode / deferred 工具加入声明集合；未知与 hidden 名字被忽略。返回新激活的名字。 */
  activate(names: readonly string[]): string[] {
    const activated: string[] = [];
    for (const name of names) {
      const exposure = this.exposureOf(name);
      if (exposure === undefined || exposure === "hidden") continue;
      if (this.active.has(name)) continue;
      this.active.add(name);
      activated.push(name);
    }
    return activated;
  }

  isActive(name: string): boolean {
    return this.active.has(name);
  }

  /** 声明集合：已激活且非 hidden 的工具。 */
  declared(): Tool<unknown, unknown>[] {
    return this.list().filter(
      (tool) =>
        this.active.has(tool.name) && exposureOf(tool) !== "hidden",
    );
  }

  /** 可调用集合（脚本视角）：全部 codemode / deferred 工具，加上已激活的 direct 工具。 */
  callable(): Tool<unknown, unknown>[] {
    return this.list().filter((tool) => {
      const exposure = exposureOf(tool);
      return (
        exposure === "codemode" ||
        exposure === "deferred" ||
        (exposure === "direct" && this.active.has(tool.name))
      );
    });
  }

  canCall(name: string, scope: ToolCallScope): boolean {
    const tools = scope === "model" ? this.declared() : this.callable();
    return tools.some((tool) => tool.name === name);
  }

  /** 交给模型的工具清单就是声明集合；全 direct 时等于全集。 */
  definitions(): ToolDefinition[] {
    return this.declared().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema.jsonSchema ?? { type: "object" },
    }));
  }
}

function failedResult(
  call: ToolCall,
  error: unknown,
): ToolResultMessage {
  const message = error instanceof Error ? error.message : String(error);
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [text(`Tool ${call.name} failed: ${message}`)],
    details: { error: message },
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * 模型发起的调用只能命中声明集合，脚本发起的调用只能命中可调用集合；
 * 两者之外的名字与未知工具一样，得到配对的错误结果而不是异常。
 */
export async function executeToolCall(
  call: ToolCall,
  registry: ToolRegistry,
  context: Omit<ToolContext, "callId"> = {},
  scope: ToolCallScope = "model",
): Promise<ToolResultMessage> {
  const tool = registry.get(call.name);
  if (!tool) return failedResult(call, new Error("未知工具"));
  if (!registry.canCall(call.name, scope)) {
    return failedResult(
      call,
      new Error(
        scope === "model"
          ? "工具未声明给模型"
          : "工具不在脚本的可调用集合里",
      ),
    );
  }

  try {
    const parameters = tool.schema.parse(call.arguments);
    const output = await tool.execute(parameters, {
      ...context,
      callId: call.id,
    });
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: output.content,
      details: output.details,
      isError: output.isError ?? false,
      timestamp: Date.now(),
    };
  } catch (error) {
    return failedResult(call, error);
  }
}
