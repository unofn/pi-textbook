---
id: "13"
slug: composition-root
part: product
partTitle: 第四部 · 从核心到产品
chapter: "13"
title: 把已有能力接成一个能提交历史的 Runtime
summary: 显式选择活动分支，恢复 Agent，在每次模型请求前统一构造上下文，并让 prompt 只有在新消息被 Session Store 接受后才完成。
minutes: 150
difficulty: 核心
artifact: packages/pi-course/src/composition.ts
prerequisites: 09,10,11,12
terms: composition root, runtime, active leaf, context projection, durability, poison state
upstream: packages/coding-agent/src/core/agent-session-runtime.ts
---

## 一次 `Runtime.prompt()` 到底什么时候完成

第 12 章结束时，组成 Agent 的部件已经分别可用：`Agent` 能运行多轮，Session Store 能
保存一棵历史树，`buildContext()` 能从活动路径派生有限输入，Resource Catalog 能生成
system prompt，Extension Host 能包住工具执行器。现在固定一次调用，把这些对象放到同一
条时间线上。

Runtime 从已有 session 的 `old-assistant` leaf 恢复：

```text
old-user                      user: 继续检查 parser
└── old-assistant             assistant: 我会先看现有实现
```

配置和依赖也固定下来：

```text
prompt             "检查 parser 并记录结论"
activeLeafId       "old-assistant"
configured prompt "BASE SYSTEM"
resources          AGENTS.md + inactive skill:review metadata
extension          review-policy
tool               review_note
```

`review-policy` 允许这次 `review_note`，并在结果返回后观察一次。模型第一次看到恢复历史和
当前 user message，随后产生 tool call；工具结果回到 transcript 后，模型第二次给出最终
回答。到这里 Agent loop 已经结束，但 `Runtime.prompt()` 还不能完成：

```text
Runtime.prompt("检查 parser 并记录结论")
  → 恢复 old-user → old-assistant
  → 第一次 context projection：旧路径 + 临时 user
  → model 返回 review_note tool call
  → review-policy before allow → core tool → after observe
  → 第二次 context projection：旧路径 + 本轮 user/call/result
  → model 返回最终 assistant
  → Agent.prompt() 完成
  → 只取本轮新增的四条 message
  → session.append(entry-1 user)
  → session.append(entry-2 assistant tool call)
  → session.append(entry-3 toolResult)
  → session.append(entry-4 final assistant)
  → active leaf 更新为 entry-4
  → Runtime.prompt() 才向调用者 resolve
```

这条调用给“完成”增加了一个产品语义：调用者拿到成功结果时，本轮 entries 已被当前
Session Store 接受并进入它的公开状态。若调用者提供持久 Store，下一次 Runtime 可以从
`entry-4` 恢复；本章不会把 append Promise 完成提升成 `fsync` 或崩溃耐久保证，
InMemory Store 也仍然只存在于进程内。

四个已有部件都不适合独自承担这项责任。Agent 不知道哪个 Session Store 属于当前产品；
Store 不知道哪条分支被用户选中；`buildContext()` 只读输入；Mode 只负责输出。把对象图、
顺序和生命周期接起来的地方叫 composition root，本章的具体实现就是 `createRuntime()`。

## 从四个独立部件进入一个 Runtime

同一个 `Runtime` 只创建一个 Agent，并保存调用者交进来的依赖身份：

```text
RuntimeConfig                         RuntimeDeps
  activeLeafId                         model
  systemPrompt                         tools
  maxSteps                             session
  context budget                       resources
                                       extensionHost
                                       createId / now
           │                               │
           └──────── createRuntime ────────┘
                              │
                              ▼
                         一个 Runtime
                   ┌──────────┼──────────┐
                   ▼          ▼          ▼
                control     prompt     session/resources/extensions
```

`Runtime.control` 只转发 `getState()`、`subscribe()`、`steer()`、`followUp()` 和 `abort()`，
不暴露 Agent 的 `prompt()`。新请求只能从 `Runtime.prompt()` 进入，否则调用者可以得到模型
结果却跳过持久化。

对象之间的责任保持原样：

