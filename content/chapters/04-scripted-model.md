---
id: "04"
slug: scripted-model
part: foundations
partTitle: 第一部 · 建立可执行语言
chapter: "04"
title: ScriptedModel：同一个实例怎样依次播放两个回合
summary: 跟踪同一个 ScriptedModel 的两次调用，看清请求快照、cursor、microtask 和消息到事件的投影。
minutes: 100
difficulty: 核心
artifact: packages/pi-course/src/scripted-model.ts
prerequisites: 02,03
terms: test double, executable specification, deterministic trace, recorded request
upstream: packages/ai/src/providers/faux.ts
---

## 两次调用，各自拿到哪一轮

第 02 章的 `EventStream<T, R>` 已经能运送事件并返回结果；第 03 章又定义了
`AssistantMessageEventStream` 和 `AssistantMessage`。现在还差一个对象把最终消息
一件件放进流里。

下面这个 `model` 预先装了两个 turn。turn 是“一次模型调用准备播放的最终结果”。同一个
`model` 连续接收两个 context，第一次调用应播放 `turns[0]`，第二次调用应播放
`turns[1]`。

```ts
const model = new ScriptedModel([
  assistantMessage([text("先看")]),
  assistantMessage([text("第二轮")]),
]);

const firstContext = { messages: [userMessage("请求一")] };
const firstStream = model.stream(firstContext);
firstContext.messages.push(userMessage("事后追加"));

const firstTypes: string[] = [];
for await (const event of firstStream) firstTypes.push(event.type);

const secondStream = model.stream({ messages: [userMessage("请求二")] });
const secondTypes: string[] = [];
for await (const event of secondStream) secondTypes.push(event.type);

console.log(firstTypes.join(" → "));
console.log(textOf(await firstStream.result()));
console.log(secondTypes.join(" → "));
console.log(textOf(await secondStream.result()));
console.log(model.requests.length);
console.log(model.requests[0]?.messages.length);
```

```text
start → text_delta → done
先看
start → text_delta → done
第二轮
2
1
```

最后两个数字值得停一下。`requests` 保存了两次调用，所以长度是 `2`。第一次调用之后，
原来的 `firstContext` 被追加了一条消息；保存下来的第一份请求仍然只有一条消息。

这里暂时用两个纯文本 turn，把 cursor、请求快照和事件时序单独看清。后面会把第一轮
换回第 03 章熟悉的 `read("README.md")` tool call。`ScriptedModel` 只按调用次数
播放脚本，不会替 Agent 追加 tool result；真正的两轮工具往返要到第 07 章才接起来。

:::predict title="如果 requests 保存原对象"
把实现中的 `structuredClone(context)` 改成 `context`。`stream()` 返回以后，调用者向
`firstContext.messages` 追加“事后追加”。此时 `model.requests[0].messages.length`
会是 `1` 还是 `2`？
---answer
会是 `2`。数组里保存的是同一个 context 对象的引用，后续修改会从两个入口同时看到。
`structuredClone(context)` 创建独立快照，才会保留调用发生时的输入。
:::

## cursor 只是一个数组下标

先把模型和事件流放在一边。按顺序取两个 turn，只需要一个数组和一个数字：

```ts
const turns = ["先看", "第二轮"];
let cursor = 0;

console.log(turns[cursor++]);
console.log(turns[cursor++]);
console.log(cursor);
console.log(turns[cursor++]);
```

```text
先看
第二轮
2
undefined
```

`cursor++` 会先用当前值取数组元素，再把 cursor 加一。因此第一次取下标 `0`，第二次取
下标 `1`。第三次访问下标 `2`，数组里已经没有元素。`ScriptedModel` 把这个
`undefined` 解释为“脚本耗尽”，而不是凭空重复上一轮。

## 引用和快照记录的是两个时间点

普通赋值只增加一个访问同一对象的名字。`structuredClone` 创建一份独立数据：

