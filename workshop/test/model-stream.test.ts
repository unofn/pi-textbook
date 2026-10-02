import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAICompatibleModel,
  createOpenAICompatibleTransport,
  fixedTransport,
  toProviderMessages,
  type ProviderTransport,
} from "../src/provider-adapter.js";
import { ScriptedModel } from "../src/scripted-model.js";
import {
  assistantMessage,
  currentSystemMessage,
  currentSystemPrompt,
  systemMessageText,
  text,
  textOf,
  userMessage,
  type AgentMessage,
  type SystemMessage,
} from "../src/types.js";

function system(
  content: string,
  sections?: SystemMessage["sections"],
  timestamp = 1,
): SystemMessage {
  return {
    role: "system",
    content,
    ...(sections ? { sections } : {}),
    timestamp,
  };
}

function sseResponse(payloads: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = payloads
    .map((payload) =>
      `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`
    )
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = encoder.encode(body);
        const middle = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, middle));
        controller.enqueue(bytes.slice(middle));
        controller.close();
      },
    }),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

async function consume(
  stream: ReturnType<ReturnType<typeof createOpenAICompatibleModel>["stream"]>,
) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

test("模型错误是 error 终态，result resolve canonical message", async () => {
  const model = new ScriptedModel([
    {
      stopReason: "error",
      errorMessage: "network unavailable",
      partialText: "已经生成的部分",
    },
  ]);
  const stream = model.stream({ messages: [userMessage("hello")] });
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();

  assert.equal(events.at(-1)?.type, "error");
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "network unavailable");
  assert.equal(result.content[0]?.type, "text");
});

test("adapter 在唯一边界完成 canonical 到 wire role 转换", () => {
  const messages = toProviderMessages({
    messages: [
      system("You are precise."),
      userMessage("read a.txt"),
      assistantMessage(
        [
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "a.txt" },
          },
        ],
        "toolUse",
      ),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [text("A")],
        isError: false,
        timestamp: 1,
      },
    ],
  });

  assert.deepEqual(messages.map((message) => message.role), [
    "system",
    "user",
    "assistant",
    "tool",
  ]);
  assert.equal(
    messages[2].role === "assistant"
      ? messages[2].tool_calls?.[0].function.name
      : undefined,
    "read",
  );
});

test("system message 按顺序重放：content 追加，sections 替换，null 删除", () => {
  const transcript: AgentMessage[] = [
    system("base", { tools: "read only", style: "terse" }, 10),
    userMessage("one"),
    system("", { tools: "read and write" }, 20),
    assistantMessage([text("ok")]),
    system("Also cite files.", { style: null }, 30),
  ];

  assert.deepEqual(currentSystemMessage(transcript), {
    role: "system",
    content: "base\n\nAlso cite files.",
    sections: { tools: "read and write" },
    timestamp: 10,
  });
  assert.equal(
    currentSystemPrompt(transcript),
    "base\n\nAlso cite files.\n\nread and write",
  );
  assert.equal(
    systemMessageText(system("", { a: "A", gone: null, empty: "", b: "B" })),
    "A\n\nB",
  );
  assert.equal(textOf(transcript[0]), "base\n\nread only\n\nterse");
  assert.equal(currentSystemMessage([userMessage("x")]), undefined);
  assert.equal(currentSystemPrompt([userMessage("x")]), undefined);
  // 只有空 system message 时仍然“有” system 状态，只是文本为空。
  assert.equal(currentSystemPrompt([system("")]), "");
});

