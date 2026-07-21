---
id: "09"
slug: stateful-agent
part: state
partTitle: 第三部 · 让 Harness 可靠
chapter: "09"
title: 从单次循环到有状态 Agent
summary: 让一个对象持有跨运行状态，并把重入、订阅、取消、steering 与 follow-up 的时序写成可执行契约。
minutes: 210
difficulty: 核心
artifact: packages/pi-course/src/agent.ts
prerequisites: 07,08
terms: stateful agent, lifecycle, abort, steering, follow-up, reentrancy
upstream: packages/agent/src/agent.ts
---

## 同一个 Agent 连续完成两次运行

第 08 章结束时，`runAgentLoop()` 已经能用 read、write、edit 和 bash 完成一次任务。
它返回完整的 `AgentRunResult`，随后函数里的局部变量便结束了。下一条用户输入若要继续
上一段对话，调用者得自己保存消息、阻止两个循环同时运行，还要把运行中的新指令交到
正确的模型回合。

这一章在循环外增加一个长期存在的 `Agent` 对象。下面的时间线始终使用同一个实例：

```text
t0  agent.prompt("检查 README")                         run 1 开始
t1  assistant 提出两个工具调用
t2  agent.steer("先检查测试")
t3  agent.steer("再更新说明")                           两条消息进入 run 1 的队列
t4  两个工具都形成配对结果
t5  两条 steering 按 FIFO 进入 transcript，模型继续回答
t6  run 1 结束，Agent 保存完成后的 messages
t7  agent.prompt("提交结论")                            run 2 开始
t8  run 2 的模型请求看到 run 1 全部消息和新的用户输入
```

run 1 的第二次模型请求会看到这样的尾部：

```text
assistant(toolCall slow, toolCall fast)
toolResult(slow)
toolResult(fast)
user("先检查测试")
user("再更新说明")
```

工具可以反序完成，两个 `toolResult` 仍按原始 call 顺序写入。steering 排在完整工具批次
之后，所以它不会切进一对 call/result 中间。run 1 自然结束以后，run 2 再把
`user("提交结论")` 追加到这份已完成的历史后面。

这里出现了两种时间尺度。`runAgentLoop()` 只拥有一次运行里的模型回合和工具批次；
`Agent` 活得更久，保存两次运行之间仍需存在的消息与配置。第 10 章才会把完成后的
消息写入磁盘。本章的控制器、流式文字和输入队列仍只存在于内存中。

## Agent 保存状态，ActiveRun 保存临时所有权

`Agent` 内部的数据可以按寿命分成两层：

| 数据 | 存活时间 | 用途 |
|---|---|---|
| `state.messages` | 跨多次 `prompt()` | 下一次运行的 transcript 起点 |
| subscribers | 与 `Agent` 实例相同 | 观察每次运行的事件 |
| `ActiveRun` | 一次 `prompt()` | 标识当前运行并持有控制器和队列 |
| `streamingText`、`pendingToolCallIds` | 当前运行期间 | 给界面提供临时状态 |

每次 `prompt()` 都创建一份新的 `ActiveRun`：

```ts
interface ActiveRun {
  id: number;
  controller: AbortController;
  steering: UserMessage[];
  followUps: UserMessage[];
  acceptingInput: boolean;
}
```

`id` 区分 run 1 和 run 2；控制器只取消这一轮；两条数组保存运行中到达的用户消息。
`acceptingInput` 在循环发布 `turn_end` 时变成 `false`，避免终态已经形成后仍接收一条
永远不会被读取的消息。

`Agent` 不接管第 07、08 章的模型与工具状态机。它把 context、signal、事件回调和两
个取队列函数交给 `runAgentLoop()`。循环返回后，`Agent` 先释放本次 `ActiveRun`，再发布
`run_end`。此时 `reduceAgentState(oldState, run_end)` 计算出新快照，`Agent` 保存这个
返回值并通知订阅者；reducer 本身不持有状态。此后 run 2 才能开始。

这条时间线只维护一个所有权事实：同一个实例在任意时刻最多有一份有效的 `ActiveRun`，
旧运行也只清理自己创建的那一份。

:::rebuild title="Checkpoint 09 · 让同一个 Agent 管理两次运行"
**模式：** 重建

