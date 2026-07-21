---
id: "05"
slug: provider-adapter
part: foundations
partTitle: 第一部 · 建立可执行语言
chapter: "05"
title: 模型调用：在课程协议和 Provider API 之间转换
summary: 跟随一次模型调用，读懂消息如何写成 HTTP 请求，流式响应又如何变回统一事件。
minutes: 240
difficulty: 核心
artifact: packages/pi-course/src/provider-adapter.ts
prerequisites: 03,04
terms: provider adapter, transport, normalized chunk, incremental JSON, finish reason
upstream: packages/ai/src/api/openai-completions.ts
---

## 你将得到什么

第 04 章写出的 `ScriptedModel` 接收 `AgentContext`，返回 `ModelEvent`。真实模型也要接到
这个位置上。不过，它在进程外面：消息要先写成 HTTP 请求，回复则以 SSE 字节流的
形式回来。

这一章只跟随一条固定主线：用户要求“读取 README.md”，Provider 用
`id: "call-1"`、`index: 0` 提出 `read`，参数分成 `'{"path":'` 与
`'"README.md"}'` 两段返回。发送方向从课程消息进入 `fetch`；返回方向则沿同一个 id 和
参数，依次经过 SSE payload、`ProviderChunk`、`ModelEvent`，最后形成 assistant 中的
tool call。

`call-1` 是 Chapter 05 聚焦测试使用的 Provider fixture id；序章离线轨迹写作 `call_1`，
两者不是同一次运行。跨章保持不变的是 `read("README.md")` 这项动作，以及同一轮内 id 从
Provider 输出一直进入 assistant 的配对关系。

```text
AgentContext("读取 README.md") → ProviderRequest → HTTP
AssistantMessage(call-1) ← ModelEvent ← ProviderChunk(index 0) ← SSE payload
```

这里会出现两个新名字。**adapter** 负责课程协议与 Provider 语义之间的转换；
**transport** 负责 HTTP、SSE 和外部 JSON。写完以后，`ScriptedModel` 与真实模型都能
通过同一个 `Model.stream()` 交给上层使用。

本章只讨论模型边界的转换。工具参数怎样验证、工具怎样执行，留到第 06 章。实现会
修改 `packages/pi-course/src/types.ts` 和
`packages/pi-course/src/provider-adapter.ts`。

## 先建立全景

先看发送方向。课程内部的一条 user message 是一个带 content block 的对象：

```ts
{
  role: "user",
  content: [{ type: "text", text: "读取 README.md" }],
  timestamp: 1,
}
```

OpenAI-compatible API 接收的同一条消息更扁平：

```ts
{ role: "user", content: "读取 README.md" }
```

`toProviderMessages()` 读取前一个对象，写出后一个对象。system prompt、assistant 的
工具调用和 tool result 也在这里转换。完成转换后，它们和模型名一起组成
`ProviderRequest`。

返回方向多两层。Provider 返回主线参数的第一段时，一条 SSE data 是：

```text
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read","arguments":"{\"path\":"}}]},"finish_reason":null}]}

```

transport 先从字节流中取出完整的 `data:`，解析 JSON，并检查课程实际用到的字段。
上面的 payload 会变成一个较小的对象，id、index 和参数分片都保持原值：

```ts
{
  type: "tool",
  index: 0,
  id: "call-1",
  name: "read",
  argumentsDelta: '{"path":',
}
```

下一条 SSE payload 仍指向 `index: 0`，只携带第二段参数 `'"README.md"}'`；transport
据此产出第二个 tool `ProviderChunk`。adapter 不再接触
`choices[0].delta.tool_calls` 之类的外部字段。它按 index 找回 `call-1` 的 buffer，
把两段参数连成 `{"path":"README.md"}`，再发出 `toolcall_delta`、`toolcall_end` 和
`done`。最终 assistant 中仍是 `id: "call-1"` 的 `read` 调用。

```text
AgentContext
    │  toProviderMessages()
    ▼
ProviderRequest
    │  transport.stream()
    ▼
raw SSE(call-1/index 0) ── transport ──→ ProviderChunk(index 0)
ProviderChunk(index 0) ── adapter ──→ ModelEvent(contentIndex 0)
                                      └─→ AssistantMessage(call-1)
```