| 对象 | 继续拥有的事实 |
|---|---|
| Session Store | 已提交的 entry 和追加顺序 |
| `buildContext()` | 本次模型能看到的有限投影 |
| Agent | canonical transcript 和当前运行状态 |
| Extension Host | 工具调用前后的策略与观察 |
| Runtime | leaf 选择、对象接线、prompt 串行化、Store 提交与关闭 |
| Mode | 一次输入和一次输出的编码 |

第 13 章没有把 session、context 或 extension 逻辑搬进 Agent。它只给 Agent 增加一个
`initialMessages` 接缝，再在 `composition.ts` 中建立上述关系。

## 建立练习起点

在教学历史仓库中生成隔离练习：

```bash
cd <你的工作区>/pi-course
npm run checkpoint -w @pi/course -- 13
npm run practice -w @pi/course -- 13 <新目录>
cd <新目录>
npm install
```

本章只修改：

```text
packages/pi-course/src/agent.ts
packages/pi-course/src/composition.ts
```

`agent.ts` 只增加初始历史注入；其余实现都留在 composition root。

:::rebuild title="Checkpoint 13 · 让一次 prompt 在 Store 提交后完成"
**模式：** 重建。从第 12 章 target 开始，增加 Runtime 组合边界与 Agent 的历史注入接缝。

**起终点：** `parent` `03541892bcd533444af599d1813401f79807de3c` 是起点；`target` `1caf1082b3f92504346bbeda969e4cfbb0f8f636` 是终点。

**教学文件：** `packages/pi-course/src/agent.ts`、
`packages/pi-course/src/composition.ts`

**学习脚手架：** `starters/13-composition.ts` 已固定 Runtime、context adapter 与 Mode 的
公共类型。`RuntimeImpl.prompt/flush/dispose` 会继续停在 Lab 13.3，前两个 Lab 不需要提前
实现持久化。

**动手前只需知道：** 非空 session 由调用者显式给出 leaf；Agent 结束后只取本轮新增
suffix；Runtime 等这些消息全部 append 后才完成 prompt。

**第一步：** 给 Agent 加入 `initialMessages` 深复制，再让 `createRuntime()` 恢复指定
active path，创建一个 Agent 和一个不暴露 prompt 的 control。

**第一次红灯：** fresh starter 可以 build；只运行 Lab 13.1 时，两项都应显示
`Lab 13.1 createRuntime 尚未实现`。

**聚焦测试：** `packages/pi-course/test/13-composition-modes.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 13`

**练习目录：** `npm run practice -w @pi/course -- 13`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/13-*.test.js`。

**施工顺序：** Runtime 恢复 `2/2` → context adapter `3/3` → prompt 持久化与生命周期
`3/3` → Mode 呈现 `2/2`。

**通过证据：** 四个 Lab 可独立运行，失败注入能被现有测试捕获，最后本章 `10/10`。

第一次尝试先不看 target diff。只比较当前 Lab 的对象、时序和第一个可观察偏差。
:::

验证起点：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 13.1" \
  packages/pi-course/dist/test/13-*.test.js
```

正确结果是 `0/2` 和准确的 starter 错误。若 build 失败，先检查 practice 是否从正确 parent
生成。

## Lab 13.1：从指定 leaf 恢复唯一 Agent

先只创建对象，不调用开篇的 prompt。`RuntimeConfig.activeLeafId` 是必填的 nullable 字段：

```ts
interface RuntimeConfig {
  activeLeafId: string | null;
  systemPrompt?: string;
  maxSteps?: number;
  context: ContextBudget;
}
```

`null` 只表示“这是空 session 的新会话”，不表示“替我猜一个 leaf”。四种组合只有两种
成功路径：

```text
entries 为空 + activeLeafId === null    → []
entries 为空 + activeLeafId 是字符串    → 拒绝，不存在这条 leaf
entries 非空 + activeLeafId === null    → 拒绝，调用者没有选择分支
entries 非空 + activeLeafId 是字符串    → pathTo(entries, activeLeafId)
```

