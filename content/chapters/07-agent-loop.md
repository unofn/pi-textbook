---
id: "07"
slug: agent-loop
part: core
partTitle: 第二部 · 闭合 Agent 核心
chapter: "07"
title: Agent Loop：一次 README 往返怎样调用模型两次
summary: 跟随同一条 read 调用，看模型消息、工具结果和最终回答怎样依次进入 transcript。
minutes: 210
difficulty: 核心
artifact: packages/pi-course/src/agent-loop.ts
prerequisites: 04,06
terms: agent loop, transcript, stop reason, tool result, terminal state
upstream: packages/agent/src/agent-loop.ts
---

## 一次请求为什么需要两次模型调用

用户提出一个需要环境事实的问题：

```text
请读取 README.md，并告诉我项目名。
```

模型第一次还不知道文件内容。它先返回一条 `toolUse` 消息，请求调用 `read`：

```ts
const readCall: ToolCall = {
  type: "toolCall",
  id: "call-1",
  name: "read",
  arguments: { path: "README.md" },
};

const firstAnswer = assistantMessage([
  text("我先读取项目说明。"),
  readCall,
], "toolUse");
```

工具随后返回 README 内容：

```ts
const readResult: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  content: [text("# tiny-pi\nA small agent runtime.")],
  isError: false,
  timestamp: 3,
};
```

`readResult.toolCallId` 与 `readCall.id` 都是 `call-1`。第二次模型调用看到这个配对结果，
才返回最终回答：

```ts
const finalAnswer = assistantMessage([
  text("项目名是 tiny-pi。"),
], "stop");
```

这次运行结束时，消息列表按发生顺序保存四条事实：

```text
user          请读取 README.md，并告诉我项目名。
assistant     我先读取项目说明。 + read(call-1, README.md)
toolResult    call-1 → # tiny-pi ...
assistant     项目名是 tiny-pi。
```

这份有顺序的消息列表就是本次运行的 transcript。它不只保存最终一句话，也保存模型为何
需要工具、环境返回了什么，以及最终回答依据哪项事实形成。

把这四条消息连起来的控制器叫 Agent Loop。它发起第一次 `model.stream()`，执行
`call-1`，把结果追加进消息列表，然后用更新后的列表发起第二次 `model.stream()`。

```text
request 1: [user]
    ↓ model.stream()
assistant(toolUse, call-1)
    ↓ read(README.md)
toolResult(call-1, "# tiny-pi ...")
    ↓ append to messages
request 2: [user, assistant, toolResult]
    ↓ model.stream()
assistant(stop, "项目名是 tiny-pi。")
```

正文假设调用者已经注册了一个返回固定 README 内容的内存 `read`。它让控制顺序可以
离线复现，并不读取真实文件；Checkpoint 07 本身只实现 loop，聚焦测试用 `probe`
观察同一条执行路径。第 08 章才会实现访问 workspace 的 read 工具。

:::rebuild title="Checkpoint 07 · 闭合一次 README 工具往返"
**模式：** 重建。

**起终点：** `parent` 是第 06 章完成后的起点；`target` 是 9 项聚焦测试通过的终点。

**教学文件：** `packages/pi-course/src/agent-loop.ts`

**学习脚手架：** practice 目录已经声明 `LoopEvent`、`AgentRunResult`、
`AgentLoopOptions` 和 `runAgentLoop()` 的公共表面。五段 Lab 对应的分支算法仍留给读者
实现。

**动手前只需知道：** 一轮模型调用会追加一条完整 assistant；只有
`toolUse + calls` 会进入 executor，配对结果写回 messages 后，loop 才能请求下一轮。

**第一次红灯：** starter 可以通过 build。运行“纯文本 stop”测试后，第一条运行时错误
是 `Lab 7.1 收集模型终态 尚未实现`。

**第一步：** 先不看 target diff。完成一轮纯文本模型请求，再加入单次工具往返；正常
路径通过以后，继续实现非执行终态、并发和控制器边界。