`ProviderChunk` 是两段代码之间的接缝：

```ts
export type ProviderChunk =
  | { type: "text"; delta: string }
  | {
      type: "tool";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | {
      type: "finish";
      reason: "stop" | "length" | "tool_calls";
      usage?: Partial<Usage>;
    };
```

真实 transport 和测试使用的 `fixedTransport()` 都实现同一个接口：

```ts
export interface ProviderTransport {
  stream(
    request: ProviderRequest,
    options: { signal?: AbortSignal },
  ): AsyncIterable<ProviderChunk>;
}
```

因此 adapter 可以先在离线数组上写完。网络解析接好以后，它处理的仍是同样三个
chunk 分支。

:::predict title="先读一段流"
下面两个 chunk 就是主线中同一次工具调用：

```ts
{
  type: "tool",
  index: 0,
  id: "call-1",
  name: "read",
  argumentsDelta: '{"path":',
}
{ type: "tool", index: 0, argumentsDelta: '"README.md"}' }
```

把两段 `argumentsDelta` 按顺序连起来，最终得到什么字符串？此时
`JSON.parse()` 会得到什么对象？
---answer
连接后的字符串是 `{"path":"README.md"}`，解析结果是
`{ path: "README.md" }`。第一段到达时只保存原文；finish 到达后，adapter 才知道
本次输出是否完整，并决定是否解析。
:::

:::rebuild title="Checkpoint 05 · 接入 OpenAI-compatible Provider"
**模式：** 重建

**起终点：** `parent` 是第 04 章完成后的起点；`target` 是 11 项聚焦测试通过的终点。

**教学文件：**
- `packages/pi-course/src/types.ts`
- `packages/pi-course/src/provider-adapter.ts`

**动手前只需知道：** `ToolDefinition` 描述可以交给模型的工具；`ProviderChunk` 是
transport 从外部响应中读出的三种流式片段；adapter 在一次 `stream()` 调用内累积
文本、工具参数和结束原因。

**第一次红灯：** build 会先报告 `types.ts` 没有导出 `ToolDefinition`，并且
`AgentContext` 没有 `tools` 属性。这两处正是发送方向需要的新数据。

**第一步：** 读完“把消息写成 Provider 请求”，补上这两个类型，再完成纯函数形式的
出站转换。先不看 target diff；完整实现不属于第一次尝试的输入。

**聚焦测试：** `packages/pi-course/test/05-provider-adapter.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 05`

**练习目录：** `npm run practice -w @pi/course -- 05`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/05-*.test.js`

**通过证据：** 11 项测试分别观察出站消息、normalized chunk 的顺序与 partial、SSE
分帧、外部数据验证、结束原因、usage、取消和密钥脱敏。
:::

## 把消息写成 Provider 请求

模型请求还需要知道本轮可以调用哪些工具。`ToolDefinition` 保存工具名称、说明和
交给模型的 JSON Schema：

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools?: ToolDefinition[];
}
```

这里的 schema 只会进入模型请求。第 06 章会为它配上运行时验证器。

看一份稍完整的 context：

```ts
const context: AgentContext = {
  systemPrompt: "回答要简洁。",
  messages: [
    userMessage("读取 README.md"),
    assistantMessage([
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "README.md" },
        rawArguments: '{"path":"README.md"}',
      },
    ], "toolUse"),
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [text("# Project")],
      isError: false,
      timestamp: 1,
    },
  ],
};
```

`toProviderMessages(context)` 写出的数组是：

```ts
[
  { role: "system", content: "回答要简洁。" },
  { role: "user", content: "读取 README.md" },
  {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call-1",
      type: "function",
      function: {
        name: "read",
        arguments: '{"path":"README.md"}',
      },
    }],
  },
  {
    role: "tool",
    tool_call_id: "call-1",
    name: "read",
    content: "# Project",
  },
]
```

四种 role 在这个例子里都出现了。system prompt 变成第一条 system message；user 的
text block 合并成字符串；assistant 的工具调用进入 `tool_calls`；课程中的
`toolResult` 则写成 Provider 的 `role: "tool"`，并继续使用原来的 call id。

工具参数优先采用 `rawArguments`：

```ts
arguments:
  call.rawArguments ?? JSON.stringify(call.arguments ?? {})
```