固定 session 若同时有 `old-user → left` 和 `old-user → old-assistant`，配置选择
`old-assistant` 就只恢复右侧路径。物理最后一行没有选择权；第 10 章的 `pathTo()` 已经
拥有 duplicate id、缺失 parent 与所选祖先链的 cycle 诊断，Runtime 不重新实现 parent
遍历。

选出的 path 还包含 metadata 或 compaction。Agent 初始 transcript 只接收其中的 message：

```text
selected path
  → 过滤 type === "message"
  → 深复制每条 AgentMessage
  → new Agent({ initialMessages })
```

为此，Agent 增加唯一的新选项：

```ts
interface AgentOptions {
  model: Model;
  tools: ToolRegistry;
  toolExecutor?: ToolExecutor;
  initialMessages?: readonly AgentMessage[];
  systemPrompt?: string;
  maxSteps?: number;
}
```

构造函数用 `structuredClone()` 初始化 state。只复制 messages 数组会继续共享
`content[0]`、tool arguments 和 result details；Store 返回值随后被修改时，Agent 历史也
会被污染。

`createRuntime()` 返回的依赖身份保持不变：

```text
runtime.session    === deps.session
runtime.resources  === deps.resources
runtime.extensions === deps.extensionHost
```

这让调用者观察到的 Store、catalog 和 extension host 就是 Agent 真正使用的对象图。

:::lab title="实践 13.1 · 恢复 active path 并建立 Runtime 外壳"
实现 `AgentOptions.initialMessages`、Agent 构造时深复制、session 选择 helper、Runtime
control 和 `createRuntime()` 的恢复部分。`Runtime.prompt/flush/dispose` 暂时保留 Lab 13.3
异常，也不调用 `buildContext()`。

最小控制流是：读取 `session.entries()` → 验证空/非空与 leaf 的组合 → 调用 `pathTo()` →
投影 message 深副本 → 创建一个 Agent → 返回持有原依赖的 Runtime 外壳。

运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 13.1" \
  packages/pi-course/dist/test/13-*.test.js
```

`2/2` 要证明：空 session 只接受 null leaf；非空 session 必须显式选择；Agent 只恢复所选
分支且不共享嵌套消息；`runtime.control` 没有 `prompt`；三个公开依赖保持原对象身份。
:::

## Lab 13.2：每次模型请求都投影当前路径与临时 suffix

Runtime 已从 `old-user → old-assistant` 恢复两条 message。现在开篇 prompt 进入 Agent，
第一次调用 model 时，Agent context 中有三条消息：

```text
[old user, old assistant]  已持久化 prefix
[current user]             尚未持久化 suffix
```

`buildContext()` 接收的却是 `SessionEntry[]`，而 current user 还没有 entry id。Model adapter
在内存中为 suffix 构造临时 entry：

```text
old-user → old-assistant → __runtime_context_0
                                  current user
```

临时 id 只服务这一次 model request，不写 Store，也不调用 `deps.createId()`。若固定 id 与
active path 冲突，就在前面继续加 `_`，直到逻辑身份唯一。

Adapter 每次 `stream()` 都读取：

```ts
interface ContextProjectionSnapshot {
  activePath: readonly SessionEntry[];
  persistedMessageCount: number;
}
```

`persistedMessageCount` 是 active path 中已经提交的 message 数，不是 path 总长度；metadata
与 compaction 不计入。它必须是整数，并满足：

```text
0 <= persistedMessageCount <= context.messages.length
```

范围合法还不够。Composition root 同时维护另一条不变量：

```text
context.messages.slice(0, persistedMessageCount)
  ≡ activePath 中 message entry 的消息投影