**起终点：** `parent` `6b3b1b77` 是第 08 章完成后的起点；`target` `d055d832` 是
两份教学文件完成、11 项聚焦测试通过后的终点。

**教学文件：** `packages/pi-course/src/agent.ts`、
`packages/pi-course/src/agent-loop.ts`

**学习脚手架：** practice 目录会用 `starters/09-agent.ts` 和
`starters/09-agent-loop.ts` 覆盖这两份教学文件。`agent.ts` 固定公共状态、事件和方法
签名；`agent-loop.ts` 保留前两章的循环，并标出本章施工位。两份脚手架都能编译，
但没有本章答案。

**动手前只需知道：** `AgentEvent` 记录 `run_start`、带 `runId` 的 `loop` 事件和
`run_end`。reducer 根据事件派生公开状态；`ActiveRun` 则由 `prompt()` 创建和清理，
它不是 transcript 的一部分。

**第一步：** 先不看 target diff，只实现纯函数 `reduceAgentState()`。先处理
`run_start`，再用当前 `activeRunId` 过滤迟到的 `loop` 与 `run_end`。

**第一次红灯：** 脚手架初始 build 可以通过。只运行 Lab 9.1 时，首个可见失败是
`Lab 9.1 reducer 尚未实现`，不是缺模块或隐式 `any`。

**聚焦测试：** `packages/pi-course/test/09-stateful-agent.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 09`

**练习目录：** `npm run practice -w @pi/course -- 09`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/09-*.test.js`

**通过证据：** 五段局部测试依次得到 `2/2`、`2/2`、`2/2`、`2/2`、`3/3`。它们
分别观察状态派生、两次顺序运行、公开副本、取消传播和队列取出时机。
:::

## `run_start` 把 run 1 投影成公开状态

`AgentState` 是某一时刻给界面读取的快照：

```ts
interface AgentState {
  status: "idle" | "running";
  messages: AgentMessage[];
  activeRunId?: number;
  lastReason?: AgentRunResult["reason"];
  streamingText: string;
  pendingToolCallIds: string[];
  diagnostics: string[];
}
```

reducer 接收旧状态和一个 `AgentEvent`，返回新状态。run 1 的三个阶段对应三种事件：

```text
run_start(1)
  → status = running
  → activeRunId = 1
  → messages 追加 "检查 README"

loop(1, text_delta | tool_start | tool_end | assistant_message)
  → 更新 streamingText 或 pendingToolCallIds

run_end(1)
  → status = idle
  → messages = run 1 的完整结果
  → lastReason = stop
```

reducer 不拥有输入对象。`run_start` 要深复制原有 `state.messages` 和
`event.message`；`run_end` 同样要深复制 `result.messages`。调用者稍后改动事件或
结果时，已经派生出的状态不会随之变化。

run 2 开始以后，run 1 的事件仍可能迟到。若状态中的 `activeRunId` 已是 2，
`loop(1, ...)` 和 `run_end(1)` 都原样返回当前状态。测试没有规定乱序到达的
`run_start`；这个过滤只覆盖当前实现中的 `loop` 与 `run_end`。

TypeScript 对嵌套联合有时不会继续保留收窄结果。确认 `event.type === "loop"` 后，
把 `event.event` 保存为 `const loop = event.event`，再按 `loop.type` 分支。这个局部变量让
编译器继续携带已经取得的类型证据，代码不需要用 `as any` 跳过检查。

:::lab title="实践 9.1 · 派生 run 1 的状态"
**目标：** 让同一组生命周期事件总能得到同一份状态，并忽略旧运行迟到的事件。

**文件：** `packages/pi-course/src/agent.ts`

**动作：**
1. 实现 `run_start`，记录运行 id、用户消息与 `running` 状态，并深复制两部分消息。
2. 处理 `text_delta`、`tool_start`、`tool_end`、`tool_skipped` 与
   `assistant_message`。
3. 实现 `run_end`，保存结果消息的深副本、结束原因和 `idle` 状态。
4. 在处理 `loop` 和 `run_end` 前核对当前状态与 `runId`。
5. 删除 Lab 9.1 的显式异常，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 9.1" \
  packages/pi-course/dist/test/09-*.test.js
```

**预期：** `2/2`。第一项检查主要状态迁移和输入副本；第二项证明 run 1 的迟到事件
不会覆盖 run 2。
:::

