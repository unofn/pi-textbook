---
id: "14"
slug: eval-capstone
part: product
partTitle: 第四部 · 从核心到产品
chapter: "14"
title: 给完整的 Pi 建一套独立评测
summary: 让 runner 每次重新调用 EvalCase.prepare，验证执行轨迹和任务结果，并输出只含固定分类与计数的报告。
minutes: 180
difficulty: 综合
artifact: packages/pi-course/test-support/eval.ts
prerequisites: 07,09,10,13
terms: eval runner, fresh fixture, judge, active path, protocol failure, safe evidence, held-out
upstream: packages/agent/test/agent-loop.test.ts,packages/coding-agent/test/agent-session-compaction.test.ts
---

## `write-answer` 从任务对象走到通过报告

第 13 章的 `Runtime` 已经拥有 Agent、session、context 和生命周期。最后一章把它当作
被评对象，不再修改产品核心。下面这一个 `EvalCase` 会贯穿全章：

```text
EvalCase write-answer
  id      = "write-answer"
  prompt  = "write ok to answer.txt"
  files   = ["answer.txt"]
  prepare = 每次创建新的临时目录、Runtime 和 session
  judge   = 检查文件正文和最终 assistant
```

第一次调用 `prepare()` 得到 `PreparedEval #1`。它包含一个新的 Runtime、只读文件函数
和 cleanup；第二次运行同一个 case 时，`prepare()` 返回另一个 `PreparedEval #2`。
两次运行不共享目录、session 或 Runtime。

`PreparedEval #1` 的 Runtime 执行 prompt 后返回：

```text
AgentRunResult
  reason   = stop
  steps    = 2
  messages = [
    user("write ok to answer.txt"),
    assistant(toolCall id="call-write", name="write_file"),
    toolResult(id="call-write", name="write_file", isError=false),
    assistant("done"),
  ]
```

同一轮的 session 还含一个 metadata root 和一条未选中的 sibling。活动 leaf 指向最终
assistant，因此 `pathTo()` 只返回下面这条祖先链：

```text
meta → u1 → a-call → r-write → a-done
          └─ sibling                         不在 active path
```

runner 只读取 case 声明的 `answer.txt`，得到字符串 `"ok"`。随后交给 judge 的
`EvalObservation` 是：

```text
observation.result   = 上面的 AgentRunResult
observation.entries  = [meta, u1, a-call, r-write, a-done]
observation.files    = { "answer.txt": "ok" }
```

这三个值已深复制并递归冻结。Judge 可以读取，不能改写 Runtime 返回值、session entry
或文件映射。`write-answer` 的 judge 返回：

```ts
{
  passed: true,
  checks: [
    observation.files["answer.txt"] === "ok",
    textOf(observation.result.messages.at(-1)!) === "done",
  ],
}
```

两个检查都为 true，runner 最后交出一份不含原始正文的报告：

```ts
{
  id: "write-answer",
  status: "passed",
  evidence: {
    messages: { user: 1, assistant: 2, toolResult: 1 },
    tools: { calls: 1, results: 1, errors: 0 },
    files: { requested: 1, read: 1 },
    checks: { passed: 2, failed: 0 },
  },
  secondaryFailures: [],
}
```

这条正向链包含本章所有对象：case 负责 setup，Runtime 完成任务，runner 收集可信事实，
judge 判断任务条件，report 只留下可公开的分类和计数。

:::rebuild title="Checkpoint 14 · 让一个 EvalCase 走完整条评测链"
**模式：** 重建

**起终点：** `parent` `1caf1082b3f92504346bbeda969e4cfbb0f8f636` 是第 13 章 Runtime 完成后的起点；
`target` `d2bfac24e212fec05299679e8af18abc6c1bbc67` 是独立 runner、9 项公开测试和
3 项 target held-out 测试完成后的终点。

**教学文件：** `packages/pi-course/test-support/eval.ts`、
`packages/pi-course/tsconfig.json`

**学习脚手架：** `starters/14-eval.ts` 固定 case、observation、verdict、failure、evidence
和 report 的公共类型；`starters/14-tsconfig.json` 把 `test-support/**/*.ts` 加入编译。
脚手架能 build，但两个导出函数没有实现。