```

Target 的 adapter 信任 Runtime 保持这条前缀对齐关系，只检查 count 的范围；它不会逐条
比较两侧消息。单独调用这个公开 adapter 时，调用者也要承担同一前置条件。

当前 suffix 正是：

```ts
context.messages.slice(snapshot.persistedMessageCount)
```

第二次 model request 发生在整个 Agent run 尚未提交到 Session Store 时。此时 suffix 已
增长为 current user、assistant tool call 和 toolResult。Adapter 再读一次 snapshot，把这
三条临时接到同一 active leaf，`buildContext()` 才能看到完整工具 interaction。

```text
model request 1: persisted path + user
model request 2: persisted path + user + assistant(toolCall) + toolResult
```

捕获 Runtime 创建时的旧 snapshot 会让第二个 prompt 继续使用过时 leaf，也会把已经提交
的消息误当 suffix。`getSnapshot()` 因此在每次 `stream()` 时调用。

投影只有一个入口：

```ts
const projected = buildContext(entries, {
  maxTokens: config.context.total,
  reservedOutput: config.context.reservedOutput,
  safetyMargin: config.context.safetyMargin,
  systemPrompt: config.systemPrompt,
  estimateTokens: config.context.estimateTokens,
});
```

Inner model 得到 `projected.messages` 与 `projected.systemPrompt`。Tools 深复制后继续传递；
`AbortSignal` 保持同一对象，取消链才能贯穿 Agent 与 provider。

:::lab title="实践 13.2 · 构造每次 model request 的 context"
只实现临时 entry helper 和 `createContextProjectingModel()`，先直接测试 adapter，不接
Runtime 持久化。

控制流是：读取最新 snapshot → 验证 persisted count → 深复制 active path → 从 Agent
messages 取得未持久化 suffix → 串成临时 entries → 调用唯一 `buildContext()` → 把投影
messages、system prompt、tools 副本和同一 signal 交给 inner model。

运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 13.2" \
  packages/pi-course/dist/test/13-*.test.js
```

`3/3` 分别证明：临时 user 接到旧路径且输入修改不影响 inner request；固定成本先扣除，
预算只保留完整的最新 interaction；tools 等值但不共享引用，signal 保持同一身份。

若 adapter 自己 `slice(-N)`、丢掉 tools、创建新 AbortController，或把临时 entry 写进
session，就已经出现第二套上下文或生命周期规则。
:::

## Lab 13.3：把资源、Extension、Agent 与 Session Store 接成一次调用

回到开篇的 `review-policy` 请求。`createRuntime()` 先准备 Agent 的两个输入。

System prompt 按固定顺序合并：

```text
BASE SYSTEM

# Pi resources
PROJECT RULE
review: Review code carefully
```

配置文字在前，`formatResourceContext(resources, [])` 的结果在后。当前 Runtime 只接
catalog 的静态 resource context：API 没有 ActivatedSkill 参数，因此这里只有 instructions
和 Skill metadata，inactive `review` 正文不会出现。`activateSkill()` 的结果和
`renderTemplate()` 生成的 UserMessage 也不是 Runtime 输入；调用者可以先 render，再把文本
交给 `prompt()`，但 target 不会保存 template identity。Catalog 为空时不调用 formatter，
以免制造空的 `# Pi resources`；两部分都为空时 system prompt 是 `undefined`。

工具也只有一个执行入口：

```ts
const coreExecutor: ToolExecutor = (call, context) =>
  executeToolCall(call, deps.tools, context);

const toolExecutor = deps.extensionHost
  ? deps.extensionHost.wrapExecutor(coreExecutor)
  : coreExecutor;
```

Agent 看到的 tool schema 与 core executor 使用同一个 `ToolRegistry`。Extension Host 包在
executor 外层，而不是只挂在 `runtime.extensions` 字段供人查看。

最终对象图是：

```text
inner model → context projecting model ─┐
                                        ├→ 一个 Agent
ToolRegistry → core executor → hooks ──┘
                         │
selected path + Session Store ← Runtime
```

### 新消息从哪个位置开始

Agent state 已经含有 `old-user` 与 `old-assistant`。当前排队操作真正开始时，Runtime 记录：

```ts
const beforeCount = this.agent.getState().messages.length;
const result = await this.agent.prompt(value);
const suffix = result.messages.slice(beforeCount);
```

若开篇 run 产生 user、assistant tool call、toolResult、final assistant，suffix 就是这四条，
恢复历史不会被再次写入。

`beforeCount` 不能在调用 `Runtime.prompt()` 的瞬间读取。两个 prompt 几乎同时到达时，第二
个调用尚未等到第一轮更新 Agent；二者会得到相同旧长度。它要等到当前 operation 真正从
Runtime 队列开始时再读取。

