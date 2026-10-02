---
id: "03"
slug: message-ir
part: foundations
partTitle: 第一部 · 建立可执行语言
chapter: "03"
title: 保存一次完整的工具往返
summary: 用一段 README transcript 看清文本、工具调用和工具结果怎样成为可保存的消息。
minutes: 100
difficulty: 核心
artifact: packages/pi-course/src/types.ts
prerequisites: 02
terms: canonical IR, content block, system message, AgentContext, StopReason, projection
upstream: packages/ai/src/types.ts
---

## 你将得到什么

用户说：“请读取 README，然后告诉我项目名。”模型没有立刻回答项目名。它先说明
自己要做什么，接着请求 `read` 工具；工具读完文件后，又把内容交回 Agent。

这次往返可以保存成三个对象：

```ts
const transcript = [
  {
    role: "user",
    content: [
      { type: "text", text: "请读取 README，然后告诉我项目名。" },
    ],
    timestamp: 1_000,
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "我先读取项目说明。" },
      {
        type: "toolCall",
        id: "call_1",
        name: "read",
        arguments: { path: "README.md" },
      },
    ],
    provider: "scripted",
    model: "scripted-v1",
    usage: { input: 18, output: 12, totalTokens: 30 },
    stopReason: "toolUse",
    timestamp: 1_010,
  },
  {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [{ type: "text", text: "# tiny-pi\nA small agent runtime." }],
    isError: false,
    timestamp: 1_020,
  },
];
```

数组顺序就是事实发生的顺序。assistant 的 `content[0]` 是它给用户看的说明，
`content[1]` 才是工具请求。工具返回的对象使用 `toolCallId: "call_1"`，所以 Agent
知道这份 README 内容回答的是哪一次请求。

这三个对象已经足够表达一次工具往返。课程把这种由 Agent 自己定义、可以保存和重放
的统一表示称为 canonical message，也称消息 IR（intermediate representation）。
Provider 的请求体和终端显示文字都可以由它转换出来，但它们不会取代这三个原始对象。

完成这一章后，你会得到：

- `types.ts` 中四种消息、两种 content block、五种结束原因和模型事件；
- 三个重放 system message 的纯函数，用来从 transcript 算出当前 system prompt；
- `event-stream.ts` 中专门运送模型事件并返回最终 assistant message 的流；
- 一个只读取文本、却不会改写原消息的 `textOf()`。

:::rebuild title="Checkpoint 03 · 保存一段工具往返"
**模式：** 重建。

**起终点：** parent 是第 02 章完成后的起点快照；target 是这两份教学文件完成、聚焦测试
通过后的终点快照。

**教学文件：**
- `packages/pi-course/src/types.ts`
- `packages/pi-course/src/event-stream.ts`

**动手前只需知道：** transcript 用 role 与 content block 保留消息来源和顺序；
system prompt 也是 transcript 里的 system message，按顺序重放就得到当前 prompt；
`ModelEvent` 描述生成过程，`AssistantMessage` 是过程结束后保存的结果。

**第一次红灯：** 在 parent 上运行 build，会报告没有导出
`AssistantMessageEventStream`，同时找不到 `../src/types.js`。两条错误分别指向上面的
两份教学文件。

**第一步：** 先不看 target diff。运行 build 记录红灯，然后在 `types.ts` 写出消息、
helper 和 system 重放函数；在 `event-stream.ts` 声明临时 `AssistantMessageEventStream`。
实践 3.1 只运行文本投影和 system 重放测试，实践 3.2 再完成终态映射。

**聚焦测试：** `packages/pi-course/test/03-message-ir.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 03`

**练习目录：** `npm run practice -w @pi/course -- 03`

**聚焦运行：** `npm run build -w @pi/course`，然后
`node --test packages/pi-course/dist/test/03-*.test.js`

**通过证据：** 4 项聚焦测试通过。前 2 项聚焦测试分别证明文本投影不修改原 content，
以及 `error` 会自行结束流、`result()` 返回事件中同一个 `AssistantMessage`；后 2 项证明
system message 按顺序重放，并按固定顺序渲染成 prompt 文本。
:::