**聚焦测试：** `packages/pi-course/test/07-agent-loop.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 07`

**练习目录：** `npm run practice -w @pi/course -- 07`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/07-*.test.js`

**通过证据：** 9 项测试观察输入所有权、两次模型请求、单工具回填、非执行终态、并发
顺序、注入 executor 的 rejection、预取消、工具后的取消与回合上限。
:::

## 第一次 model.stream() 追加 assistant 消息

`runAgentLoop()` 收到的 `context.messages` 属于调用者。运行开始时，它创建一份深拷贝：

```ts
const messages = structuredClone(options.context.messages);
```

假设输入只有开头那条 user message，此时有两个独立数组：

```text
options.context.messages  [user]
messages                  [user]
```

后续 assistant 和 tool result 只进入局部 `messages`。调用结束后，调用者传入的数组仍然
只有原来的 user message。

第一次请求使用这份局部消息，同时带上 system prompt 和本次 Registry 生成的工具定义：

```ts
const stream = options.model.stream(
  {
    systemPrompt: options.context.systemPrompt,
    messages,
    tools: options.tools.definitions(),
  },
  { signal: options.signal },
);
```

`context.tools` 中可能有旧值，loop 不会转发它。当前请求允许模型调用什么，以
`options.tools.definitions()` 为准；同一个 Registry 也会在本地找到真正的执行函数。

模型流中的事件先交给观察者，最终消息再从 `result()` 取得：

```ts
for await (const event of stream) {
  emit(options, { type: "model_event", event });
}
const assistant = await stream.result();
messages.push(assistant);
emit(options, { type: "assistant_message", message: assistant });
```

第一轮使用开头的 `firstAnswer` 时，`ScriptedModel` 产生的模型事件依次是：

```text
start
text_delta       "我先读取项目说明。"
toolcall_delta   '{"path":"README.md"}'
toolcall_end     call-1
done             toolUse
```

loop 把每一项包成 `model_event` 发出。流结束后，它只把完整的 `firstAnswer` 追加一次。
delta 负责显示生成过程，不会成为 transcript 中的独立消息。

### 没有工具的 stop 直接结束

先把模型脚本简化成一条纯文本 `stop`。局部消息从 `[user]` 变成
`[user, assistant]`，模型调用次数和 `steps` 都是 `1`。loop 随后发出
`turn_end(reason="stop")`，并返回：

```ts
{
  reason: "stop",
  messages: [user, assistant],
  steps: 1,
}
```

`turn_end` 是整次运行的结束事件。模型自己的 `done` 仍包在 `model_event` 中；两者所属
层级不同。

:::lab title="实践 7.1 · 完成纯文本 stop"
**目标：** 收集一轮模型流，保存唯一的最终 assistant，同时保持输入 context 不变。

**文件：** `packages/pi-course/src/agent-loop.ts`

**动作：**
1. 完成 `collectModelTurn()`：构造完整模型请求，转发事件，再读取 `stream.result()`。
2. 把最终 assistant 追加到局部 messages，并发出 `assistant_message`。
3. 为 `stop + no calls` 返回 `reason: "stop"`、当前 messages 与 steps。
4. 用一个 `finish()` 位置发出 `turn_end`，避免不同分支重复结束。
5. 删除 Lab 7.1 的两个临时错误，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="纯文本 stop" \
  packages/pi-course/dist/test/07-*.test.js
```

**预期：** `1/1`。测试确认 context 不修改；模型请求包含 `systemPrompt`、局部 messages
和 Registry 的 tool definitions；运行只发出一个 `turn_end`。
:::

## call-1 的结果进入第二次模型请求

第一轮的 `stopReason` 是 `toolUse`。loop 从 assistant content 中取出所有工具调用：

```ts
const calls = assistant.content.filter(
  (block): block is ToolCall => block.type === "toolCall",
);
```

当前数组只有 `readCall`。loop 先发出 `tool_start`，再把 call、signal 和进度回调交给
executor：