### 每次 append 成功后推进 leaf

Runtime 为 suffix 逐条创建 message entry：

```text
entry-1.parentId = old-assistant
entry-2.parentId = entry-1
entry-3.parentId = entry-2
entry-4.parentId = entry-3
```

每条 entry 使用 `deps.createId()`、`deps.now()` 和 message 深副本。顺序固定为：

```text
await session.append(entry)
  → activePath.push(entry copy)
  → persistedMessageCount += 1
  → activeLeafId = entry.id
```

Store 确认成功前不推进内存 leaf。四条全部完成后，Runtime 返回 `AgentRunResult` 的深副本，
开篇调用才真正完成。

### 两个 prompt 共用一条 operation queue

第 09 章的 Agent 拒绝并行 prompt。Runtime 用一条 Promise tail 把并发调用按接收顺序串行：

```text
operation = operationTail.then(runAgentAndPersist)
operationTail = operation.then(
  () => undefined,
  () => undefined,
)
return operation
```

内部 tail 只负责让下一项继续排队；公开 operation 仍把当前错误交还调用者。第二项开始时
再读取 `beforeCount`，所以它只持久化自己的 user 与 assistant。

### 部分提交后 Runtime 不能继续

正常调用已经闭合，现在再看 append failure。假设 `entry-1` 成功，`entry-2` 的 Store
append 抛出 `diskError`。Agent 内存已经拥有完整回答，session 却只拥有本轮第一条消息；
Runtime 无法把两者当成同一完成状态。

第一次 persist 错误会保存：

```text
poisoned = true
poisonCause = diskError
```

这次 prompt、已排队但尚未开始的 prompt，以及后续 `prompt()`、`flush()` 都得到同一个
`poisonCause`。后续调用不再进入 model 或 Store。Runtime 不自动重试，因为底层失败时
无法证明一次写入完全没有发生。

### `flush()` 与 `dispose()` 等待哪些工作

`flush()` 等待当前 operation tail，然后检查 poison；它不创建新任务。

`dispose()` 在调用时关闭新的 prompt 入口，但会等待此前已经接受的 operation。一个 prompt
即使仍在队列里、尚未进入 Agent，也属于已接受工作。重复 `dispose()` 返回同一个 Promise：

```text
prompt 1 正在向 Store 提交
prompt 2 已排队
dispose()
prompt 3 到达 → 立即拒绝

prompt 1 提交完成 → prompt 2 运行并提交 → dispose 完成
```

:::lab title="实践 13.3 · 完成 Runtime.prompt 的接线与生命周期"
实现 system prompt 合并、最终 model/executor 接线、`RuntimeImpl.persist()`、
`prompt()`、`flush()`、`dispose()`，以及 active path、message count 与 leaf 更新。

主控制流是：调用时拒绝 disposed/poisoned → 把 operation 放入 tail → operation 开始时再
检查 poison 并读取 beforeCount → await Agent → 只取 suffix → 逐条 await append 并推进
leaf → 全部成功后返回结果副本。

运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 13.3" \
  packages/pi-course/dist/test/13-*.test.js
```

`3/3` 覆盖三组事实：resources 按顺序进入 system prompt、inactive body 不出现、Extension
确实包住 executor，两个 prompt 等 Store 接受后串行 resolve；恢复历史不重复追加，第二次 append
失败后保存同一 poison cause；`flush()` 等队列，`dispose()` 保留调用前已接受工作并永久
关闭入口。
:::

## 用现有测试破坏一次 poison 规则

:::failure title="失败注入 · 忘记 append failure 已使 Runtime 不一致"
Lab 13.3 通过后，临时删掉 `persist()` catch 中保存 poison 的两行，只保留
`throw error`：

```ts
catch (error) {
  // this.poisoned = true;
  // this.poisonCause = error;
  throw error;
}
```

运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 13.3 · 只追加恢复历史之后的新 suffix" \
  packages/pi-course/dist/test/13-*.test.js
```

第一次 append failure 仍会返回，但第二次 prompt 会再次进入 model 或 Store。恢复 poison
赋值后，同一测试应回绿：model request 保持一次，Store append 保持两次，后续 prompt 和
flush 都得到原始 `diskError`。恢复实验时撤销这两行改动；自动重试无法判断底层 append
是否已经部分发生，因此不是这里的恢复手段。
:::