## content 数组保留“说了什么”和“要做什么”

assistant 的两个 content 使用同一个数组，却有不同的 `type`：

```ts
export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
  rawArguments?: string;
}

export type AssistantContent = TextContent | ToolCall;
```

数组中的一个元素叫 content block。`TextContent` 保存文字；`ToolCall` 保存调用 id、
工具名和结构化参数。两者的 `type` 是第 01 章学过的判别字段。代码检查
`block.type === "text"` 后，TypeScript 才允许读取 `block.text`。

`arguments` 暂时是 `unknown`。消息只能证明模型输出了 `{ path: "README.md" }`，还不能
证明这个对象符合 `read` 工具的参数规则。第 06 章的 schema 检查通过后，工具层才会
执行它。`rawArguments` 保存 Provider 给出的原始参数字符串；完整调用也可以保留它，
参数被截断时它尤其重要。保留原文不等于允许执行。

content block 的数组位置同样属于消息。当前 assistant 先发出文本，再提出工具调用：

```text
content[0]  text      我先读取项目说明。
content[1]  toolCall  read({ path: "README.md" })
```

若模型先提出调用、后补充说明，两个 block 的位置也会随之交换。保存消息时不能把所有
文本挪到数组前面。

## 三个 role 记录三种来源

transcript 中每个对象的 `role` 都回答同一个问题：这项事实是谁产生的？

| role | 当前对象记录的事实 | 合法 content |
|---|---|---|
| `user` | 用户要求读取 README | 文本 |
| `assistant` | 模型的说明和 `read` 请求 | 文本、工具调用 |
| `toolResult` | 环境执行 `read` 后得到的结果 | 文本 |

类型定义把这三种所有权分别写开：

```ts
export interface UserMessage {
  role: "user";
  content: TextContent[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}
```

这三种消息足够保存 README 往返。`types.ts` 的 `AgentMessage` 联合里还有第四种
`SystemMessage`，它保存 Agent 交给模型的指令，后面讲 `AgentContext` 时再展开。读取
一条消息时，先检查 `role`，随后才能访问该角色独有的字段。例如，只有 `toolResult`
拥有 `toolCallId` 和 `isError`。

工具请求里的 `id` 与工具结果里的 `toolCallId` 是一对配对键：

```text
assistant.content[1].id       = "call_1"
toolResult.toolCallId         = "call_1"
```

`toolName: "read"` 方便人和工具层检查结果来源，真正把请求与结果连起来的是 id。
以后即使两个 `read` 同时执行，各自的结果也能回到正确请求。

## stopReason 说明这次模型调用为何停下

当前 assistant message 使用 `stopReason: "toolUse"`。它表示模型已经提出工具请求，
Agent 接下来应该把完整调用交给工具层。五种结束原因写成一个联合：

```ts
export type StopReason =
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted";
```

它们分别要求不同的后续动作：

| 值 | 已发生的事情 | Agent 的下一步 |
|---|---|---|
| `stop` | 模型正常完成回答 | 结束本轮 |
| `toolUse` | 模型完成了工具请求 | 验证并执行工具 |
| `length` | 输出长度达到上限 | 保留已有内容，不执行可能残缺的调用 |
| `error` | 模型调用失败 | 保留 partial 与错误说明，结束当前运行 |
| `aborted` | 调用被取消 | 保留 partial 与取消事实，结束当前运行 |

`errorMessage` 只在需要诊断时携带文字说明。`usage` 则记录本次调用的输入、输出和总
token 数：

```ts
export interface Usage {
  input: number;
  output: number;
  totalTokens: number;
}
```

这些字段与 content 一起构成最终 assistant message。即使调用失败，已经生成的文字、
用量和失败原因仍能作为同一条事实保存下来。

## AgentContext 把 transcript 交给下一次模型调用

工具结果到达后，下一次模型调用需要同时看到用户请求、工具请求和工具结果。如果要把
开头的数组交给下一次调用，可以把它显式标成 `const transcript: AgentMessage[] = [...]`。
三个对象的内容不变，只增加数组的类型。

