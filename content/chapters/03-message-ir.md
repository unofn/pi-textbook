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
terms: canonical IR, content block, AgentContext, StopReason, projection
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

- `types.ts` 中三种消息、两种 content block、五种结束原因和模型事件；
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
`ModelEvent` 描述生成过程，`AssistantMessage` 是过程结束后保存的结果。

**第一次红灯：** 在 parent 上运行 build，会报告没有导出
`AssistantMessageEventStream`，同时找不到 `../src/types.js`。两条错误分别指向上面的
两份教学文件。

**第一步：** 先不看 target diff。运行 build 记录红灯，然后在 `types.ts` 写出消息和
helper；在 `event-stream.ts` 声明临时 `AssistantMessageEventStream`。实践 3.1 只运行
文本投影测试，实践 3.2 再完成终态映射。

**聚焦测试：** `packages/pi-course/test/03-message-ir.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 03`

**练习目录：** `npm run practice -w @pi/course -- 03`

**聚焦运行：** `npm run build -w @pi/course`，然后
`node --test packages/pi-course/dist/test/03-*.test.js`

**通过证据：** 2 项聚焦测试通过。第一项证明文本投影不修改原 content；第二项证明
`error` 会自行结束流，并且 `result()` 返回事件中同一个 `AssistantMessage`。
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

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;
```

`AgentMessage` 是三种消息的联合。读取一条消息时，先检查 `role`，随后才能访问该角色
独有的字段。例如，只有 `toolResult` 拥有 `toolCallId` 和 `isError`。

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

工具结果到达后，下一次模型调用需要同时看到用户请求、工具请求和工具结果：

如果要把开头的数组交给下一次调用，可以把它显式标成
`const transcript: AgentMessage[] = [...]`。三个对象的内容不变，只增加数组的类型。

```ts
const nextContext: AgentContext = {
  systemPrompt: "回答前先读取相关文件。",
  messages: transcript,
};
```

`AgentContext` 是本次模型调用的输入视图：

```ts
export interface AgentContext {
  systemPrompt?: string;
  messages: AgentMessage[];
}
```

`messages` 保持 transcript 的顺序。模型读到最后一条 `toolResult` 后，才有依据回答
项目名是 `tiny-pi`。这个 context 不负责保存整个 session，也不裁剪旧消息；第 10 章
会保存 session，第 11 章再根据预算构造 context。

这一章的 target 还没有工具定义字段。第 05 章接入 Provider 时，`AgentContext` 才会
增加可选的 `tools`。此处只保存模型已经看到的消息。

## textOf() 只提供文本视图

终端想显示 assistant 的说明时，不需要展示整个工具对象。`textOf()` 逐个检查 block，
只收集文本：

```ts
export function textOf(message: AgentMessage): string {
  const blocks: readonly AssistantContent[] = message.content;
  return blocks.flatMap((block) =>
    block.type === "text" ? [block.text] : []
  ).join("\n");
}
```

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

`start` 和两个 delta 让消费者观察生成中的消息。`toolcall_end` 表示这个工具槽位的
流式片段已经收束成一个 `ToolCall` 对象；它不证明参数合法或可执行，仍要结合终态
原因与第 06 章的 schema 检查。`done` 与 `error` 是两条终态路径：前者携带
`message`，后者携带 `error`。两条路径最后都要让 `result()` 得到一条
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

:::lab title="实践 3.1 · 保存消息并读取文本"
**目标：** 写出消息协议和 helper，让 README transcript 能保留完整 content，同时得到
只含文本的显示结果。

**文件：**
- `packages/pi-course/src/types.ts`
- `packages/pi-course/src/event-stream.ts`

**动作：**
1. 在 `types.ts` 定义 content block、三种 message、`Usage`、`StopReason`、
   `AgentContext`、`ModelEvent`、`ModelStream` 和 `Model`。
2. 实现 `text()`、`userMessage()`、`assistantMessage()` 与 `textOf()`。
3. 为了让整份测试文件能够编译，在 `event-stream.ts` 临时声明
   `AssistantMessageEventStream`。它继承
   `EventStream<ModelEvent, AssistantMessage>`；构造器暂时传入永不结束的判断函数，
   结果提取函数抛出 `"not implemented in lab 3.1"`。
4. 只运行名称含“文本投影”的测试。它不会执行这个临时流。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="文本投影" \
  packages/pi-course/dist/test/03-*.test.js
```

**预期：** `1/1`。`textOf()` 得到“先读取\n再回答”，中间的 `read` tool call 仍完整
留在原消息中。
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

**预期：** `2/2`。异步迭代只观察到 `"error"`，随后结束；`result()` 返回传给
`push()` 的同一个错误消息，并保留 `errorMessage: "socket reset"`。
:::

:::note title="测试覆盖到哪里"
2 项聚焦测试直接证明：文本投影会跳过工具调用，而且不修改原 content；`error` 是流的
终态，`result()` 返回事件里的同一条消息。测试没有遍历三种 role、五种 `StopReason`
和全部 `ModelEvent`，也没有验证 `toolCallId` 配对。那些字段目前由 TypeScript 检查其
形状，并在第 04 至 07 章的模型、Provider、工具和循环测试中逐步进入运行路径。
:::

:::pi title="与当前上游 Pi 对照"
固定提交 `8479bd8` 的 `packages/ai/src/types.ts` 也使用 user、assistant、toolResult
三种消息、content blocks、五种 `StopReason` 和 Context。上游还支持图片、thinking、
签名、缓存和成本等字段。课程保留 README 往返需要的最小形状，让每个字段都能在后续
调用链中找到用途。
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
“先读取\n再回答”。恢复只提取 text block 的实现，并重新确认 2 项聚焦测试通过。
:::

## 本章验收

:::checkpoint title="Checkpoint 03 · transcript 有了稳定形状"
运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/03-*.test.js
```

结果应为 `2/2`。再沿 README transcript 检查五个位置：

1. 用户请求保存在哪一种 message 中？
2. assistant 的文字与 tool call 怎样保持原顺序？
3. `id: "call_1"` 与 `toolCallId: "call_1"` 怎样配对？
4. `stopReason: "toolUse"` 要求 Agent 接下来做什么？
5. `textOf()` 省略了哪些信息，原信息还保存在何处？

`npm run checkpoint -w @pi/course -- 03` 可以重新定位 parent 与 target；
`npm run practice -w @pi/course -- 03 <新目录>` 会从同一 parent 创建新的隔离练习目录。
第 04 章会让 `ScriptedModel` 按这套消息协议播放两次确定的模型调用。
:::

## 小结

README 往返现在保存为三条有顺序的消息。user 记录请求，assistant 依次记录说明和工具
调用，toolResult 使用同一个调用 id 记录环境返回。`StopReason` 说明模型为何停下，
`AgentContext` 把这段 transcript 交给下一次调用，`textOf()` 则从完整消息中取出文本
视图。

`AssistantMessageEventStream` 把生成过程中的 `ModelEvent` 与最终
`AssistantMessage` 接到第 02 章的同一个流上。下一章会在不接网络的情况下，让同一个
`ScriptedModel` 连续接收两次 context，并播放两个确定的模型 turn；真正把 tool result
送进第二次调用的循环留到第 07 章。