**动手前只需知道：** case 的 `prepare()` 每次返回新的 Runtime 和文件读取边界；runner
拥有执行、收集、协议检查和清理顺序；judge 只读取冻结 observation 并返回 checks。

**第一步：** 先不看 target diff，在 `runEvalCase()` 中接通
`prepare → prompt → flush → entries → active path → files → judge → dispose → cleanup`。

**第一次红灯：** fresh starter 的 build 通过。只运行 Lab 14.1 时得到 `0/3`，三项都
报告 `Lab 14.1 runEvalCase 尚未实现`。

**聚焦测试：** `packages/pi-course/test/14-eval-capstone.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 14`

**练习目录：** `npm run practice -w @pi/course -- 14`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/14-*.test.js`

**通过证据：** 三个 Lab 各 `3/3`，公开测试共 `9/9`。target 另有 3 项 held-out 回归；
它们不随 practice 分发。
:::

## Runner 每次重新调用 `prepare()`

`EvalCase` 只描述任务和判定入口：

```ts
interface EvalCase {
  id: string;
  prompt: string;
  files: readonly string[];
  prepare(): Awaitable<PreparedEval>;
  judge(observation: EvalObservation): Awaitable<TaskVerdict>;
}

interface PreparedEval {
  runtime: Runtime;
  readFile(file: string): Awaitable<string>;
  cleanup?(): Awaitable<void>;
}
```

setup 工作发生在 `prepare()` 内。`write-answer` 的实现约定第一次调用创建目录 1 和
Runtime 1，第二次调用创建目录 2 和 Runtime 2。runner 不缓存 `PreparedEval`；suite 即使
收到两次同一个 case 对象，也会再次调用 `prepare()`。

Runner 只能保证“重新调用”，无法判断返回的目录、session 和 Runtime 是否真是新的。
fresh environment 是 case 作者要履行的契约。示例 fixture 用不同 generation 证明
`write-answer` 履行了它：如果第二次仍返回第一次的目录，旧 `answer.txt` 会混入这次
判定，报告便不再只描述当前运行。

`EvalCase.files` 也是 setup 契约的一部分。Runner 不遍历目录，只调用：

```ts
for (const file of evalCase.files) {
  files[file] = await prepared.readFile(file);
}
```

因此 `write-answer` 的 judge 只能看到 `answer.txt`。临时目录中的日志、缓存和未声明文件
不进入 observation。

## Runtime 完成后，runner 只取活动路径

一次正常执行按固定顺序前进：

```text
prepare
  → runtime.prompt(prompt)
  → runtime.flush()
  → runtime.session.entries()
  → runtime.getActiveLeafId()
  → pathTo(allEntries, leafId)
  → 工具协议与 result/session 深比较
  → 读取声明文件
  → judge
  → runtime.dispose()
  → prepared.cleanup()
```

`flush()` 明确等待 Runtime 已接受的工作。随后 runner 读取完整 session，但不会把整个树
交给 judge。它用第 10 章的 `pathTo()` 从活动 leaf 回到 root，未选 sibling 自然消失。
Runner 不复制一套 parent traversal，也不把物理最后一行当作活动 leaf。

Runtime 的返回 messages 与 session active path 是两条独立来源。runner 从活动路径中
取出 message entries，并与 `result.messages` 做深比较：

```text
Runtime.prompt() result.messages
                  ╲
                   深相等
                  ╱