## Lab 13.4：Mode 只改变输出编码

`interactive`、`print` 和 `json` 不创建三套 Runtime。它们都借用同一个接口：

```ts
async function runMode(
  runtime: Runtime,
  mode: "interactive" | "print" | "json",
  prompt: string,
  io: ModeIO,
): Promise<AgentRunResult>
```

对开篇 prompt，interactive 与 print 都写最后一条 assistant 的文本；JSON 写一条带换行的
对象：

```json
{"reason":"stop","steps":2,"messages":[...]}
```

完整顺序是：

```text
验证 mode
  → await runtime.prompt(prompt)       恰好一次
  → interactive / print：最后一条 assistant 的 textOf()
  → json：JSON.stringify({ reason, steps, messages }) + "\n"
  → await io.write(output)
  → 返回 result 深副本
```

未知 mode 在调用 Runtime 前失败。若 Runtime 已完成 Store 提交、`io.write()` 随后抛错，输出错误
原样上抛，但 session 不回滚；模型与持久化已经是事实，屏幕或输出 sink 属于呈现边界。

当前 Mode 只是最小 adapter。它没有版本号、sequence、stderr、exit code、配置解析或完整
交互 UI，这些也不属于本章 10 项测试。

:::lab title="实践 13.4 · 让三个 Mode 共用 Runtime.prompt"
这一 Lab 的施工范围只有 `finalAssistantText()` 与 `runMode()`；Agent、Store、Resource
Catalog 和 Extension Host 继续使用现有 Runtime 提供的对象。

运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 13.4" \
  packages/pi-course/dist/test/13-*.test.js
```

`2/2` 要证明：interactive 与 print 每次只调用一次 prompt 并写最终 assistant 文本；JSON
只改变呈现并带尾随换行；未知 mode 的 prompt 次数为零；输出 sink 的原始 Error 不被包装。
:::

## 十项测试固定了哪些边界

| Lab | 数量 | 可观察事实 |
|---|---:|---|
| 13.1 | 2 | 空 session、显式 leaf、活动路径深复制、唯一 Runtime/control |
| 13.2 | 3 | 临时 suffix、预算投影、tools/signal 与输入隔离 |
| 13.3 | 3 | resources/extension 接线、串行 Store 提交、suffix、poison、flush/dispose |
| 13.4 | 2 | 最终文本、JSON 换行、未知 mode、输出错误 |

全章运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/13-*.test.js
```

再运行当前练习目录全部课程测试：

```bash
node --test packages/pi-course/dist/test/*.test.js
```

这 `10/10` 把课程 Runtime 固定在三个范围内：

- 每个实例用一条队列向调用者提供的 Store 提交 suffix。跨进程协调、fsync 与崩溃耐久
  取决于更外层的 Store 实现。
- Context adapter 使用本章的确定性 token 估算器，并信任 composition root 维护 message
  prefix 与 active path 对齐；测试直接检查 count 范围，没有逐条复核这个前缀不变量。
- Runtime 只管理当前 session、已加载的 ExtensionHost 和三种最小输出 Mode。Session
  切换、Extension reload、自动 compaction 与完整 CLI/RPC 协议属于下一层产品生命周期。

## 课程 Runtime 与真实 Pi 的关系

:::pi title="Pi 对照 · 生产对象图拆在 AgentSession 与 AgentSessionRuntime 中"
固定提交 `8479bd8` 中，课程 `Runtime` 的职责没有集中在一个同名类里。

`AgentSession` 持有 Agent、SessionManager、ResourceLoader 与 ExtensionRunner。它从
ResourceLoader 重建 system prompt 与 skills/context files，把 Extension 的
`tool_call/tool_result` hooks 接入 Agent，并在 `message_end` 事件到达时调用
`SessionManager.appendMessage()`。因此生产实现是消息完成一条便持久化一条，不采用课程
“Agent run 完成后切 suffix，再逐条 append”的教学结构。