`rawArguments` 保存 Provider 原先给出的字符序列。重新序列化一个已经解析过的对象，
可能改变空格或字段顺序，也无法表示被截断的原文。只有没有原文时，才从
`arguments` 生成 JSON。

`toProviderTools()` 做另一项转换，把每个 `ToolDefinition` 包进 Provider 所需的
`{ type: "function", function: ... }`。没有工具时返回 `undefined`，请求体也就不会
带一个空数组。这两个转换都是纯函数；传入的 context 在调用后保持原样。

:::lab title="实践 5.1 · 完成类型与出站转换"
**目标：** 让完整的 canonical context 变成 wire messages 和 wire tools。

**文件：** `packages/pi-course/src/types.ts`、
`packages/pi-course/src/provider-adapter.ts`

**动作：**
1. 加入 `ToolDefinition` 和 `AgentContext.tools`。
2. 实现 `toProviderMessages()` 的四种 role 映射。
3. assistant tool call 优先使用 `rawArguments`，并保留 id 与 name。
4. 实现 `toProviderTools()`，不改动输入对象。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="出站转换" \
  packages/pi-course/dist/test/05-*.test.js
```

**预期：** `1/1`。测试比较完整的 messages、tools 和调用前后的 context 快照。
:::

## 从 ProviderChunk 读回模型回复

发送方向处理的是完整对象。返回方向是一段会逐渐长出来的回复。先把主线的两个参数分片
直接交给离线 `fixedTransport()`：

```ts
[
  {
    type: "tool",
    index: 0,
    id: "call-1",
    name: "read",
    argumentsDelta: '{"path":',
  },
  { type: "tool", index: 0, argumentsDelta: '"README.md"}' },
  { type: "finish", reason: "tool_calls", usage: { output: 2 } },
]
```

第一个 chunk 让 adapter 建立 `toolBuffers.get(0)`：其中保存 `id: "call-1"`、
`name: "read"`、`contentIndex: 0` 和参数原文 `'{"path":'`。第二个 chunk 仍用 Provider
index `0` 找回这个 buffer，并把参数追加成 `'{"path":"README.md"}'`。对应事件是：

```text
ProviderChunk #1
  → toolcall_delta(contentIndex 0, delta '{"path":')
  → partial: toolCall(call-1, rawArguments '{"path":')

ProviderChunk #2
  → toolcall_delta(contentIndex 0, delta '"README.md"}')
  → partial: toolCall(call-1, rawArguments '{"path":"README.md"}')

finish(tool_calls)
  → JSON.parse('{"path":"README.md"}')
  → toolcall_end(contentIndex 0, call-1)
  → done(toolUse)