test("adapter 把重放结果折叠成唯一开头 system，丢掉中途 system message", () => {
  const transcript: AgentMessage[] = [
    system("base", { resources: "old" }),
    userMessage("one"),
    assistantMessage([text("first")]),
    system("Prefer tests.", { resources: "new" }),
    userMessage("two"),
  ];
  const before = structuredClone(transcript);
  const wire = toProviderMessages({ messages: transcript });

  assert.deepEqual(wire, [
    { role: "system", content: "base\n\nPrefer tests.\n\nnew" },
    { role: "user", content: "one" },
    { role: "assistant", content: "first" },
    { role: "user", content: "two" },
  ]);
  assert.deepEqual(transcript, before);
  assert.deepEqual(
    toProviderMessages({ messages: [userMessage("hi")] }).map(
      (message) => message.role,
    ),
    ["user"],
  );
  // 段落全部删除且 content 为空时，不发送空 system message。
  assert.deepEqual(
    toProviderMessages({
      messages: [
        system("", { a: "A" }),
        system("", { a: null }),
        userMessage("hi"),
      ],
    }).map((message) => message.role),
    ["user"],
  );
});

test("ScriptedModel 保存完整 context，system prompt 从 messages 重放", async () => {
  const model = new ScriptedModel([assistantMessage([text("ok")])]);
  const context = {
    messages: [
      system("base"),
      userMessage("hi"),
      system("", { extra: "patched" }),
    ],
  };
  await model.stream(context).result();
  context.messages.push(userMessage("mutated later"));

  assert.equal(model.requests[0].messages.length, 3);
  assert.equal(
    currentSystemPrompt(model.requests[0].messages),
    "base\n\npatched",
  );
});

test("adapter 把 transport 异常转成保留 partial 的 error message", async () => {
  const transport: ProviderTransport = {
    async *stream() {
      yield { type: "text", delta: "partial" } as const;
      throw new Error("socket reset");
    },
  };
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });
  const stream = model.stream({ messages: [userMessage("go")] });
  let eventCount = 0;
  for await (const event of stream) eventCount += event.type.length > 0 ? 1 : 0;
  assert.ok(eventCount > 0);
  const result = await stream.result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.content[0]?.type, "text");
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    "partial",
  );
});

test("length 截断保留 raw arguments，但不声称 JSON 已完成", async () => {
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport: fixedTransport([
      {
        type: "tool",
        index: 0,
        id: "call-1",
        name: "read",
        argumentsDelta: '{"path":"a',
      },
      { type: "finish", reason: "length" },
    ]),
  });
  const stream = model.stream({ messages: [userMessage("go")] });
  let eventCount = 0;
  for await (const event of stream) eventCount += event.type.length > 0 ? 1 : 0;
  assert.ok(eventCount > 0);
  const result = await stream.result();
  const call = result.content.find((block) => block.type === "toolCall");
  assert.equal(result.stopReason, "length");
  assert.equal(call?.type === "toolCall" ? call.rawArguments : "", '{"path":"a');
});

test("真实 transport 发出 tools、认证 header、stream usage 选项和同一 abort signal", async () => {
  const abortController = new AbortController();
  let captured:
    | { input: string | URL | Request; init: RequestInit | undefined }
    | undefined;
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1/",
    apiKey: "offline-test-key",
    fetch: async (input, init) => {
      captured = { input, init };
      return sseResponse([
        {
          choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
          ],
        },
        "[DONE]",
      ]);
    },
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { result } = await consume(
    model.stream(
      {
        messages: [userMessage("read a.txt")],
        tools: [
          {
            name: "read",
            description: "Read one file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
      { signal: abortController.signal },
    ),
  );

  assert.equal(result.stopReason, "stop");
  assert.ok(captured);
  assert.equal(String(captured.input), "https://provider.invalid/v1/chat/completions");
  assert.equal(captured.init?.method, "POST");
  assert.equal(captured.init?.signal, abortController.signal);
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer offline-test-key");
  assert.equal(headers.get("accept"), "text/event-stream");
  const body = JSON.parse(String(captured.init?.body)) as {
    stream: boolean;
    stream_options: { include_usage: boolean };
    tools: unknown[];
  };
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read one file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ]);
});