`AgentSessionRuntime` 主要拥有当前 `AgentSession` 及其 cwd-bound services。它在
new/resume/fork/import 时先发送 shutdown、失效旧 session，再用同一个 factory 创建并绑定
新 session；`dispose()` 也先通知 Extension，再释放当前 session。它不是课程
`Runtime.prompt()` 队列与 poison 状态机的逐行对应物。

课程把 leaf 选择、context adapter、suffix 持久化和三种 Mode 压进 10 项黑盒测试，是为了
清楚观察唯一负责人和完成时点。迁移到生产 Pi 时应保留这些问题的答案，而不是复制课程
的类名和私有 helper。
:::

## 完整对象图与本章验收

本章验收不仅是一行 `pass`。用同一个 prompt 复述：

1. `activeLeafId: "old-assistant"` 为什么只恢复该祖先链；
2. 第一次 model request 为什么包含临时 user，第二次为什么还包含 call/result；
3. `BASE SYSTEM`、resource context 和 Extension-wrapped executor 分别接在哪里；
4. `beforeCount` 为什么在 operation 开始时读取；
5. 四条新 message 怎样形成从旧 leaf 到 `entry-4` 的 parent chain；
6. 为什么 `Agent.prompt()` 完成后，Runtime 仍要等待第四次 append；
7. dispose 前已排队的 prompt 与 dispose 后到达的 prompt 有什么不同。

验收记录可写成：

```text
Lab 13.1: 2/2
Lab 13.2: 3/3
Lab 13.3: 3/3
Lab 13.4: 2/2
fault injection: poison test red
fault restored: Lab 13.3 green
chapter total: 10/10
```

:::checkpoint title="Checkpoint 13 · prompt 完成意味着 Store 已接受新事实"
**完成状态：** 非空 session 显式选择 leaf，Agent 从该路径恢复。每次模型请求把未持久化
suffix 临时接到当前 path，并通过唯一 `buildContext()` 投影。

**提交状态：** Runtime 串行接受 prompt，只追加本轮 suffix；Store 成功后才推进 leaf；
全部新增消息被当前 SessionStore 接受后才 resolve。跨进程恢复需要调用者提供持久 Store，
这里没有增加 fsync 或崩溃耐久保证。Persist 失败保存同一 poison cause，后续模型与 Store
不再运行。

**入口状态：** `flush()` 等待当前队列；`dispose()` 关闭新入口并等待已接受任务；三种
Mode 只调用一次 Runtime.prompt，只改变输出编码。

**公开证据：** `2/2 → 3/3 → 3/3 → 2/2`，共 `10/10`。

**恢复：** 回到 parent `03541892bcd533444af599d1813401f79807de3c` 后，Agent、session、
context、resources 与 extension 仍可独立运行，但不再有统一的恢复、投影和提交负责人。
:::

:::transfer title="迁移练习 · 增加一个不写 stdout 的 library adapter"
完成 `10/10` 后，在独立练习文件写 `runLibrary(runtime, prompt)`。它只调用一次
`runtime.prompt()`，返回 `{ reason, text }`，其中 text 来自最后一条 assistant。

用 fake Runtime 固定三个例子：正常结果只调用一次；两条 assistant 只取最后一条；prompt
抛出的原始 Error 不被改写。核心 `agent.ts`、`session.ts` 与 `composition.ts` 都不增加
library 分支。
:::

## 小结

开篇 prompt 从 `old-assistant` leaf 恢复，经过两次 context projection 和一次完整工具
往返，最终产生四条新消息。Runtime 逐条 append，并把 active leaf 推进到 `entry-4`；最后
一条确认后，调用者才拿到成功结果。

Context adapter 让同一 run 中尚未持久化的 user、call 与 result 也能进入下一次模型请求。
资源文字、Extension executor、Agent 和 Session Store 都只接入这一份对象图。并发 prompt
按队列串行，持久化失败后 Runtime fail-closed，dispose 则等完已接受工作。

Interactive、print 和 JSON 只是这个 Runtime 的三种消费者。第 14 章将从更外层准备案例、
执行完整 Agent、收集证据并判断结果，不再进入 Runtime 内部替它补生命周期规则。