```

最终 assistant 仍携带从 SSE 开始的同一个 id 和参数：

```ts
{
  role: "assistant",
  content: [{
    type: "toolCall",
    id: "call-1",
    name: "read",
    arguments: { path: "README.md" },
    rawArguments: '{"path":"README.md"}',
  }],
  stopReason: "toolUse",
  // provider、model、usage、timestamp 省略
}
```

这里 Provider index 与 canonical `contentIndex` 都是 `0`，只是因为主线只有一个 content
block；两者的含义并不相同。前者把网络中的后续分片送回同一个工具，后者指出 tool call
位于 assistant content 的哪个槽位。

### 局部 fixture：只看文本 partial

主线闭合以后，可以用一个纯文本 fixture 单独观察 partial 快照：

```ts
[
  { type: "text", delta: "正在" },
  { type: "text", delta: "读取" },
  { type: "finish", reason: "stop", usage: { output: 2 } },
]
```

adapter 依次发出 `start`、两个 `text_delta` 和 `done`。第一个 delta 之后，partial 中
的文本是“正在”；第二个 delta 之后，它变成“正在读取”。每个事件保存的是该时刻
已经形成的完整 partial，而非最后一个字符串片段。这个 fixture 只隔离文本分支，不替换
`call-1/index 0` 的章节主线。

### 诊断 fixture：用 index 4/2 分开两种顺序

另一个 fixture 故意让文本与两个工具交错，并使用不连续的 Provider index：

```text
tool index 4   {"path":
text           先读
tool index 2   {"query":
tool index 4   "README.md"}
text           ，再查
tool index 2   "pi"}
finish         tool_calls
```

它用于诊断两种 index 是否被混淆，不是新的业务主线。canonical content 仍按照内容
第一次出现的先后排列：

```text
content[0] = tool index 4
content[1] = text
content[2] = tool index 2
```

第一次遇到工具 4 时，adapter 为它建立一个 `ToolBuffer`，把当时的
`content.length` 记为 `contentIndex`。以后再收到 index 4，只更新这个 buffer 和
`content[0]`。工具 2 同样保留自己的 buffer，但它第一次出现得更晚，所以占据
`content[2]`。

一次 `stream()` 需要保存这些值：

| 值 | 当前记录 |
|---|---|
| `content` | 已经出现的 canonical content block |
| `textContentIndex` | 文本所在的槽位 |
| `toolBuffers` | 各工具的 id、name、参数原文和 contentIndex |
| `finish` | 结束原因与 usage |

这些值属于一次请求，写在 `stream()` 内。每次 delta 先更新对应槽位，再用
`structuredClone(content)` 留下事件快照。后来的字符不会反过来改变已经发出的
partial。

finish 决定工具参数怎样收尾。`tool_calls` 表示 Provider 已经完成工具调用，此时
adapter 解析完整 JSON，并发出 `toolcall_end`。`length` 表示输出被截断；参数原文会
留下来，stop reason 也保持 `length`，后续 Agent Loop 不会执行它。

transport 抛出的异常会沿用当前 `content` 生成 error message。取消对应
`aborted`，其他异常对应 `error`。终态事件与 `stream.result()` 使用同一条最终消息。

:::lab title="实践 5.2 · 完成 normalized transport 状态机"
**目标：** 用离线 `ProviderChunk` 还原累计文本、工具调用和最终消息。

**文件：** `packages/pi-course/src/provider-adapter.ts`

**动作：**
1. 实现按数组顺序产出 chunk 的 `fixedTransport()`。
2. 在每次 `stream()` 内保存 content、文本槽位、tool buffers 和 finish。
3. 第一次看到文本或工具时分配 content 槽位；后续 delta 更新原槽位。
4. 每次更新后克隆 partial，再发送对应事件。
5. 根据 finish 完成工具、映射 stop reason，并让终态与 `result()` 汇合。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="normalized transport" \
  packages/pi-course/dist/test/05-*.test.js
```

**预期：** `3/3`。测试使用 4、2 两个 Provider tool index，并检查 content 顺序、每个
partial、transport 异常和 `length` 下保留的参数原文。
:::

到这里，adapter 已经可以完全离线运行。余下工作是让网络响应产生同样的
`ProviderChunk`。

## 从 SSE 字节流读出 ProviderChunk

`fetch` 返回 `ReadableStream<Uint8Array>`。一次 `reader.read()` 只表示“这次读到了
一些字节”，它不对应一条 SSE event。主线中的第一条 data 可以在 `call-1` 中间被切成
两个网络 chunk。下面用引号表示每次解码出的字符串；`chunk #1` 末尾没有换行：

```text
chunk #1
'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-'

chunk #2
'1","type":"function","function":{"name":"read","arguments":"{\"path\":"}}]},"finish_reason":null}]}\n\n'
```

网络边界只是 `chunk #1 | chunk #2`，不会在 JSON 数据中加入字符。transport 维护一个
字符串 `buffer`，新字节由带 `{ stream: true }` 的 `TextDecoder` 解码后依次 append：

```text
append chunk #1 后
buffer = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-'
         没有 \n，暂时取不出一行

append chunk #2 后
buffer = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read","arguments":"{\"path\":"}}]},"finish_reason":null}]}\n\n'
         第一个 \n 结束 data 行；第二个 \n 形成空行并结束这条 SSE event
```

这里的 `\n\n` 是 SSE 协议本来就有的“行结束 + 空行”，与两次 `reader.read()` 的切分
位置无关。空行出现后，此前收集的 `data:` 行才构成一条完整 SSE payload。

```text
网络字节块            没有协议含义
    ↓ TextDecoder
文本行                 识别 data:
    ↓ 空行结束一组 data
SSE payload 字符串
    ↓ JSON.parse + 字段检查
ProviderChunk
```