```ts
const result = await executeToolCall(readCall, {
  signal: options.signal,
  reportProgress: (content) => {
    emit(options, {
      type: "tool_progress",
      callId: readCall.id,
      content,
    });
  },
});
emit(options, { type: "tool_end", result });
```

内存 `read` 返回开头的 `readResult`。如果工具报告进度，loop 会补上
`callId: "call-1"`；UI 因而能把进度放到正确的工具项下。工具结束后，`tool_end` 携带
完整结果。

执行结果随后进入局部 messages：

```text
追加前  [user, assistant(call-1)]
追加后  [user, assistant(call-1), toolResult(call-1)]
```

循环继续，第二次 `model.stream()` 读取追加后的三条消息。它还会再次收到同一个
system prompt 和 Registry definitions。模型现在能从 README 内容得出项目名，于是
返回 `finalAnswer`。

第二轮结束后，运行结果可以直接观察到：

```text
model requests  2
tool executions 1
steps           2
reason          stop
roles           user → assistant → toolResult → assistant
```

这条 `user → assistant → toolResult → assistant` 就是完整反馈回路。第一次 assistant
提出动作，tool result 补入环境事实，第二次 assistant 才完成回答。

:::lab title="实践 7.2 · 闭合单工具往返"
**目标：** 执行一个 tool call，把配对结果放进第二次模型请求，最后以纯文本 stop 结束。

**文件：** `packages/pi-course/src/agent-loop.ts`

**动作：**
1. 从最终 assistant 中提取 calls，只让 `toolUse + calls` 进入执行阶段。
2. 为 call 发出 `tool_start`，把 signal 与绑定 call id 的 progress callback 交给
   executor。
3. executor 返回后发出 `tool_end`，再把 result 追加到 messages。
4. 继续循环，让第二次模型请求看到 user、assistant 与 toolResult。
5. 删除 Lab 7.2 的临时错误，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="单工具往返" \
  packages/pi-course/dist/test/07-*.test.js