## `prompt()` 先结算 run 1，再开放 run 2

run 1 开始时，`prompt("检查 README")` 从两份数据构造局部 `contextMessages`：

```text
Agent 中已经完成的历史
+ 当前用户消息 "检查 README"
= run 1 的 contextMessages 深副本
```

随后它创建 `ActiveRun(1)`，发布 `run_start`，并把同一份局部副本交给
`runAgentLoop()`。这份局部副本就是本轮输入；若发布事件后再回读
`this.state.messages`，回调重入产生的 `run_start` 可能仍在 FIFO 队列中，reducer 还没
把当前用户消息写入公开状态。发布前完成的快照避开了这个时序差。

循环返回后，顺序固定为：

```text
run 1 得到 AgentRunResult
  → 按身份清理 ActiveRun(1) 和两条队列
  → emit run_end(1)
      → reducer 先保存完整 transcript
      → 再通知全部 listeners
  → 返回一份结果副本
```

这时 `prompt("提交结论")` 才创建 `ActiveRun(2)`。run 2 的
`contextMessages` 由 run 1 已经完成的历史和当前用户消息组成，所以第二次模型请求能
看到前一次输入、工具结果、steering 和最终回答。

### 同一实例拒绝两个并行循环

如果 `ActiveRun(1)` 仍存在，第二个 `prompt()` 会以 `Agent is busy` 拒绝。调用者
可以把运行中的修正交给 `steer()`，把自然结束后的追加工作交给 `followUp()`；
`prompt()` 本身不会猜测第二条输入属于哪一种语义。

结束阶段还要处理订阅回调的重入。run 1 的 `run_end` 回调可以同步启动 run 2。
run 1 因此用局部变量保留自己创建的 `ActiveRun`，清理时核对对象身份，并在发布
`run_end` 前完成清理。旧运行不能在回调返回后无条件清除 `this.activeRun`，否则它会
删掉 run 2 刚创建的控制器与队列。

回调重入产生的新事件不能插队。`emit()` 把新事件放进 FIFO，当前事件通知完所有
订阅者后才继续分发。两个订阅者因而都看到 `start1 → end1 → start2 → end2`，不会有
一个先看到 `start2`、另一个还停在 `end1`。

模型请求抛错也在单次循环内结算。若工具已经执行，第二次模型请求抛错，
`runAgentLoop()` 仍会保留对应的工具调用和工具结果。它把异常转换成
`stopReason: "error"` 的 assistant 消息，追加后再返回；`Agent.prompt()` 外层的兜底
只处理循环之外的意外错误。这样已经发生的副作用不会从 transcript 中消失。

:::lab title="实践 9.2 · 让 run 1 和 run 2 顺序共享 transcript"
**目标：** 用一个 `Agent` 完成两次顺序运行，拒绝并行 `prompt()`，并让重入回调看到
稳定的生命周期顺序。

**文件：** `packages/pi-course/src/agent.ts`、
`packages/pi-course/src/agent-loop.ts`

**动作：**
1. 在 `Agent` 中保存 options、state、订阅集合、事件 FIFO、`nextRunId` 和当前
   `ActiveRun`。
2. 实现最小可用的 `subscribe()`、`getState()` 与 `emit()`；每个事件先经过 reducer。
3. `prompt()` 在发布 `run_start` 前构造局部消息副本和新的 `ActiveRun`。
4. 把 model、tools、signal、context、`onEvent` 和队列回调交给 `runAgentLoop()`。
5. 脚手架把 `runAgentLoop` 作为值导入；它会在运行时被调用，因此不能变成只在编译期
   存在的 `import type`。
6. 在 loop 内把模型请求异常转换为 error assistant，并保留当前 `messages`。
7. 用对象身份清理本次运行，再发布唯一的 `run_end`。
8. 删除 Lab 9.2 的显式异常，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 9.2" \
  packages/pi-course/dist/test/09-*.test.js