模型还需要 Agent 自己的指令，例如“回答前先读取相关文件。”这句指令同样写成一条消息，
放在 transcript 最前面：

```ts
const nextContext: AgentContext = {
  messages: [
    { role: "system", content: "回答前先读取相关文件。", timestamp: 990 },
    ...transcript,
  ],
};
```

`AgentContext` 是本次模型调用的输入视图。这一章的 target 里，它只有一个字段：

```ts
export interface AgentContext {
  messages: AgentMessage[];
}
```

`messages` 保持 transcript 的顺序。模型读到最后一条 `toolResult` 后，才有依据回答
项目名是 `tiny-pi`。这个 context 不负责保存整个 session，也不裁剪旧消息；第 10 章
会保存 session，第 11 章再根据预算构造 context。

这一章的 target 还没有工具定义字段。第 05 章接入 Provider 时，`AgentContext` 才会
增加可选的 `tools`。此处只保存模型已经看到的消息，指令也在其中。

## system message 按顺序重放成当前 prompt

开头那条 `role: "system"` 的消息使用下面的类型。它和另外三种消息一起组成
`AgentMessage`：

```ts
export interface SystemMessage {
  role: "system";
  /** 开头一条：基础 prompt；之后：追加的说明。可以为空字符串。 */
  content: string;
  /** 具名段落。之后的 system message 按名字替换，null 表示删除。 */
  sections?: Record<string, string | null>;
  timestamp: number;
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;
```

transcript 中第一条 system message 是基础 prompt。之后若要改指令，Agent 不回头修改
这条消息，而是在当前位置追加一条新的 system message，只写这次的变化：`content`
追加一段说明；`sections` 按名字替换某个段落，值为 `null` 时删除该段。

下面这段 transcript 改了两次指令：

```text
system     timestamp=10  content="You are Pi."
                         sections={ rules: "RULE v1", scratch: "SCRATCH" }
user       go
system     timestamp=20  content=""
                         sections={ rules: "RULE v2", scratch: null }
assistant  ok
system     timestamp=30  content="Prefer small diffs."
```

把三条 system message 按出现顺序合并，得到模型此刻应当遵守的那一条：

```ts
{
  role: "system",
  content: "You are Pi.\n\nPrefer small diffs.",
  sections: { rules: "RULE v2" },
  timestamp: 10,
}
```

`rules` 被第二条换成 v2，`scratch` 被 `null` 删除，第三条的说明接在基础 prompt
后面。合并后的时间戳沿用第一条 system message。`currentSystemMessage()` 就按这个顺序
重放：

```ts
export function currentSystemMessage(
  messages: readonly AgentMessage[],
): SystemMessage | undefined {
  const content: string[] = [];
  const sections = new Map<string, string>();
  let timestamp: number | undefined;
  for (const message of messages) {
    if (message.role !== "system") continue;
    timestamp ??= message.timestamp;
    if (message.content.length > 0) content.push(message.content);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  if (timestamp === undefined) return undefined;
  return {
    role: "system",
    content: content.join("\n\n"),
    ...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
    timestamp,
  };
}
```

函数跳过其他 role，只读不写。空的 `content` 不会留下多余的 `\n\n`；段落全部删除后，
结果里也不再带空的 `sections`。transcript 中没有 system message 时，它返回
`undefined`。

模型最终读到的是一段文本。`systemMessageText()` 把 `content` 和各段落正文依次用
`\n\n` 连接，空串跳过；`currentSystemPrompt()` 把两步组合起来：

```ts
export function systemMessageText(message: SystemMessage): string {
  const parts = [message.content];
  for (const value of Object.values(message.sections ?? {})) {
    if (value !== null) parts.push(value);
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}

export function currentSystemPrompt(
  messages: readonly AgentMessage[],
): string | undefined {
  const message = currentSystemMessage(messages);
  return message ? systemMessageText(message) : undefined;
}
```

上面那段 transcript 的当前 prompt 是 `"You are Pi.\n\nPrefer small diffs.\n\nRULE v2"`。