```

**预期：** `1/1`。聚焦测试用 `probe` 代替内存 `read`，从而额外观察 signal 和 progress；
控制顺序相同。第二次请求的 roles 是 `user → assistant → toolResult`，最终 transcript
再增加一条 assistant。
:::

## LoopEvent 展示过程，messages 保存事实

README 往返会发出两组模型事件和一组工具事件：

```text
model_event(start)
model_event(text_delta)
model_event(toolcall_delta)
model_event(toolcall_end)
model_event(done: toolUse)
assistant_message(toolUse)
tool_start(call-1)
tool_end(call-1)
model_event(start)
model_event(text_delta)
model_event(done: stop)
assistant_message(stop)
turn_end(stop)
```

这些值统称 `LoopEvent`。`model_event` 保留模型生成过程；`tool_start`、
`tool_progress` 与 `tool_end` 让调用者显示工具状态；`assistant_message` 表示完整模型消息
已经进入 transcript；`turn_end` 只出现一次。

最终 `messages` 只有四条 canonical message。事件数量可以更多，因为同一条消息会经历
多个可观察阶段。恢复会话时使用 messages；实时 UI 和诊断使用 events。

## `length`：工具不启动，调用仍然闭合

继续使用开头的 `readCall`。假设第一轮 assistant 已经给出 `read(call-1)`，但
`stopReason` 是 `length`。这表示模型输出因长度上限而结束，工具参数可能还不完整。loop
先保存这条 assistant，再进入非执行分支。把事件、执行次数和返回值串起来，完整时间线是：

```text
assistant_message(length, read(call-1))
executor 调用次数          0
messages 追加              toolResult(call-1, skipped: true, reason: length)
tool_skipped               toolResult(call-1)
finish("length", 1)        → turn_end(length), steps: 1
```

其中 executor 调用次数是观察值，不是一种 `LoopEvent`。实际事件顺序是
`assistant_message → tool_skipped → turn_end`，整个过程没有 `tool_start` 或 `tool_end`。
追加到消息列表的工具结果是：

```ts
{
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  content: [text(
    "Tool call was not executed because the model response was truncated.",
  )],
  details: { skipped: true, reason: "length" },
  isError: true,
}
```

这里的 `toolCallId` 与 `readCall.id` 都是 `call-1`。它表达的不是工具输出，而是“这个调用
已经被 loop 接收，但因 `length` 没有启动”。因此 transcript 仍满足同一个配对不变量：

> 一条 assistant 进入 transcript 后，只要其中已经出现工具调用，loop 就会在结束或再次
> 请求模型前，为每个调用写入具有相同 `toolCallId` 的工具结果。结果可以来自真实执行，
> 也可以明确记录未执行的原因。

`length` 的具体路径看清以后，其余组合只是在“是否启动 executor、怎样配对、是否继续”
三个位置取不同值：

| assistant 的结束原因与内容 | executor | 写入消息列表 | 下一步 |
|---|---:|---|---|
| `toolUse` + 至少一个工具调用 | 每个调用执行一次 | 对应的执行结果 | 请求下一轮模型 |
| `stop` + 没有工具调用 | 0 次 | 无 | `finish("stop", steps)` |
| `length/error/aborted` + 任意数量的工具调用 | 0 次 | 为每个已有调用写入 skipped 工具结果 | `finish(reason, steps)` |
| `stop` + 至少一个工具调用 | 0 次 | 为每个调用写入 `unexpected-stop` 工具结果 | `finish("error", steps)` |
| `toolUse` + 没有工具调用 | 0 次 | 无 | `finish("error", steps)` |

`error`、`aborted` 和内容中带工具调用的 `stop` 都复用与 `length` 相同的 skipped 结果结构，
只改变原因和说明文字；每条 skipped 工具结果都会伴随一个 `tool_skipped` 事件。表中最后
两行没有形成可继续执行的完整工具批次，因此 loop 以 `error` 结束。

:::lab title="实践 7.3 · 处理所有非执行终态"
**目标：** 不启动 executor，同时让已经出现的每个工具调用都得到配对结果。

**文件：** `packages/pi-course/src/agent-loop.ts`

**动作：**
1. 实现 `skippedCall()`，保留工具调用的 `id` 与 `name`，并记录未执行的原因。
2. `length`、`error`、`aborted` 中的每个工具调用都追加 skipped 工具结果。
3. `stop` 中出现工具调用时，追加 `unexpected-stop` 工具结果，并以 `error` 结束。
4. `toolUse` 中没有工具调用时，直接以 `error` 结束。
5. 所有分支都通过 `finish()` 发出唯一 `turn_end`。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="非执行终态" \
  packages/pi-course/dist/test/07-*.test.js
```

**预期：** `2/2`。测试比较 executor 调用次数、每个工具调用的配对结果、终止 reason、
`tool_skipped` 和唯一 `turn_end`。
:::

## 多个工具同时运行，结果仍按工具调用顺序追加

一条 assistant 消息可以依次声明 `slow` 与 `fast` 两个工具调用。loop 会先为两者发出
`tool_start`，再用 `Promise.all()` 同时等待两个 executor Promise：

```ts
const results = await Promise.all(
  calls.map(async (call) => {
    const result = await executeOne(call);
    emit(options, { type: "tool_end", result });
    return result;
  }),
);
```

`fast` 可以先完成，所以 `tool_end` 反映实际完成顺序：

```text
tool_end(fast-call) → tool_end(slow-call)
```

`Promise.all()` 返回的数组仍按输入 Promise 排列。整批结束后，loop 按这个数组的顺序
写入消息列表：

```text
toolResult(slow-call) → toolResult(fast-call)
```

完成事件服务实时观察，transcript 顺序服务下一次模型请求。后者保持 assistant content
中原有的工具调用顺序，模型就能稳定重放同一批动作。