```ts
const context = { messages: [userMessage("请求一")] };
const direct = context;
const snapshot = structuredClone(context);

context.messages.push(userMessage("事后追加"));

console.log(direct.messages.length);
console.log(snapshot.messages.length);
```

```text
2
1
```

`direct` 回答“这个对象现在是什么样”。`snapshot` 回答“调用发生时，模型看到了什么”。
`ScriptedModel.requests` 是测试探针，需要回答第二个问题，所以保存 snapshot。

## microtask 把返回和生产分成两个时刻

再看一个不含模型代码的最小顺序：

```ts
console.log("1. 调用函数");

queueMicrotask(() => {
  console.log("3. 生产事件");
});

console.log("2. 函数已经返回");
```

```text
1. 调用函数
2. 函数已经返回
3. 生产事件
```

`queueMicrotask` 没有立刻执行回调。当前同步代码走完后，JavaScript 才运行回调。
`ScriptedModel.stream()` 利用这个顺序，先把 `AssistantMessageEventStream` 交给调用者，
随后向这个流写入事件。

这里有两条时间线，不能混在一起：

```text
同步阶段：创建 stream → 保存 context 快照 → 用 cursor 取 turn → 返回 stream
microtask：检查取消/耗尽 → 投影 content block → 写入 done 或 error
```

cursor 在同步阶段已经选定当前 turn。microtask 负责播放选中的 turn，不负责决定这是第
几轮。

## ScriptedTurn 保存最终结果

第 03 章已经定义了 `Model` 的唯一入口。本章实现它，不另建一套测试接口：

```ts
export interface Model {
  stream(
    context: AgentContext,
    options?: { signal?: AbortSignal },
  ): ModelStream;
}

export interface ModelStream extends AsyncIterable<ModelEvent> {
  result(): Promise<AssistantMessage>;
}
```

正常 turn 直接使用 `AssistantMessage`。显式失败 turn 只写停止原因、诊断和已经生成的
部分文本：

```ts
export type ScriptedTurn =
  | AssistantMessage
  | {
      stopReason: "error" | "aborted";
      errorMessage: string;
      partialText?: string;
    };
```

`ScriptedTurn` 没有预存 `ModelEvent[]`。一条最终消息可能含多个 content block；
`ScriptedModel` 要按第 03 章的协议把这些 block 投影成 `start`、delta、end 和终态。
同一份最终消息因而同时决定事件轨迹和 `result()`。

这类专门替代外部模型、又遵守真实接口的对象叫 test double。脚本把输入对应的行为
固定下来，因此也是 executable specification：测试运行的不是一句自然语言描述，而是
一条能被代码消费的确定轨迹。

## `stream()` 的同步部分

类的外框把刚才三个小例子放到一起：

```ts
export class ScriptedModel implements Model {
  readonly requests: AgentContext[] = [];
  private cursor = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  stream(
    context: AgentContext,
    options: { signal?: AbortSignal } = {},
  ): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();
    this.requests.push(structuredClone(context));
    const turn = this.turns[this.cursor++];

    queueMicrotask(() => {
      // 在这里把 turn 投影成事件。
    });

    return stream;
  }
}
```

调用者拿到的是刚创建的 `stream`。`requests` 里增加的是 context 快照。局部变量
`turn` 固定了这一轮要播放的值，cursor 则已经指向下一轮。microtask 稍后闭包读取的
仍是这个局部变量。

## 纯文本消息怎样进入流

先只看 `assistantMessage([text("先看")])`。最终消息已经含有完整文本，但消费者需要
按流协议依次观察三个状态：

```text
start
  partial.content = []

text_delta
  contentIndex = 0
  delta = "先看"
  partial.content = [text("先看")]

done
  reason = "stop"
  message.content = [text("先看")]
```