这样设计以后，改 prompt 也成了一项追加到 transcript 末尾的事实。已经写下的消息一条
都不改，第 10 章保存的会话文件仍然只追加，第 11 章从同一段 history 能重放出同一个
prompt。已经发给 Provider 的请求前缀同样保持原样：模型若接受对话中途的 system
message，补丁可以在原位发送，前面的字节完全相同，Provider 的 prompt cache 继续命中。
Pi 1.0 正是为此把 system prompt 放进 transcript。第 05 章的课程 adapter 会把重放结果
折叠成一条开头的 system message 再发出，transcript 本身仍保持这里的样子。

## textOf() 只提供文本视图

终端想显示 assistant 的说明时，不需要展示整个工具对象。`textOf()` 逐个检查 block，
只收集文本：

```ts
export function textOf(message: AgentMessage): string {
  if (message.role === "system") return systemMessageText(message);
  const blocks: readonly AssistantContent[] = message.content;
  return blocks.flatMap((block) =>
    block.type === "text" ? [block.text] : []
  ).join("\n");
}
```

system message 没有 content block 数组，所以第一行先把它交给 `systemMessageText()`。
其余三种消息继续逐个检查 content block。

把 transcript 中的 assistant message 传进去，结果是：

```text
我先读取项目说明。
```

`read`、`call_1` 和 `{ path: "README.md" }` 没有进入结果，原来的 `content` 数组仍然
完整。这个从完整对象取出的只读视图叫投影。`textOf()` 是有损投影，适合终端显示、
搜索和摘要；保存或重放 transcript 时要使用原始消息。

同一文件还提供两个小构造函数。它们把常用默认值放在一个位置：

```ts
export function text(value: string): TextContent {
  return { type: "text", text: value };
}

export function userMessage(value: string): UserMessage {
  return {
    role: "user",
    content: [text(value)],
    timestamp: Date.now(),
  };
}
```

`assistantMessage()` 同样创建 assistant message，并允许测试通过 `overrides` 固定
provider、model、usage、错误说明或时间。构造函数减少重复对象字面量，但返回值仍是
前面定义的消息。

## 模型事件最终汇合成一条 assistant message

第 02 章的 `EventStream<T, R>` 已经能同时服务异步迭代和 `result()`。现在两个类型参数
都有了具体含义：

```ts
EventStream<ModelEvent, AssistantMessage>
```

`ModelEvent` 描述生成过程。`AssistantMessage` 是这次生成结束后保存的结果。

仍用开篇那条 README assistant message。第 04 章的 `ScriptedModel` 会把它按下面的顺序
交给消费者：

```text
start
  partial.content = []

text_delta(contentIndex=0, delta="我先读取项目说明。")
  partial.content = [text("我先读取项目说明。")]

toolcall_delta(contentIndex=1, delta='{"path":"README.md"}')
  partial.content = [text(...), toolCall(call_1, read, arguments={}, rawArguments=...)]

toolcall_end(contentIndex=1)
  partial.content = [text(...), toolCall(call_1, read, arguments={ path: "README.md" })]

done(reason="toolUse")
  message = 上面的完整 assistant message
```

每一步都围绕同一个 `partial` 的后继快照。文本到达后，`content[0]` 可见；工具参数片段
到达后，`content[1]` 先保存 raw text；`toolcall_end` 才把这个槽位收束成结构化
`ToolCall`。`done` 不再提供增量，而是交出最终要保存的 message。

这些可观察状态对应下面五种正常事件和一条错误终态：

```ts
export type ModelEvent =
  | { type: "start"; partial: AssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      message: AssistantMessage;
    }
  | {
      type: "error";
      reason: Extract<StopReason, "error" | "aborted">;
      error: AssistantMessage;
    };
```

这里的 `contentIndex` 就是上面 partial 数组中的位置。`toolcall_end` 只表示参数片段已经
组成一个 `ToolCall`；第 06 章的 schema 还会检查它能否执行。若生成过程失败，最后一步
从 `done(message)` 换成 `error(error)`。两条终态路径都会给 `result()` 一条
`AssistantMessage`。