注入的 executor 可能 reject。每个工具调用对应的异步函数分别用 `try/catch` 把 rejection
转换成具有相同 `toolCallId` 和 `toolName` 的错误结果；其中一项失败不会让同批其他
Promise 提前丢失。错误结果保留 `error.message`，不写入 stack。

:::lab title="实践 7.4 · 隔离并发完成与单项失败"
**目标：** 让事件反映完成顺序，让 transcript 保持声明顺序，并为每个工具调用留下结果。

**文件：** `packages/pi-course/src/agent-loop.ts`

**动作：**
1. 为整批工具调用发出 `tool_start`，再同时启动执行。
2. 每个调用完成时立即发出自己的 `tool_end`。
3. 单独捕获每个 executor rejection，用 `failedExecution()` 生成配对结果。
4. 等整批完成后，按 `Promise.all()` 的结果顺序写入消息列表。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="并发工具" \
  packages/pi-course/dist/test/07-*.test.js
```

**预期：** `2/2`。可控 gate 让 fast 先结束、slow 后结束，transcript 仍按 slow、fast
排列；另一个测试让 injected executor reject，并确认同批正常结果仍被保留。
:::

## 取消与 maxSteps 阻止新的模型请求

loop 只用 `steps` 表示当前循环轮次。每次进入循环头部时，它也是即将发起的模型请求
序号，并且从 `1` 开始。因此请求开始前有一个稳定关系：已经完成的模型请求数是
`steps - 1`。

```ts
for (let steps = 1; steps <= maxSteps; steps += 1) {
  // 第 steps 次请求尚未发起；此前已经完成 steps - 1 次模型请求。
  if (options.signal?.aborted) {
    return finish("aborted", steps - 1);
  }

  // 从这里发起并收集第 steps 次 model.stream()。
  // 当前请求完成以后，本轮终态返回的计数就是 steps。
  // ...
}
```

运行开始前已经取消时，循环刚进入 `steps = 1`，此前完成的请求数自然是 `1 - 1 = 0`，
所以返回 `steps: 0`。输入 user message 仍留在结果中。

第二个检查点位于一批工具全部结束、结果已经追加之后。若 `read` 执行期间发生取消，
第 `steps` 次模型请求已经完成，所以这里以当前 `steps` 结束。loop 会等待当前 executor
返回，保留 `readResult`，然后返回 `aborted`；下一次 `model.stream()` 不会开始。如果继续
进入下一轮，`steps` 会加一，循环头的 `steps - 1` 又正好等于已经完成的请求数。

这两个检查点只阻止新工作启动。signal 已经交给 provider 与工具，但它们需要主动观察
signal 才会及时停止；loop 没有提供墙钟超时。

`maxSteps` 限制可以发起的模型请求数，默认上限是 `32`。若设置 `maxSteps: 1`，第一轮
模型仍可提出 `readCall`，工具也会执行并产生 `readResult`。这一轮结束后循环达到上限，
于是返回：

```text
reason          maxSteps
steps           1
model requests  1
messages        user → assistant(call-1) → toolResult(call-1)
```

消息列表停在 `toolResult(call-1)`：生成最终 `stop` assistant 需要第二次模型请求，而这次
请求没有开始。

:::lab title="实践 7.5 · 处理取消与回合上限"
**目标：** 阻止边界之外的新模型请求，同时保留已经形成的消息和工具结果。

**文件：** `packages/pi-course/src/agent-loop.ts`

**动作：**
1. 模型请求前检查 signal；预取消返回 `aborted` 与 `steps: 0`。
2. 工具批次结束并追加结果后，再检查一次 signal。
3. 用 `maxSteps` 限制模型请求次数；最后一批工具结果仍要保留。
4. 让每条返回路径都经过 `finish()`，只发一个 `turn_end`。
5. 先运行本段测试，再运行全部聚焦测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="取消与上限" \
  packages/pi-course/dist/test/07-*.test.js
node --test packages/pi-course/dist/test/07-*.test.js
```