active path 中的 message entries
```

两边一致以后，文件和 task verdict 才有可信的运行背景。`write-answer` 的 metadata root
可以留在 observation.entries 中，但不参与 messages 比较。

## Observation 先复制，再递归冻结

`EvalObservation` 只有三个出口：

```ts
interface EvalObservation {
  readonly result: AgentRunResult;
  readonly entries: readonly SessionEntry[];
  readonly files: Readonly<Record<string, string>>;
}
```

TypeScript 的 `readonly` 不限制运行时对象。`Object.freeze(observation)` 也只冻结最外层。
目标实现先用 `structuredClone()` 切断与 Runtime、session 和 fixture 的引用，再递归访问
嵌套值并冻结。Judge 因此不能 push entry、改 tool arguments 或替换文件内容。

冻结发生在文件收集之后。任何文件读取返回非字符串，或 observation 无法结构化复制，
runner 都不会调用 judge。正常 case 得到的 observation 则可以稳定重复判定。

## Judge 先得到可信轨迹，再判断任务条件

在 `write-answer` 中，runner 在调用 judge 前核对四类协议事实：

- active path 至少包含一条 user interaction；
- `call-write` 在 assistant 中只声明一次；
- toolResult 的 `toolCallId` 和 `toolName` 都与 call 相同，并且只出现一次；
- result messages 与持久化路径中的 messages 深相等。

Judge 不负责这些检查。它只判断 `answer.txt` 和最终 assistant 是否满足任务。返回值中的
`passed` 必须等于 `checks.every(Boolean)`。正常 verdict
`{ passed: true, checks: [true, true] }` 因而有效。

运行成功以后，`finally` 仍会先 `runtime.dispose()`，再调用可选的
`prepared.cleanup()`。Dispose 让 Runtime 完成关闭；cleanup 再删除 case 创建的临时
资源。若 `prepare()` 在交出 `PreparedEval` 前失败，runner 没有 cleanup 句柄，prepare
自身负责回滚已经创建到一半的资源。

:::lab title="实践 14.1 · 跑通 fresh case 并交出冻结 observation"
**目标：** 让 runner 每次重新调用 prepare，并让示例 case 返回新环境；judge 只看到活动
路径和声明文件，生命周期按 `dispose → cleanup` 收口。

**文件：** `packages/pi-course/test-support/eval.ts`

**动作：**
1. 为一次调用保存局部 `prepared`、`runtime`、evidence 和 report。
2. 每次进入 `runEvalCase()` 都重新调用 `prepare()`。
3. 依次执行 prompt、flush、entries、active path 和声明文件读取。
4. 深复制并递归冻结 observation，再调用 judge。
5. 用 `finally` 固定 dispose 与 cleanup 的顺序。
6. 让 prompt/flush 故障落在 execute，让 session/file/clone 故障落在 collect。
7. 删除 Lab 14.1 的显式异常，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 14.1" \
  packages/pi-course/dist/test/14-*.test.js
```

**预期：** `3/3`。一项连续运行同一 case 两次，一项检查 sibling、文件白名单和深冻结，
一项区分 execute 与 collect。
:::

## Runner 捕获偏差时记录所在阶段

通过 case 已经说明 runner 正常时怎样工作。现在才需要给偏差命名。

| 位置 | report status | primary failure |
|---|---|---|
| case 形状无效 | `infra_failed` | `prepare/invalid_case` |
| `prepare()` 抛错或返回无效对象 | `infra_failed` | `prepare/prepare_failed` |
| session、文件或冻结失败 | `infra_failed` | `collect/collect_failed` |
| active path 或消息协议不成立 | `protocol_failed` | `protocol/<固定协议码>` |
| judge 抛错或 verdict 自相矛盾 | `infra_failed` | `judge/judge_failed` 或 `judge/invalid_verdict` |
| judge 合法返回 `passed:false` | `task_failed` | `task/task_rejected` |

表中的分类来自显式 catch 分支，不从 `Error.message` 猜测。进入这些分支后，报告只保存
固定 phase 和 code；异常正文、cause 与 stack 留在评测边界内。

当前 target 有一个没有进入这张表的调用：`getActiveLeafId()` 位于 collect catch 之外。
它返回 `null` 时会生成 `protocol/missing_active_leaf`；它自己若抛异常，`finally` 仍会执行，
但 `runEvalCase()` 会 reject 原异常而不是返回脱敏报告。公开测试没有覆盖这个 getter
异常，因此“固定 failure 不泄露正文”的保证只适用于上表已捕获的分支。

### 合法拒绝和坏 judge 是两种结果

下面的 verdict 合法：

```ts
{ passed: false, checks: [true, false] }
```

它表示任务两项条件只通过一项，所以报告是 `task_failed`。下面的值则自相矛盾：

