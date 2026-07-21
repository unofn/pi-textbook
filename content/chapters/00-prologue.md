---
id: "00"
slug: prologue
part: orientation
partTitle: 序章 · 先看见完整系统
chapter: "00"
title: 一次 README 读取请求怎样走完 Agent 闭环
summary: 跟随七个可见里程碑，观察用户消息、模型请求、工具结果和最终回答怎样连成一次完整运行。
minutes: 35
difficulty: 入门
artifact: packages/pi-course/src/demo/prologue.ts
prerequisites:
terms: agent, model, tool call, tool result, transcript
upstream: packages/coding-agent/src/main.ts
---

## 你将看到什么

用户说：“读取 `README.md`，用一句话告诉我这个项目做什么。”这句话进入系统后，模型
不会立刻给出最终回答。它先请求 `read` 工具，等读取结果回来，再根据这项新事实回答
用户。

这一章跟随这次请求经过的七个可见里程碑。我们暂时不实现模型和工具，也不要求你先
理解 TypeScript。读完以后，你应该能说明每个里程碑记录了什么、这条事实来自谁，以及
为什么工具请求和工具结果要使用同一个 `toolCallId`。

```text
用户消息
  → 第一次模型调用
  → 模型提出 read 工具调用
  → 循环开始调度 read
  → read 返回 README 内容
  → 第二次模型调用
  → 模型给出最终回答
```

这条路径有一项始终成立的约束：一旦 assistant message 中出现 tool call，transcript
里最终就要出现一条使用相同 `toolCallId` 的 tool result。请求说明“模型想做什么”，
结果才说明“环境实际返回了什么”。

## 七个里程碑

课程中的离线演示固定产生下面七条记录。`owner` 直接写在每条记录上：

```text
01 user_message       owner=user   detail="读取 README.md，并概括项目"
02 model_start        owner=model  detail="turn=1"
03 assistant_message  owner=model  detail="stopReason=toolUse name=read"
   toolCallId=call_1
04 tool_start         owner=loop   detail="name=read" toolCallId=call_1
05 tool_result        owner=tool   detail="README fixture" toolCallId=call_1
06 model_start        owner=model  detail="turn=2"
07 assistant_message  owner=model  detail="stopReason=stop"
```

### 01 · 用户消息确定本次目标

`user_message` 保存用户给出的目标：“读取 README，并概括项目。”此时系统只有请求，
还没有 README 的内容，也没有最终答案。

### 02 · 第一次模型调用开始

`model_start` 表示模型开始处理当前消息。它是运行过程中的一个可见信号。这里还没有
assistant message，也没有环境动作发生。

### 03 · 模型提出 read 工具调用

第一条 `assistant_message` 的 `stopReason` 是 `toolUse`。模型没有把这轮当作最终回答，
而是在 content 中提出一项请求：调用 `read`，参数是 `{ "path": "README.md" }`。

工具调用的 id 是 `call_1`。这个 id 会跟着请求进入后面的调度和结果，让系统知道哪条
结果回答了哪次调用。到这一步为止，模型只表达了读取意图；它还没有接触文件系统。

### 04 · 循环开始调度 read

`tool_start` 记录循环已经开始处理 `call_1`。模型提出动作，Agent loop 决定执行顺序，
真正的环境访问则属于工具。把这三项责任分开后，“提出请求”和“开始执行”就不会被
误写成同一件事。

### 05 · 工具结果成为新的环境事实

`tool_result` 继续使用 `call_1`，并带回固定的 README 观察结果。下文把它写进 canonical
transcript 时，会用 `isError=false` 标出读取成功，并把文件内容放进消息。只有这条结果
出现以后，后续模型调用才有依据使用文件内容。

这一章播放的是固定 fixture。README 的结果已经写在演示数据中，固定 fixture 不执行
真实的文件读取，也不会修改你的工作区。真实系统到了同一位置时，`read` 工具才会访问
文件。

### 06 · 第二次模型调用看到新增结果

第二个 `model_start` 表示循环再次调用模型。这次输入中已经包含原来的用户目标、模型
提出的 `call_1`，以及与它配对的 tool result。模型因此可以根据读取结果继续回答。