`JSON.parse()` 的结果从 `unknown` 开始。主线走的是 `delta.tool_calls`；先用一个
主线完成后的纯文本 payload，把逐层收窄路径看短一些：

```text
rawChunk: unknown
  → isRecord(rawChunk)
  → Array.isArray(rawChunk.choices)
  → choices.length === 1
  → choice = choices[0]，isRecord(choice)
  → isRecord(choice.delta)
  → content = choice.delta.content，typeof content === "string"
  → { type: "text", delta: content } satisfies ProviderChunk
```

例如 `{"choices":[{"delta":{"content":"正在读取"}}]}` 会沿这条路径得到
`{ type: "text", delta: "正在读取" }`。若外部数据改成
`{"choices":[{"delta":{"content":42}}]}`，验证停在 `typeof content === "string"`，
抛出 `Invalid provider chunk: choices[0].delta.content must be a string`；数字不会进入
`ProviderChunk`。

其余字段复用同一种模式：`tool_calls` 先检查数组，再逐项检查 record，其中 `index`
必须是非负安全整数，`id`、`name`、`arguments` 在出现时必须是字符串；
`finish_reason` 检查 `stop/length/tool_calls` 联合；usage 先检查 record，再检查三个
非负安全整数。于是主线 payload 通过这些检查后，才成为前文的 `call-1/index 0` tool
`ProviderChunk`。普通流只接受一个 choice；空 `choices` 专门承载尾随 usage。

`finish_reason` 与 usage 可能来自不同 payload。transport 读到结束原因后先记住它，
继续等待尾随 usage；遇到 `[DONE]` 或输入结束，再合成唯一的 finish chunk。整个流
没有出现结束原因时，adapter 会用已经积累的 partial 形成 error 终态。

读取前后都检查 abort signal。reader 在 `finally` 中取消并释放 lock，所以正常结束、
解析异常和取消会走过同一个资源清理位置。

:::lab title="实践 5.3 · 解析 SSE，并守住 unknown 边界"
**目标：** 从任意分块的 OpenAI-compatible SSE 产出经过检查的 `ProviderChunk`。

**文件：** `packages/pi-course/src/provider-adapter.ts`

**动作：**
1. 写出 record、字符串、token 数、usage、finish reason 和 tool chunk 的检查函数。
2. 用 line buffer 读取 SSE，不把网络 chunk 当作 event。
3. 通过可注入的 fetch 取得 Response，并把 signal 交给 fetch 和 reader。
4. 记录 finish reason，合并尾随 usage，最后产出一个 finish chunk。
5. 保留 `AbortError` 的取消语义。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="SSE" \
  packages/pi-course/dist/test/05-*.test.js
```

**预期：** `5/5`。测试观察交错工具参数、尾随 usage、缺少 finish、流中取消、无效
chunk 和未知 finish reason。
:::

## 发出 HTTP 请求

transport 最后需要写出完整的 fetch 选项。base URL 去掉末尾斜杠后，加上
`/chat/completions`：

```ts
{
  method: "POST",
  headers: {
    Accept: "text/event-stream",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    ...request,
    stream: true,
    stream_options: { include_usage: true },
  }),
  signal,
}
```

API key 由 transport 配置持有。请求发出时，它进入 `Authorization` header；body、
`AgentContext` 和 canonical message 中都没有这项数据。底层 fetch 的异常文本可能
包含认证信息，因此 transport 在错误离开这一层之前，把 key 替换成 `[redacted]`。
`AbortError` 保持原来的名称，adapter 才能识别取消。

课程测试注入离线 fetch，直接记录 URL、header、body 和 signal。它不会调用真实
Provider，也不需要 API key 或网络费用。

:::lab title="实践 5.4 · 固定请求形状并保护密钥"
**目标：** 写出可观察的 HTTP 请求，并在 transport 内处理测试覆盖的密钥泄露路径。

**文件：** `packages/pi-course/src/provider-adapter.ts`

**动作：**
1. 用 `new URL()` 检查最终 endpoint。
2. 发送 POST，请求体加入 stream 与 usage 选项，并传递同一个 signal。
3. 写 `sanitizedTransportError()`；取消保持 `AbortError`，其他错误替换 API key。
4. 先运行 fetch transport 测试，再运行第 05 章全部测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="fetch transport" \
  packages/pi-course/dist/test/05-*.test.js
node --test packages/pi-course/dist/test/05-*.test.js
```