因此专用流只需告诉通用流两件事：哪些事件是终态，以及怎样从终态取出结果。

```ts
export class AssistantMessageEventStream
  extends EventStream<ModelEvent, AssistantMessage>
  implements ModelStream
{
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("非终态事件不能生成最终消息");
      },
    );
  }
}
```

当 `push()` 收到 `error` 事件时，第一段函数返回 `true`。第 02 章实现的通用流随即完成
最终 Promise，并把这条终态留给异步迭代器。第二段函数返回 `event.error`；所以
`stream.result()` 与事件引用的是同一个 assistant message。

:::lab title="实践 3.1 · 保存消息、读取文本并重放 system"
**目标：** 写出消息协议和 helper，让 README transcript 能保留完整 content，同时得到
只含文本的显示结果；再从多条 system message 重放出当前 prompt。

**文件：**
- `packages/pi-course/src/types.ts`
- `packages/pi-course/src/event-stream.ts`

**动作：**
1. 在 `types.ts` 定义 content block、四种 message（含 `SystemMessage`）、`Usage`、
   `StopReason`、`AgentContext`、`ModelEvent`、`ModelStream` 和 `Model`。
2. 实现 `text()`、`userMessage()`、`assistantMessage()` 与 `textOf()`。
3. 实现 `currentSystemMessage()`、`systemMessageText()` 与 `currentSystemPrompt()`。
4. 为了让整份测试文件能够编译，在 `event-stream.ts` 临时声明
   `AssistantMessageEventStream`。它继承
   `EventStream<ModelEvent, AssistantMessage>`；构造器暂时传入永不结束的判断函数，
   结果提取函数抛出 `"not implemented in lab 3.1"`。
5. 先运行名称含“文本投影”的测试，再运行名称含“system”的两项测试。它们都不会执行
   这个临时流。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="文本投影" \
  packages/pi-course/dist/test/03-*.test.js
node --test --test-name-pattern="system" \
  packages/pi-course/dist/test/03-*.test.js
```

**预期：** 先是 `1/1`。`textOf()` 得到“先读取\n再回答”，中间的 `read` tool call 仍完整
留在原消息中。随后是 `2/2`。重放结果的 content 是“You are Pi.\n\nPrefer small
diffs.”，`sections` 只剩 `rules: "RULE v2"`，时间戳是 `10`，原来的 messages 没有被
改写；`systemMessageText()` 跳过空段落和 `null`，得到“A\n\nB”。
:::

:::lab title="实践 3.2 · 让 error 自己结束消息流"
**目标：** 用 `done | error` 结束第 02 章的通用流，并返回终态事件携带的消息。

**文件：** `packages/pi-course/src/event-stream.ts`

**动作：**
1. 删除实践 3.1 中的临时构造逻辑。
2. 让终态判断函数识别 `done` 和 `error`。
3. 从 `done` 读取 `event.message`，从 `error` 读取 `event.error`；其余事件不能产生
   最终结果。
4. 运行完整聚焦测试。测试不会额外调用 `end()`，`error` 事件需要自行结束迭代。

**运行：**

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/03-*.test.js
```

**预期：** `4/4`。异步迭代只观察到 `"error"`，随后结束；`result()` 返回传给
`push()` 的同一个错误消息，并保留 `errorMessage: "socket reset"`。实践 3.1 的三项测试
继续通过。
:::

:::note title="测试覆盖到哪里"
4 项聚焦测试直接证明：文本投影会跳过工具调用，而且不修改原 content；`error` 是流的
终态，`result()` 返回事件里的同一条消息；system message 按顺序重放，追加 content、
按名字覆盖或删除段落，且不改写任何原消息；`systemMessageText()` 按 content、段落的
顺序拼接。正常 `start → delta → done` 时间线会在第 04、05 章进入可执行模型与 Provider
测试；tool call/result 的 id 配对由第 06、07 章接手；system 折叠成一条请求消息在第 05 章
完成。
:::