```ts
{ passed: true, checks: [true, false] }
```

checks 的合取为 false，`passed` 却为 true。Runner 把它归到
`judge/invalid_verdict`，不能让 Agent 承担判定器自己的错误。Judge 直接抛异常时，对应
`judge/judge_failed`。

### 工具协议按活动路径顺序扫描

Runner 逐条读取 active path 中的 message entries。遇到 assistant tool call 时，它记录
call id、name 和是否已配对；遇到 result 时，它核对 id、name 与 matched 状态。

单纯比较 call/result 总数不够。下面四条消息最终各有一个 call 和 result，但仍不合法：

```text
user
assistant(toolCall call-write)
assistant("continued before result")
toolResult(call-write)
```

第二条 assistant 到达时，前一条 call 还没有 result。Runner 当场返回
`protocol/unpaired_tool_call`，不允许跨 assistant 补交。重复 call、孤立 result、重复
result、toolName 错配和结尾未配对都有各自固定 code。

扫描结束后，runner 再比较 active messages 与 Runtime result。工具协议完整但两份
transcript 不同，会得到 `protocol/result_session_mismatch`。Judge 不会看到这组互相冲突
的事实。

:::lab title="实践 14.2 · 分开 task verdict、judge 故障与 protocol 故障"
**目标：** 只有可信 active path 才进入 judge；合法任务拒绝与评测设施故障使用不同
status。

**文件：** `packages/pi-course/test-support/eval.ts`

**动作：**
1. 检查 verdict 形状，并要求 `passed === checks.every(Boolean)`。
2. 用固定 code 表示协议偏差，内部扫描 user、assistant 和 toolResult。
3. 在新 user 或 assistant 到达前检查未配对 call。
4. 核对 call/result 的 id、name、唯一性和最终配对状态。
5. 深比较 active-path messages 与 `result.messages`。
6. 所有 catch 分支只写 runner 定义的 phase/code，不复制异常正文。
7. 补齐这些分支后，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 14.2" \
  packages/pi-course/dist/test/14-*.test.js
```

**预期：** `3/3`，累计 `6/6`。三项覆盖 verdict、活动路径协议与固定失败分层。
:::

## SafeEvidence 从事实中计数，不转述事实

`write-answer` 的通过报告已经展示了 `SafeEvidence`。计数来源如下：

| evidence | 来源 |
|---|---|
| `messages.user/assistant/toolResult` | active path 中三种 canonical role |
| `tools.calls` | assistant content 中的 toolCall blocks |
| `tools.results/errors` | toolResult 总数与 `isError=true` 数量 |
| `files.requested/read` | case 声明数量与成功读取数量 |
| `checks.passed/failed` | 合法 verdict 的 boolean checks |

报告不包含 transcript、prompt、文件名、文件正文、临时路径、callId、tool arguments 或异常
文字。Runner 不会把 observation 放进报告，但 judge 已经拿到完整内容，也可以把它保存到
闭包、日志或外部系统。因此 judge 属于受信任的评测代码；递归 freeze 只阻止它改写本次
事实，并不提供数据隔离。调试正文留在受控本地环境，公共 `EvalReport` 仍维持这组固定
字段。

`EvalReport.id` 会公开，因此 case 作者也应把它当作普通标签，不能把 secret 或绝对路径
编码进 id。

## 清理故障追加在最早结果之后

假设 `write-answer` 的 judge 合法拒绝任务，随后 dispose 和 cleanup 都抛错。报告保留最
早得到的 task 事实：

```ts
{
  status: "task_failed",
  primaryFailure: { phase: "task", code: "task_rejected" },
  secondaryFailures: [
    { phase: "dispose", code: "dispose_failed" },
    { phase: "cleanup", code: "cleanup_failed" },
  ],
}
```

生命周期故障不能覆盖已有 primary。若主流程原本通过，`dispose_failed` 才成为 primary，
后到的 `cleanup_failed` 成为 secondary，status 改为 `infra_failed`。数组顺序就是实际
发生顺序。

这个规则依赖 `report` 在 try/finally 之间保持同一对象引用。主流程即使提前 return，
finally 仍能追加 dispose 和 cleanup 结果，然后 Promise 才把最终 report 交给调用者。

## Suite 等一个 case 完整收口再开始下一个

`runEvalSuite()` 使用普通 `for...of`：

```ts
const reports: EvalReport[] = [];
for (const evalCase of cases) {
  reports.push(await runEvalCase(evalCase));
}
return reports;
```

输入 `[alpha, beta, alpha]` 产生同顺序的三份报告。第一个 alpha 完成 cleanup 后，beta 才
prepare；最后一个 alpha 再次调用 prepare，示例 case 随之创建新环境。这里观察的是执行
顺序与 case 的隔离契约，并不测量并发吞吐。

:::lab title="实践 14.3 · 生成安全报告并保留生命周期因果"
**目标：** 让报告只携带计数与固定枚举，让第一次失败保持 primary，并让 suite 串行
运行每个 fresh case。

**文件：** `packages/pi-course/test-support/eval.ts`

**动作：**
1. 从 active path、文件读取进度和 verdict 计算 `SafeEvidence`。
2. 检查 report 只含 id、status、evidence、primary 和 secondary。
3. 实现 cleanup failure 追加规则，不覆盖已有 task/protocol/infra primary。
4. 主流程通过而 dispose 失败时，把 dispose 设为 primary。
5. 用 `for...of` 顺序实现 `runEvalSuite()`。
6. 删除 Lab 14.3 的显式异常，运行本段与全章公开测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 14.3" \
  packages/pi-course/dist/test/14-*.test.js
node --test packages/pi-course/dist/test/14-*.test.js
```