`partialFrom(message)` 克隆最终消息，然后把 `content` 清空，并把播放中的
`stopReason` 设为 `"stop"`。这个空 partial 随 `start` 发出。遇到 text block 时，
实现先把 block 加进 partial，再推送 `text_delta`；所以事件携带的 partial 已经包含
本次 delta。

最后一个 `done` 携带脚本原先给出的完整消息。`AssistantMessageEventStream` 看到
`done` 后，让 `result()` resolve 这条消息；调用者不需要再从若干 delta 重建一次结果。
此时流已经进入终态。target 随后调用的 `end(message)` 不负责生成 `done`，也不是
`result()` 完成的前提；它只执行幂等关闭，并唤醒仍在等待结束信号的消费者。

:::rebuild title="Checkpoint 04 · 让两个脚本回合走真实模型边界"
**模式：** 重建。从 03 的 target 开始，只加入确定性事件生产者。

**起终点：** parent 是本章开始时的起点快照；target 是聚焦测试通过的终点快照。

**教学文件：** `packages/pi-course/src/scripted-model.ts`

**动手前只需知道：** `turns[cursor++]` 选中本轮结果，`structuredClone(context)` 保存
调用时的输入，`queueMicrotask` 让事件生产发生在 stream 返回之后。

**第一次红灯：** 首次 build 只报告 TS2307：找不到
`../src/scripted-model.js`。第 03 章的消息和事件流仍然可用，当前只缺这个源文件。

**第一步：** 先不看 target diff。运行 build 确认 TS2307，再声明 `ScriptedTurn`、
`requests`、`cursor` 和 `stream()` 外框。完成实践 4.1 后只跑第一项测试；完成实践
4.2 后再跑全部三项。

**聚焦测试：** `packages/pi-course/test/04-scripted-model.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 04`

**练习目录：** `npm run practice -w @pi/course -- 04`

**聚焦运行：** `npm run build -w @pi/course`，然后
`node --test packages/pi-course/dist/test/04-*.test.js`

**通过证据：** 3 项聚焦测试覆盖事件顺序与载荷、累计 partial、两个 turn 的消费
顺序、请求快照、显式错误回合、脚本耗尽和预取消。target 只增加
`packages/pi-course/src/scripted-model.ts`。
:::

## 第一轮再加一个 tool call

纯文本路径清楚以后，把开头 `model` 的第一轮扩成测试里的真实值：

```ts
const firstTurn = assistantMessage([
  text("先看"),
  {
    type: "toolCall",
    id: "c1",
    name: "read",
    arguments: { path: "README.md" },
  },
], "toolUse");

const secondTurn = assistantMessage([text("第二轮")]);
const model = new ScriptedModel([firstTurn, secondTurn]);
```

第一次 context 仍然只取 `firstTurn`，第二次 context 仍然只取 `secondTurn`。变化只发生在
第一轮的 content：下标 `0` 是 text，下标 `1` 是 tool call。

第一轮完整事件如下：

```text
start
text_delta      contentIndex=0  delta="先看"
toolcall_delta  contentIndex=1  delta='{"path":"README.md"}'
toolcall_end    contentIndex=1
done            reason="toolUse"
```

模型生成工具参数时，真实 provider 往往先给字符串片段。课程实现一次发出完整的
`rawArguments`，但仍保留 delta 形状：

```ts
{
  type: "toolCall",
  id: "c1",
  name: "read",
  arguments: {},
  rawArguments: '{"path":"README.md"}',
}
```

这是 `toolcall_delta.partial.content[1]` 的值。空对象表示结构化参数还没有结束，
`rawArguments` 保存当前收到的 JSON 文本。紧接着的 `toolcall_end` 用完整 tool call
替换同一位置：

```ts
{
  type: "toolCall",
  id: "c1",
  name: "read",
  arguments: { path: "README.md" },
}
```

两个事件的 `contentIndex` 都是 `1`。它们的 partial 也都保留下标 `0` 的
`text("先看")`。因此 partial 表示“播放到当前事件以后，已经形成的消息”，而不是只放
当前 block。