```

**预期：** `2/2`。第一项观察 busy guard、两次顺序运行和模型失败后的完整消息；第二项
从 run 1 的 `run_end` 回调启动 run 2，确认旧清理没有碰到新运行。
:::

## 三个公开出口各自得到一份副本

状态已经跨运行保存，接下来要明确谁能修改它。内部消息会从三个出口离开 `Agent`：

| 出口 | 接收者 | 与内部共享引用的后果 |
|---|---|---|
| `getState()` | 界面 | 修改快照会改写下一次模型输入 |
| subscriber event | 界面或日志 | 一个订阅者会污染另一个订阅者 |
| `prompt()` result | 调用者 | 改返回值会改写 Agent 的历史 |

三条路径都使用 `structuredClone()`。只复制 `messages` 数组不够，因为
`messages[0].content[0]` 仍会指向同一个 block。`emit()` 先用事件更新 state，再把各自
独立的事件副本交给订阅者；回调在 `run_start` 中调用 `getState()` 时，应该已经看到
`running` 和当前 `runId`。

单个订阅者抛错不会终止 run 1。`emit()` 把错误文字追加到 `diagnostics`，继续通知其余
订阅者。`unsubscribe()` 只删除创建它的那个 listener。

`ToolResultMessage.details` 是 `unknown`，其中可能出现函数等不可复制值。工具此时可能
已经执行并产生了副作用，只是原结果无法安全进入 transcript。循环会生成一条标准、
可复制的错误结果，沿用原 call 的 id 和 name。这样 call/result 配对仍然完整，`Agent`
也能发布 `run_end` 并回到 `idle`；这条消息不表示工具副作用已经回滚。

:::lab title="实践 9.3 · 隔离状态、事件和返回值"
**目标：** 让三个公开出口都与内部状态隔离，并让一个失败订阅者不影响运行。

**文件：** `packages/pi-course/src/agent.ts`、
`packages/pi-course/src/agent-loop.ts`

**动作：**
1. `getState()` 和 `prompt()` 返回深副本。
2. `emit()` 先更新 state，再遍历订阅集合的快照。
3. 给每个订阅者单独复制事件，捕获它自己的异常并记录诊断。
4. 让 `unsubscribe()` 只删除对应回调。
5. 在 loop 中把不可结构化复制的工具结果转换成标准错误结果。
6. 删除 Lab 9.3 的显式异常，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 9.3" \
  packages/pi-course/dist/test/09-*.test.js
```

**预期：** `2/2`。第一项观察状态先更新、坏 subscriber 隔离和精确退订；第二项修改
三个公开出口，并用不可复制的工具结果检查标准错误与 `idle` 终态。
:::

## `abort()` 只向当前运行发出取消信号

`Agent.abort()` 不直接制造 `run_end`。它只调用当前 `ActiveRun` 的控制器：

```text
agent.abort()
  → ActiveRun(1).controller.abort()
      ├─ runAgentLoop 收到 signal
      ├─ model 收到同一个 signal
      └─ tool executor 收到同一个 signal
```

若订阅者在 `run_start(1)` 中立刻取消，控制器已经存在，而循环还没有请求模型。
`runAgentLoop()` 在循环入口看到 `signal.aborted`，直接以 `aborted` 结算，模型请求数仍是
零。重复调用 `abort()` 只是重复设置同一个信号。

若取消发生在工具执行期间，工具调用已经进入 transcript。循环等待执行器形成配对
`toolResult`，把结果写入消息后再以 `aborted` 结束。run 2 会创建新的控制器；旧 signal
不能污染下一次运行。

取消是协作协议。模型忽略 `signal` 并返回普通文本时，循环收到完整消息后还要再次
检查取消状态，并在 `stop` 分支优先以 `aborted` 结束。若模型或工具永久不返回，单个
`AbortController` 无法强制杀死它。

:::lab title="实践 9.4 · 取消 run 1，不影响 run 2"
**目标：** 让模型请求前和工具执行中的取消都只结算当前 `ActiveRun`。

**文件：** `packages/pi-course/src/agent.ts`、
`packages/pi-course/src/agent-loop.ts`

**动作：**
1. `abort()` 只操作当前运行的控制器，并把同一 signal 交给 loop。
2. 入口已取消时不请求模型，只发布一次 `run_end`。
3. 工具执行中取消时，等待现有调用形成配对结果。
4. 模型忽略 `signal` 时，在文本 `stop` 分支再次检查并返回 `aborted`。
5. 清理后让下一次 `prompt()` 创建新控制器。
6. 删除 Lab 9.4 的显式异常，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 9.4" \
  packages/pi-course/dist/test/09-*.test.js