**预期：** 本段 `3/3`，公开测试 `9/9`。三项分别覆盖报告脱敏、主次故障和串行 suite。
:::

## 移除 transcript 交叉验证会制造假通过

正常链和三段实现已经完成，可以做一次定向故障注入。临时跳过：

```ts
if (!isDeepStrictEqual(activeMessages, result.messages)) {
  // protocol/result_session_mismatch
}
```

然后只运行：

```bash
node --test \
  --test-name-pattern="active path 拒绝不一致 transcript" \
  packages/pi-course/dist/test/14-*.test.js
```

测试中的 session 路径满足工具协议，Runtime 返回值却替换了最终 assistant。少了深比较，
runner 会继续读文件并调用 judge，测试因此变红。

:::failure title="预期失败 · Runtime 返回值与 session 路径分裂"
**第一次偏差：** protocol 阶段没有产生 `result_session_mismatch`，两份不同 transcript
进入同一个 task 判定。

**恢复：** 重新启用深比较，只重跑上面的单项。它回绿后，再确认公开测试 `9/9`。
:::

## 公开测试与真正的 held-out 检查

practice 目录只注入 `14-eval-capstone.test.ts` 的 9 项公开测试。官方 target 还保存 3 项
`capstone-held-out.test.ts` 回归，用新的实例检查同一套公开协议。它们在 reference target
上通过，证明 target 的实现满足这些回归；运行 reference target 不能证明你在 practice
目录写出的实现也通过。

针对学习者实现的 held-out 检查需要保持两个条件：测试实例在实现冻结后才产生，且测试
运行的正是那份冻结实现。只记录 `eval.ts` 的 hash 还不够，因为实际执行的是编译后的
JavaScript，`tsconfig`、导入的 `src/**`、依赖锁和旧 `dist` 都会改变结果。可以把下面的
迁移交给另一名 reviewer 或 Agent。

:::transfer title="Held-out 迁移 · 用未见过的 EvalCase 检查冻结实现"
1. 公开 `9/9` 后，把完整 practice workspace 连同 package 配置、依赖锁和 Node 版本做成
   独立快照；记录 source tree hash，停止在这份快照上修改。
2. 从该快照执行 clean build，记录生成的 `dist/test-support/eval.js` hash。source tree 与
   编译产物的两个 hash 共同标识被评实现。
3. 快照冻结以后，独立 reviewer 只根据公开的 `EvalCase`、protocol 和 report 契约生成
   新 case；它不读取 target `eval.ts`，实现者也不查看新 case。