### 07 · 最终回答结束这次运行

最后一条 `assistant_message` 的 `stopReason` 是 `stop`。它不再请求工具，而是给出一句
概括：“这是一个用于学习 Agent 内核的 TypeScript 项目。”七个里程碑到这里闭合。

:::predict title="工具请求和工具结果分别证明什么"
如果轨迹保留第 03 行的 tool call 和第 07 行的最终文本，却没有第 05 行的 tool result，
系统能否确认 README 已经读取成功？
---answer
不能。tool call 只证明模型提出了读取请求；tool result 才记录读取是否执行以及返回了
什么。最终文本即使看起来正确，也不能代替缺失的环境事实。
:::

## Owner 回顾：三条容易混淆的记录

轨迹中的 `user_message` 和 `assistant_message` 已经直观标出消息来自用户还是模型。下面
三条更容易混淆，因为发起调用、调度动作和访问环境分别由不同对象完成：

`owner` 表示这条事件记录所对应的动作来自谁，不等于最外层调用的发起者。

| 记录 | owner | 当前可观察到的动作 |
|---|---|---|
| `model_start` | `model` | 一次模型生命周期开始 |
| `tool_start` | `loop` | 循环开始调度 `call_1` |
| `tool_result` | `tool` | 工具返回 `call_1` 的环境观察结果 |

loop 发起模型调用时，`model_start` 记录的仍是模型生命周期。模型提出 `read` 后，
`tool_start` 只说明 loop 已开始调度；README 内容要等 `tool_result` 才出现。

`model_start` 和 `tool_start` 都是运行轨迹事件，不是之后会保存进 transcript 的
`AgentMessage`。它们适合显示进度，却不会成为下一轮模型必须读取的长期事实。

## Transcript 保存下一轮仍需要的事实

七个里程碑中，进入 canonical transcript 的是 user message、完成的 assistant message
和 tool result。把它们按顺序放在一起，可以看到第二次模型调用所依据的内容：

```text
user
  content: "读取 README.md，并概括项目"

assistant
  stopReason: toolUse
  toolCall: { id: "call_1", name: "read", arguments: { path: "README.md" } }

toolResult
  toolCallId: "call_1"
  toolName: "read"
  isError: false
  content: "# tiny-pi ..."

assistant
  stopReason: stop
  text: "这是一个用于学习 Agent 内核的 TypeScript 项目。"
```

同一份 `AgentMessage[]` 可以显示在终端、写入 JSONL，或变成下一次模型请求。界面颜色、
日志前缀和折叠状态不属于消息语义，所以 transcript 保存结构化消息，不保存终端渲染
后的字符串。

后续章节会逐步实现这些消息以及运送它们的部件。无论内部代码怎样展开，README 请求
仍沿着同一条可观察路径前进：

```text
用户给出读取目标
  → 模型开始第一轮并提出 read
  → loop 把 call_1 交给工具
  → 工具返回 README 内容
  → call_1 的结果加入对话
  → 模型在第二轮读到新增结果
  → 模型给出最终回答
```

后续代码会给其中几项动作加上组件名。它们与上面的轨迹逐项对应：

| README 请求中的动作 | 后续代码中的名字 |
|---|---|
| 汇集当前 system prompt 和有序消息，形成一次模型调用的输入 | `AgentContext` |
| 让模型开始产生回复 | `Model.stream()` |
| 逐项交付生成事件，并保留最终 assistant message | `EventStream` |
| 根据模型的结束原因决定执行工具还是结束运行 | Agent loop |

第 01–05 章会建立消息、事件流、离线模型和 Provider 边界；第 06–08 章接入工具与 Agent
loop；第 09–11 章让运行可取消、可保存、可恢复，并按预算重建 context；第 12–14 章
再加入资源、产品入口和系统评测。每一部分都会回到这次 README 请求，把其中一个固定
部件换成可以运行的实现。

:::rebuild title="Checkpoint 00 · 观察固定离线轨迹"
**模式：** 观察

**起终点：** `parent` 是课程包出现前的起点；`target` 是固定演示和 2 项聚焦测试通过的终点。

**教学文件：** `packages/pi-course/src/demo/prologue.ts`