**预期：** 局部测试 `3/3`，完整聚焦测试 `9/9`。三项分别观察预取消、工具后的取消和
`maxSteps`，并比较模型调用数、messages、steps、reason 与唯一 `turn_end`。
:::

:::mechanism title="每次重新请求模型前，call 都已经有结果"
局部 messages 最初是输入 context 的副本。每轮结束后，完整 assistant 只追加一次。
当它提出工具调用时，整批 tool results 会在下一次 `model.stream()` 前按 call 顺序追加。
因此模型不会看到悬空的已执行 call。

非执行终态不会再次请求模型，但其中已经出现的 calls 也会得到 skipped results。
`finish()` 集中产生 `turn_end`，让一次运行只有一个控制器终态。
:::

:::note title="9 项测试覆盖到哪里"
聚焦测试证明 context 不修改、systemPrompt 与 tool definitions 进入请求、单工具执行与
回填、非执行终态的配对、并发的两种顺序、单项 executor rejection、两处取消检查和
`maxSteps`。它没有证明墙钟超时，也没有证明忽略 signal 的 provider 或工具会停止。
测试没有覆盖抛错的 `onEvent` subscriber、重复 call id、executor 返回错误 id、动态工具
注册、模型流向外抛错、重试或进程级资源清理。
:::

:::pi title="与当前上游 Pi 对照"
固定提交 `8479bd8` 的 `packages/agent/src/agent-loop.ts` 同样不会执行 `length` 消息中的
tool calls，并会为它们生成配对错误结果。上游工具可以并发完成；完成事件反映实际顺序，
结果消息再按 assistant 中的声明顺序交给模型。

上游还处理 hooks、steering、follow-up、动态模型切换和更多队列状态。课程在 Chapter 07
只保留 README 往返所需的循环，并加入 `maxSteps` 作为教学保护；这项上限不是上游 Pi
核心的同名保证。
:::

## 完成正常实现后检查 length 分支

把 `length + calls` 临时送入普通 `toolUse` 执行路径。聚焦测试中的两条 calls 都会启动：

```text
正确  executionCount = 0，产生两条 tool_skipped
错误  executionCount = 2，两个工具都已经开始执行
```

:::failure title="诊断 · 截断的调用进入了 executor"
只改变 `length` 的分支选择，运行名称含“非执行终态”的测试。第一处差异出现在 executor
调用次数。恢复 skipped results 后，同一组测试回到 `2/2`。
:::

## 本章验收

:::checkpoint title="Checkpoint 07 · README 反馈回路已经闭合"
运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/07-*.test.js
```

结果应为 `9/9`。再沿开头的四条消息检查：

1. 第一次 `model.stream()` 收到哪些 messages？
2. `assistant(call-1)` 在什么时候追加，为什么只追加一次？
3. `readResult` 在什么时候进入 transcript？
4. 第二次 `model.stream()` 为什么能回答 `tiny-pi`？
5. `model_event(done)` 与 `turn_end(stop)` 分别结束哪一层？
6. `maxSteps: 1` 时，为什么结果停在 toolResult，而没有最终 assistant？

`npm run checkpoint -w @pi/course -- 07` 可以重新定位 parent 与 target；
`npm run practice -w @pi/course -- 07 <新目录>` 会从同一 parent 创建新的隔离练习目录。
第 08 章会把内存 `read` 换成真正访问 workspace 的 read、write、edit 和 bash，
`runAgentLoop()` 的公共接口保持不变。
:::

## 小结

一条 README 请求让同一个 loop 调用模型两次。第一次 assistant 提出 `read(call-1)`；
工具结果使用同一个 id 进入 transcript；第二次模型请求读到这项环境事实，回答项目名是
`tiny-pi`。

`LoopEvent` 展示生成和执行过程，messages 保存可重放事实。正常工具批次按 call 顺序
写回，非执行终态也为已有 calls 生成配对结果。取消与 `maxSteps` 只阻止新的模型请求，
不会删除已经形成的 assistant 或 tool result。