4. Reviewer 在快照副本中运行这些 case，至少改变一次 prepare fixture、工具协议和
   “主流程失败后又出现生命周期故障”的组合；返回值只含通过数量、failure phase/code
   与两个 hash。
5. 任一源码、配置、依赖或产物 hash 改变，旧结果与旧 case 一并作废。修复后的实现重新
   建快照，再由 reviewer 生成另一批实例。

这个过程检验规则能否迁移到未见实例。自己写完 case 再运行仍是有价值的迁移练习，但
不属于 held-out。
:::

## 9 项公开测试固定到哪里

公开测试固定了：每次重新 prepare；prompt、flush、dispose、cleanup 的顺序；active path
和声明文件的观察范围；深复制与冻结；execute/collect 分层；verdict 校验；工具协议；
result/session 一致性；固定 failure；SafeEvidence；primary/secondary；串行 suite。

这九项证据也给 runner 划出三个范围：

- 它是进程内、受信任的评测 harness。Freeze 防止 judge 改写 observation，report 过滤原始
  内容；两者都不隔离 judge 的读取与外传，也不把任意远程 benchmark 变成安全输入。
- Runner 重新调用 prepare，并检查公开测试里的协议组合。真正的新目录、session 与
  Runtime 由 case 提供；`getActiveLeafId()` 抛错目前还会越过固定 failure 报告。
- 串行 suite 和 SafeEvidence 服务于可重复的正确性判断，不是性能基准或完整根因日志。
  Reference target 的 held-out 结果也只描述 target，学习者实现要走前面的冻结快照流程。

target 的 3 项 held-out 加上公开测试得到 Chapter 14 `12/12`，目标提交的课程全量是
`120/120`。这些数字是固定 reference snapshot 的回归证据。

:::pi title="与固定上游 Pi 的测试边界对照"
固定提交 `8479bd8` 的上游 Pi 在 agent loop、session、compaction 和产品入口附近分别有
专项测试。它们直接验证各自模块，没有本章这套 `EvalCase → EvalObservation →
TaskVerdict → EvalReport` 公共 runner。

课程把完整教学 Runtime 放进 `packages/pi-course/test-support/eval.ts`，增加 frozen
observation、固定 failure、SafeEvidence 和 held-out 方法。这个文件留在 test-support；
`src/composition.ts`、Agent 和工具实现保持第 13 章状态。
:::

## 本章验收

:::checkpoint title="Checkpoint 14 · 一个 passing case 有了完整证据链"
在隔离 practice 目录运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/14-*.test.js
```

结果应为公开 `9/9`。随后沿 `write-answer` 逐项指出：

1. 第一次和第二次 `prepare()` 分别创建了哪些新对象；
2. prompt、flush、active path、文件读取、judge、dispose、cleanup 的实际顺序；
3. sibling 为什么不在 observation，未声明文件为什么没有读取能力；
4. tool call/result 和两份 transcript 在哪里完成交叉验证；
5. passing verdict 怎样变成只含计数的 SafeEvidence；
6. 已有 primary 后出现 dispose/cleanup 故障时，report 怎样保留顺序。

故障注入恢复后，重新运行公开 `9/9`。若执行 held-out transfer，还要核对 source tree 与
编译产物的两个 hash 都和 reviewer 返回值相同。重新定位可运行
`npm run checkpoint -w @pi/course -- 14`；重做时新建 practice 目录，不复用已改过的
脚手架。
:::

## 小结

`write-answer` 每次从新的 `PreparedEval` 开始。Runner 调用 Runtime，读取活动路径和
声明文件，把深复制且冻结的 observation 交给 judge；合法 passing verdict 最后变成只含
固定计数的报告。

协议错误、任务拒绝和评测设施故障拥有不同 status。最早失败保持 primary，dispose 与
cleanup 只按发生顺序追加。`runEvalSuite()` 等一个 case 完整收口后再开始下一个。

这套 runner 没有进入产品核心。它站在第 13 章 Runtime 外面，用另一套代码检查运行结果
是否可信，也让整本教材最终拥有可重复的整机证据。