:::lab title="实践 4.1 · 播放两个正常 turn 并保存请求快照"
**目标：** 让第一轮的 text 与 tool call 形成完整事件轨迹，让第二轮由同一个实例继续
播放，并固定两次调用时的 context。

**文件：** `packages/pi-course/src/scripted-model.ts`

**动作：**
1. 声明完整 `ScriptedTurn`，加入 `requests`、`cursor` 和构造器。
2. `stream()` 同步创建流、克隆 context、取得 `turns[cursor++]`，然后返回流。
3. 在 microtask 中为正常消息创建空 content 的 partial，并推送 `start`。
4. text block 先更新 partial，再推送一个 `text_delta`。
5. tool call 先推送含 raw JSON 的 `toolcall_delta`，再用完整 tool call 推送
   `toolcall_end`。
6. 正常消息最后推送 `done`，并让流以同一条最终消息结束。
7. 为了让整个测试文件能编译，先声明错误 turn 的完整联合；预取消、耗尽和显式错误
   分支可暂时抛出清楚的 `"not implemented in lab 4.1"`。
8. 只运行名称含“脚本消息”的测试。

**运行：** `npm run build -w @pi/course`，然后
`node --test --test-name-pattern="脚本消息" packages/pi-course/dist/test/04-*.test.js`

**预期：** 局部测试 `1/1`。第一轮事件类型是
`start → text_delta → toolcall_delta → toolcall_end → done`；第二次调用得到“第二轮”；
第一次调用后修改原 context，不会改变 `requests[0]`。
:::

## 三种失败仍然结束同一个流

成功路径已经说明了 cursor、快照和事件投影。失败路径复用同一个
`AssistantMessageEventStream`，但终态从 `done` 变成 `error`。

显式错误 turn 可以保留已经生成的文本：

```ts
{
  stopReason: "error",
  partialText: "正在",
  errorMessage: "rate limited",
}
```

helper 先把它转换成 canonical `AssistantMessage`：content 含 `text("正在")`，
`stopReason` 是 `"error"`，`errorMessage` 是 `"rate limited"`。随后它走普通 content
投影，所以消费者看到：

```text
start
text_delta  delta="正在"
error       reason="error"

result.stopReason = "error"
result.errorMessage = "rate limited"
```

`error` 既是事件，也是终态。`result()` resolve 这条错误消息，不会 reject；上层可以从
同一个结果同时读取 partial text 与诊断。

另外两种失败发生在 content 播放之前：

```text
turn 不存在       → error(reason="error", errorMessage="ScriptedModel 没有更多响应")
signal 已预取消   → error(reason="aborted", errorMessage="Request was aborted")
```

这两种流只有一个 `error` 事件，没有 `start`。检查发生在 microtask 内，因此
`stream()` 已经把流返回给调用者。当前实现会在同步阶段先保存请求并执行
`turns[cursor++]`，然后才在 microtask 检查预取消；所以预取消调用也会记录请求并消费
一个 turn。这是当前代码的具体顺序，不应把它概括成所有 provider 的通用规则。

:::lab title="实践 4.2 · 补齐错误、耗尽和预取消"
**目标：** 让三类失败都通过流内 `error` 终态完成。

**文件：** `packages/pi-course/src/scripted-model.ts`

**动作：**
1. 写 `terminalMessage()`：正常 turn 返回深拷贝；错误 turn 转成带 partial text 与
   `errorMessage` 的 `AssistantMessage`。
2. 删除实践 4.1 的临时异常。
3. signal 已经 aborted 时，推送 `reason: "aborted"` 的 `error`，再结束流。
4. turn 不存在时，推送诊断为 `"ScriptedModel 没有更多响应"` 的 `error`，再结束流。
5. 显式错误 turn 先投影已有 content，最后推送 `reason: "error"` 的终态。
6. 运行全部聚焦测试。