test("SSE transport 按 index 恢复交错 tool arguments，并合并尾随 usage", async () => {
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "offline-test-key",
    fetch: async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-read",
                    type: "function",
                    function: {
                      name: "read",
                      arguments: "{\"path\":",
                    },
                  },
                  {
                    index: 1,
                    id: "call-search",
                    type: "function",
                    function: {
                      name: "search",
                      arguments: "{\"query\":",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    function: { arguments: "\"pi\"}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: "\"README.md\"}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
          },
        },
        "[DONE]",
      ]),
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { events, result } = await consume(
    model.stream({ messages: [userMessage("use tools")] }),
  );

  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.usage, {
    input: 12,
    output: 8,
    totalTokens: 20,
  });
  const calls = result.content.filter((block) => block.type === "toolCall");
  assert.deepEqual(
    calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      rawArguments: call.rawArguments,
    })),
    [
      {
        id: "call-read",
        name: "read",
        arguments: { path: "README.md" },
        rawArguments: "{\"path\":\"README.md\"}",
      },
      {
        id: "call-search",
        name: "search",
        arguments: { query: "pi" },
        rawArguments: "{\"query\":\"pi\"}",
      },
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "toolcall_delta")
      .map((event) => event.delta),
    ["{\"path\":", "{\"query\":", "\"pi\"}", "\"README.md\"}"],
  );
});

test("SSE 缺少 finish reason 时保留 partial 并进入 error 终态", async () => {
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "offline-test-key",
    fetch: async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: { content: "partial" },
              finish_reason: null,
            },
          ],
        },
        "[DONE]",
      ]),
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { events, result } = await consume(
    model.stream({ messages: [userMessage("go")] }),
  );

  assert.equal(events.at(-1)?.type, "error");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /without a finish chunk/);
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    "partial",
  );
});

test("SSE transport 把流中取消转换成 aborted，并保留 partial", async () => {
  const abortController = new AbortController();
  const encoder = new TextEncoder();
  let seenSignal: AbortSignal | null | undefined;
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "offline-test-key",
    fetch: async (_input, init) => {
      seenSignal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      index: 0,
                      delta: { content: "partial" },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              ),
            );
            init?.signal?.addEventListener(
              "abort",
              () => {
                controller.error(
                  new DOMException("Request was aborted", "AbortError"),
                );
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });
  const stream = model.stream(
    { messages: [userMessage("go")] },
    { signal: abortController.signal },
  );
  const events = [];

  for await (const event of stream) {
    events.push(event);
    if (event.type === "text_delta") abortController.abort();
  }
  const result = await stream.result();
  const lastEvent = events.at(-1);

  assert.equal(seenSignal, abortController.signal);
  assert.equal(lastEvent?.type, "error");
  assert.equal(
    lastEvent?.type === "error" ? lastEvent.reason : "",
    "aborted",
  );
  assert.equal(result.stopReason, "aborted");
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    "partial",
  );
});

test("SSE transport 拒绝形状无效的外部 chunk", async () => {
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "offline-test-key",
    fetch: async () =>
      sseResponse([{ choices: "not-an-array" }, "[DONE]"]),
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { events, result } = await consume(
    model.stream({ messages: [userMessage("go")] }),
  );

  assert.equal(events.at(-1)?.type, "error");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /Invalid provider chunk/);
});

test("SSE transport 拒绝未知 finish reason，错误中不泄露 API key", async () => {
  const apiKey = "never-print-this-secret";
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey,
    fetch: async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "content_filter",
            },
          ],
        },
        "[DONE]",
      ]),
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { result } = await consume(
    model.stream({ messages: [userMessage("go")] }),
  );

  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /finish_reason/);
  assert.doesNotMatch(result.errorMessage ?? "", new RegExp(apiKey));
});

test("transport 会脱敏底层 fetch 错误中的 API key", async () => {
  const apiKey = "never-print-this-secret";
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey,
    fetch: async () => {
      throw new Error(`socket failed while using ${apiKey}`);
    },
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { result } = await consume(
    model.stream({ messages: [userMessage("go")] }),
  );

  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /\[redacted\]/);
  assert.doesNotMatch(result.errorMessage ?? "", new RegExp(apiKey));
});