:::pi title="与上游 Pi v1.0.0 对照"
Pi v1.0.0 的 `Message` 由 system、user、assistant、toolResult 四种消息组成
（`packages/ai/src/types.ts:610`），同样使用 content blocks。8479bd8 时 `Message` 只有
后三种（当时 `types.ts:414`），system prompt 是请求 Context 上的一个字符串；1.0 改为
transcript 中的 `SystemMessage`（`packages/ai/src/types.ts:512-538`）。课程的三个重放
函数对应上游 `packages/ai/src/utils/transcript.ts:73-102` 的 `getCurrentSystemMessage`、
`getCurrentSystemPrompt`，以及 `packages/ai/src/utils/text.ts:15` 的
`getSystemMessageText`：content 用 `\n\n` 追加，段落按名字覆盖，`null` 删除，时间戳取
第一条 system message。

课程简化：`SystemMessage.content` 只接受字符串，上游还接受 `TextContent[]`；上游的
system message 还能用 `toolsAdded` / `toolsRemoved` 声明工具集合变化，第 15 章补上；
没有 system message 时课程返回 `undefined`，上游 `getCurrentSystemPrompt` 返回空字符串。
`StopReason` 课程保留五个值。8479bd8 时上游也是五个（当时 `types.ts:375`），1.0 改为
七个（`packages/ai/src/types.ts:450`），新增的 `pending`、`deferred` 用于延迟请求。上游
还支持图片、thinking、签名、缓存和成本等字段。课程保留 README 往返和 system 重放需要
的最小形状，让每个字段都能在后续调用链中找到用途。1.0 的 system 消息模型全貌见
[附录：Pi 1.0 机制与章节对照](/pi-1-0)。
:::

## 用一次可观察的错误检查 textOf()

完成正常实现后，可以临时让 `textOf()` 把工具名也加入结果：

```ts
return blocks.flatMap((block) =>
  block.type === "text" ? [block.text] : [block.name]
).join("\n");
```

:::failure title="预期失败 · 把工具名混进文本投影"
运行名称含“文本投影”的测试。实际结果会变成“先读取\nread\n再回答”，而期望结果是
“先读取\n再回答”。恢复只提取 text block 的实现，并重新确认 4 项聚焦测试通过。
:::

## 本章验收

:::checkpoint title="Checkpoint 03 · transcript 有了稳定形状"
运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/03-*.test.js
```

结果应为 `4/4`。再沿 README transcript 检查六个位置：

1. 用户请求保存在哪一种 message 中？
2. assistant 的文字与 tool call 怎样保持原顺序？
3. `id: "call_1"` 与 `toolCallId: "call_1"` 怎样配对？
4. `stopReason: "toolUse"` 要求 Agent 接下来做什么？
5. `textOf()` 省略了哪些信息，原信息还保存在何处？
6. 要把 `rules` 段落换成新版本，Agent 往 transcript 里写什么？开头那条 system message
   会被改动吗？

`npm run checkpoint -w @pi/course -- 03` 可以重新定位 parent 与 target；
`npm run practice -w @pi/course -- 03 <新目录>` 会从同一 parent 创建新的隔离练习目录。
第 04 章会让 `ScriptedModel` 按这套消息协议播放两次确定的模型调用。
:::

## 小结

README 往返现在保存为三条有顺序的消息。user 记录请求，assistant 依次记录说明和工具
调用，toolResult 使用同一个调用 id 记录环境返回。`StopReason` 说明模型为何停下，
`AgentContext` 把这段 transcript 交给下一次调用，`textOf()` 则从完整消息中取出文本
视图。Agent 的指令也以 system message 的形式留在同一份 transcript 里；改指令只追加
新的 system message，`currentSystemPrompt()` 按顺序重放出当前 prompt。

`AssistantMessageEventStream` 把生成过程中的 `ModelEvent` 与最终
`AssistantMessage` 接到第 02 章的同一个流上。下一章会在不接网络的情况下，让同一个
`ScriptedModel` 连续接收两次 context，并播放两个确定的模型 turn；真正把 tool result
送进第二次调用的循环留到第 07 章。