**运行：** `npm run build -w @pi/course`，然后
`node --test packages/pi-course/dist/test/04-*.test.js`

**预期：** `3/3`。显式错误保留“正在”；耗尽和预取消都只产生一个 `error`。每项测试
设有一秒超时，漏掉终态时会直接暴露未完成的流。
:::

:::mechanism title="固定模型行为，才能单独观察控制流"
以后测试 Agent loop 时，可以让第一轮稳定请求 `read`，第二轮稳定回答“第二轮”。模型
输出不再随网络和采样变化，测试失败时就能集中检查 loop 怎样追加消息、执行工具和发起
下一次调用。真实模型用于验证接入兼容性；`ScriptedModel` 用于给控制流提供可重复证据。
:::

:::failure title="预期失败 · 脚本耗尽时同步 throw"
临时把 turn 不存在的判断移到 `queueMicrotask()` 外，并执行
`throw new Error("script exhausted")`。运行全部聚焦测试。第三项会在调用者拿到流之前
失败，也就无法观察预期的 `error` 事件和 `result()`。把判断放回 microtask，恢复流内
`error`，再确认 `3/3`。
:::

:::note title="三项测试的边界"
本章没有测试播放中途取消、多个并发 `stream()` 调用、事件之间的实际时间间隔、调度时机
或背压。测试也没有断言预取消是否消费 cursor。`requests` 只是短期测试探针，不是
生产日志；长期进程不应让它无限增长，也不应向它写入密钥。下一章会验证真实 transport
的中途取消。
:::

:::pi title="与当前上游 Pi 对照"
固定提交 `8479bd8` 的 `packages/ai/src/providers/faux.ts` 提供更丰富的确定性 provider，
可以生成内容、usage、错误和取消事件。课程版把范围缩到两个对象：按 cursor 消费的
`ScriptedTurn[]`，以及按调用保存的 `requests[]`。两者都遵守真实 provider 使用的流
协议，因此上层消费者不需要 `if (model is fake)` 分支。
:::

## Checkpoint 04 验收

:::checkpoint title="Checkpoint 04 · 两次调用形成可执行轨迹"
运行 `npm run build -w @pi/course`，再运行
`node --test packages/pi-course/dist/test/04-*.test.js`，结果应为 `3/3`。确认本章相对
parent 只增加 `packages/pi-course/src/scripted-model.ts`。

你应能沿同一个实例说清这条链：第一次 context 被克隆进 `requests[0]`，cursor 取
`turns[0]`；第二次 context 被克隆进 `requests[1]`，cursor 取 `turns[1]`；每次调用先
返回 stream，microtask 再把选中的最终消息投影成事件。正常消息以 `done` 结束，显式
错误、脚本耗尽和预取消以 `error` 结束。
:::

## 可选迁移练习

:::transfer title="迁移 · 两个 text block 的 contentIndex"
在独立测试中创建一个 turn，content 依次为 `text("A")`、`text("B")`。收集事件并验证
两个 `text_delta` 的 `contentIndex` 分别为 `0`、`1`；第二个 delta 的 partial 同时包含
`A` 和 `B`；`result()` 的文本为两行 `A`、`B`。这个练习检验的是“partial 累计到当前
位置”，不要读取私有 cursor，也不要修改事件协议。
:::

## 小结

`ScriptedModel` 的核心对象没有很多：`turns[]` 保存未来结果，cursor 指向下一轮，
`requests[]` 保存调用时的输入快照，`AssistantMessageEventStream` 接收 microtask 产生
的事件。两次 `stream()` 调用把 cursor 从 `0` 推到 `2`，同时留下两份互不受后续修改
影响的 context。

一条纯文本消息先形成 `start → text_delta → done`。加入 tool call 后，中间多出
`toolcall_delta → toolcall_end`。加入错误后，终态改为 `error`。下一章保留这些模型
事件，只把 turn 的来源从内存脚本换成 OpenAI-compatible transport。