**预期：** 局部测试 `2/2`，完整聚焦测试 `11/11`。离线 fetch 会精确记录请求，并让
一条底层错误主动带上测试密钥；最终消息中只留下 `[redacted]`。
:::

:::mechanism title="这段调用现在可以分开阅读"
出站消息由纯函数转换。adapter 只读取 `ProviderChunk`，它的顺序和 partial 可以在
离线数组上观察。transport 再单独处理 fetch、SSE 和 unknown JSON。三段代码通过
明确的数据形状连接，内部状态互不共享。
:::

:::note title="测试覆盖到哪里"
这 11 项聚焦测试直接验证 adapter 与 transport 的三段边界：

- canonical context 会稳定映射为 wire messages、tools 与可观察的 fetch 请求；
- 两次网络读取会重组为 SSE payload，外部 `unknown` 经过字段检查后才产出
  `ProviderChunk`；transport 还负责汇合结束原因与 usage、传递取消并脱敏测试中的密钥；
- `ProviderChunk` 的顺序与参数分片会形成对应的 partial `ModelEvent` 和最终
  `AssistantMessage`。

工具执行与 transcript 更新从第 06、07 章继续。
:::

:::pi title="与当前上游 Pi 对照"
固定提交 `8479bd8` 的 `packages/ai/src/api/openai-completions.ts` 同样会累积文本和
工具参数、映射结束原因、解析 usage，并把捕获的异常转换成流内终态。上游还处理
reasoning、图片、签名、成本和更多兼容差异。课程保留这条调用链的核心部分，并用
`ProviderChunk` 把网络解析与 canonical 事件生成分开。
:::

## 故意把它弄坏

这一节是完成实现后的诊断实验。把工具的 `contentIndex` 临时改成 Provider 给出的
`chunk.index`：

```ts
contentIndex: chunk.index
```

测试数据中的工具 index 按 4、2 到达，中间还有文本。改动以后，第一个
`toolcall_delta` 会指向 `content[4]`，而当时真正创建的工具槽位是 `content[0]`。

:::failure title="预期失败 · 混淆两种 index"
运行“normalized transport”测试，比较第一条 `toolcall_delta` 的实际
`contentIndex` 与期望值。随后恢复原来的记录方式：工具第一次出现时保存
`content.length`，后续 delta 与 `toolcall_end` 都使用这个值。
:::

## 本章验收

:::checkpoint title="Checkpoint 05 · 完成一次 Provider 调用"
运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/05-*.test.js
```

结果应为 `11/11`。再沿本章的调用顺序检查五件事：

1. 一条 user message 怎样写成 Provider wire message？
2. Provider tool index 与 canonical content index 分别记录什么？
3. 一段 SSE 字节在哪一步变成 `ProviderChunk`？
4. finish reason 和尾随 usage 怎样汇合？
5. API key 在调用期间出现在哪里？

`npm run checkpoint -w @pi/course -- 05` 可以重新定位本章的 parent 与 target；
`npm run practice -w @pi/course -- 05 <新目录>` 会从同一 parent 创建新的隔离练习目录。
第 06 章将从已经形成的 tool call 开始，为参数加入 schema 验证和执行结果。
:::

## 可选迁移练习

:::transfer title="迁移 · 读取另一种流式事件"
设想一个小型 Provider 使用 `event: token`、`event: action` 和 `event: end`。为它写一
个新的 transport，把三类事件转换成现有 `ProviderChunk`。adapter、`AgentMessage`
和 `ModelEvent` 保持不变。若原协议含有课程类型无法表达的数据，单独记录这项差异。
:::

## 小结

一次真实模型调用现在可以从头读到尾。`AgentContext` 先变成 Provider 的消息和工具
定义；transport 发出 HTTP 请求，从 SSE 中读出经过检查的 `ProviderChunk`；adapter
再把这些 chunk 累积成 `ModelEvent` 与最终 `AssistantMessage`。

第 04 章的离线模型和这一章的真实模型因此共享 `Model.stream()`。上层代码不需要
读取 Provider 的 URL、header、`choices` 或 SSE。下一章会继续处理模型已经提出的
工具调用。