**第一步：** 先不看 target diff，为七个里程碑写下 owner；随后创建 Chapter 00 的练习目录，比较固定轨迹并运行聚焦测试。

**聚焦测试：** `packages/pi-course/test/00-prologue.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 00`

**练习目录：** `npm run practice -w @pi/course -- 00`

**聚焦运行：** `npm run build -w @pi/course`，然后运行 `node --test packages/pi-course/dist/test/00-*.test.js`

**通过证据：** 聚焦测试 `2/2`；七条事件的 owner 依次是 `user / model / model / loop / tool / model / model`，删除配对结果后验证器报告“缺少配对结果”。

Chapter 00 的 practice 会导出 target 供你观察，不要求从空白重写实现。`packages/pi-course/`
保存你和陪练使用的引导重建历史；`workshop/` 保存教材自身经过全量测试的最终参考实现。
第一次学习只使用当前练习目录，不在两棵目录之间复制代码。
:::

:::lab title="实践 0.1 · 为七个里程碑标注 owner"
**目标：** 区分用户目标、模型生命周期、循环调度和工具结果。

**文件：** `packages/pi-course/src/demo/prologue.ts`

**动作：**
1. 在纸上写出 01–07，并分别标记 `user / model / loop / tool`。
2. 打开固定 `trace`，逐项比较 `owner` 字段。
3. 找出真实运行中会访问文件的位置，再说明固定结果为什么没有执行它。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="离线轨迹" packages/pi-course/dist/test/00-*.test.js`

**预期：** 局部测试 `1/1`。轨迹恰好有七项，owner 顺序与开头轨迹一致，格式化输出包含
`07 assistant_message`。
:::

:::lab title="实践 0.2 · 检查 call/result 配对"
**目标：** 观察验证器怎样在最终文本之前检查环境事实。

**文件：** `packages/pi-course/test/00-prologue.test.ts`

**动作：**
1. 读第二项测试。它删除 `tool_result`，并按照新的数组位置重新编号。
2. 运行测试，确认测试构造的轨迹由 `assertValidPrologueTrace()` 判断为“缺少配对结果”。
3. 在纸上把 result 移到 call 前面，说明这时应报告“结果先于调用”；真实聚焦测试不包含这项变体。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="悬空 tool call" packages/pi-course/dist/test/00-*.test.js`

**预期：** 局部测试 `1/1`。测试证明验证器会拒绝缺少 `call_1` 结果的轨迹。
:::

:::note title="这两项测试观察到什么"
第一项测试检查七个里程碑、owner 顺序和最终格式化输出。第二项测试删除配对结果，确认
验证器先报告悬空 tool call。它们没有调用真实模型，也没有读取真实 README；网络、工具
执行和消息持久化会在后续 checkpoint 中分别加入。
:::

:::pi title="与当前上游 Pi 对照"
固定参考提交为 `8479bd8`。真实入口还会加载配置、模型和扩展，但进入核心后仍沿着
“消息 → 模型流 → 工具结果 → 下一轮”推进。课程序章省略网络、并发和会话树，只留下
七个便于观察的里程碑；真实 Pi 的运行事件不止这七种。
:::

## 本章验收

:::checkpoint title="Checkpoint 00 · 画出 README 请求的完整闭环"
运行 `npm run build -w @pi/course`，再运行
`node --test packages/pi-course/dist/test/00-*.test.js`，结果应为 `2/2`。

合上正文后，重新写出七条记录并保留每条的 owner。圈出会进入 transcript 的消息，划线
连接第 03 条 tool call 与第 05 条 tool result，再说明 `model_start` 和 `tool_start`
为什么只留在运行轨迹中。完成这三项观察，就能区分事实来源、过程事件和下一轮仍需
读取的消息。
:::

## 小结

同一条 README 请求提供了两种观察角度。`owner` 标出当前事实由谁产生；canonical
transcript 则保留下一轮仍要读取的 user message、完整 assistant message 和 tool
result。`model_start` 与 `tool_start` 适合显示进度，不需要进入长期消息。

`call_1` 把模型的读取意图与工具返回的环境事实配成一对。后续章节会继续使用这条固定
轨迹，逐件换入消息、事件流、模型、工具、循环和持久化实现。