```

**预期：** `2/2`。第一项检查预取消、重复 abort 和 run 2 的新控制器；第二项比较模型
与工具收到的 signal，并观察取消后的配对结果和忽略 signal 的文本模型。
:::

## 队列消息只在完整协议边界进入 transcript

run 1 运行期间，`steer()` 与 `followUp()` 都会创建 `UserMessage`，但它们承诺的时间
不同：

| 方法 | 用户意图 | loop 取出位置 |
|---|---|---|
| `steer()` | 修正当前任务的下一次决策 | 完整工具批次后，或纯文本 `stop` 后 |
| `followUp()` | 当前回答自然结束后继续 | 纯文本自然 `stop` 后，且没有 steering |

开篇的两条 steering 在工具仍执行时进入 FIFO。`fast` 可以先完成，loop 仍等 `slow`
结束，并按 call 顺序写入两条结果。然后才调用 `takeSteeringMessages()`：

```text
tool_end(fast)
tool_end(slow)
transcript += result(slow), result(fast)
transcript += user("先检查测试"), user("再更新说明")
下一次 model.stream(context)
```

纯文本也形成完整边界。模型输出 `assistant(stop)` 后，loop 先检查取消，再取 steering；
没有 steering 才取 follow-up。取到任一批消息都会继续 run 1，而不是开启新的
`prompt()`。

`error` 或 `aborted` 直接结束运行，剩余队列在 `ActiveRun` 清理时丢弃，不会进入下一次
run。取消检查一定先于队列消费；以 `error` 或 `aborted` 结束后，未消费消息不会进入下一次
运行。`turn_end` 一发布，`acceptingInput` 已经是 `false`，新的 `steer()` 和
`followUp()` 会明确拒绝。

这条队列规则只覆盖 `stop/error/aborted` 等完整终态。steering 或 follow-up 若恰好在
最后一个允许回合到达，现有测试没有规定它应写入还是丢弃；当前实现也可能先取队列，
随后才返回 `maxSteps`。因此 `maxSteps` 边缘仍是未定的产品策略。

:::lab title="实践 9.5 · 在完整边界消费两条队列"
**目标：** 固定 steering 与 follow-up 的取出顺序，并阻止终止运行的队列泄漏到 run 2。

**文件：** `packages/pi-course/src/agent.ts`、
`packages/pi-course/src/agent-loop.ts`

**动作：**
1. 在 `ActiveRun` 中保存两条 FIFO；idle 或收到 `turn_end` 后拒绝新输入，错误文字包含
   `只在当前 run 尚未结束`。
2. 把 `takeSteeringMessages()` 与 `takeFollowUpMessages()` 交给 loop。
3. 工具批次先写完所有配对结果，再检查取消并取 steering。
4. 文本 `stop` 先检查取消，再依次尝试 steering 和 follow-up。
5. error、aborted 与运行清理都不把剩余队列带入 run 2。
6. 删除 Lab 9.5 的显式异常，先运行本段，再运行全章测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 9.5" \
  packages/pi-course/dist/test/09-*.test.js
node --test packages/pi-course/dist/test/09-*.test.js
```

**预期：** 局部 `3/3`，全章 `11/11`。三项测试分别观察工具批次后的 FIFO steering、
文本 stop 期间到达的 steering，以及自然 stop 后的 follow-up；组合场景再检查取消
优先、终态拒绝和失败队列隔离。
:::

## 诊断旧运行误删新运行

正常实现会在 `run_end` 之前用身份检查清理当前运行。保留你已有的清理和身份检查，
然后在发布 `run_end` 之后，故意增加一次不带身份检查的清理：

```text
if (this.activeRun === run) this.activeRun = undefined
emit(run_end)
this.activeRun = undefined   // 故意增加
```

原来的清理仍留在 `run_end` 之前。若把它整体移到事件之后，回调启动 run 2 时仍会看到
run 1 busy，测试只能等到超时。上面的变体先允许回调创建 run 2，再让旧代码把新记录
删掉，因此能直接观察所有权错误。

:::failure title="预期失败 · run 1 清掉了 run 2"
只运行 Lab 9.2。run 1 的 `run_end` listener 会启动 run 2，随后第三次并行
`prompt()` 本应得到 `Agent is busy`；新增的无条件清理会错误放行它。删除该行，恢复
“只清理身份匹配的 ActiveRun，并在 `run_end` 前完成”后，局部测试应回到 `2/2`，全章
回到 `11/11`。
:::

## 这份 Agent 的边界是单实例、内存内生命周期

11 项测试把当前层固定在三个范围内：

- 一个 `Agent` 实例串行拥有一份 `ActiveRun`，subscriber 在 `emit()` 调用中同步执行。
  异步回调的背压与优先级需要另一层调度协议。
- `abort()` 把同一个 signal 送到模型和工具；运行何时真正结束，仍取决于它们是否响应
  signal。steering 与 follow-up 在 `maxSteps` 边缘的取舍属于产品策略。
- transcript 和公开状态都保存在当前进程。会话持久化、分支与压缩由后续章节加入；多个
  进程共同写一条会话需要更外层的协调。

聚焦测试通过修改返回对象，直接检查 `getState()`、subscriber event 与 `prompt()` result
的副本边界。Loop 输入 context 和模型返回 assistant 也会深复制，但这两处目前只有源码
路径，没有各自的别名变异用例。

:::pi title="与固定上游 Pi 对照"
固定提交 `8479bd8` 的 `packages/agent/src/agent.ts` 同样在底层循环外保存消息、工具和
当前运行的 `AbortController`，也区分 steering 与 follow-up。上游还支持更多队列模式、
运行中切换模型与配置、异步订阅回调和更多产品状态。

课程只保留这条时间线所需的形状：一个实例同一时刻只有一个运行；每次运行拥有独立
控制器；公开数据不共享内部可变引用；两种消息只在规定的完整边界进入 transcript。
这些课程约束不代表上游所有队列模式都与本章相同。
:::

## 两次运行的时间线与验收

:::checkpoint title="Checkpoint 09 · run 1 结束后 run 2 仍有明确所有者"
在隔离 practice 目录运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/09-*.test.js
```

结果应为 `11/11`。随后画出两条时间线。

第一条从 run 1 的结果开始：标出它何时清理自己的 `ActiveRun`、何时发布
`run_end(1)`、listener 何时创建 run 2，以及第三次并行 `prompt()` 在哪里被拒绝。两个
listener 看到的顺序都应是 `start1 → end1 → start2 → end2`。

第二条从 `assistant(call slow, call fast)` 开始：标出 fast 与 slow 的实际完成顺序、
结果按 call 顺序写入 transcript 的时间、两条 steering 何时排队、何时按 FIFO 写入消息历史，
以及下一次模型请求何时发起。最后再指出 run 2 的 context 从哪里取得 run 1
已经完成的历史。

还要分别用测试说明 `getState()`、订阅事件与 `prompt()` 返回值为什么不能修改内部
状态，并在源码中找到对应的 `structuredClone()`。重新定位可运行
`npm run checkpoint -w @pi/course -- 09`；重做时新建 practice 目录，不复用已改过的
脚手架。
:::

## 可选迁移练习

:::transfer title="陪练迁移 · waitForIdle"
为同一个 `Agent` 增加 `waitForIdle(): Promise<void>`。先写四个验收例子：idle 时立即
完成、正常 run 结束后完成、abort 结算后完成、多个等待者都完成。实现只使用公开状态
和事件，不读取私有控制器。最后再启动一次 prompt，确认新运行没有复用旧 signal。
:::

## 小结

同一个 `Agent` 现在能完成 run 1，保存它的 transcript，再用这份历史开始 run 2。
`ActiveRun` 给每次运行独立的 id、控制器和消息队列；身份检查保证旧运行不会清理新
运行。reducer 把生命周期事件变成公开状态，事件 FIFO 让所有同步订阅者观察同一顺序，
深副本隔离三个公开出口。

run 1 中到达的 steering 只在完整工具批次或文本 stop 后进入消息；follow-up 只在自然
stop 后进入。取消和失败先结算当前运行，未消费队列不会泄漏到 run 2。

第 10 章会把已经完成的消息历史写成 session tree。`ActiveRun`、AbortController、
流式文字和尚未消费的队列仍是运行时状态，不会进入持久化记录。
