---
id: "11"
slug: context-compaction
part: state
partTitle: 第三部 · 让 Harness 可靠
chapter: "11"
title: 历史不动，上下文按预算重建
summary: 把工具往返组成不可拆分的交互，在预算内选择完整后缀，并用追加的结构化摘要恢复更早事实。
minutes: 145
difficulty: 核心
artifact: packages/pi-course/src/context.ts
prerequisites: 03,10
terms: history, context projection, token budget, interaction boundary, compaction
upstream: packages/coding-agent/src/core/compaction/compaction.ts
---

## 同一段历史会产生一份更短的模型输入

第 10 章最后得到的是一条 active path。这里沿用这个输入接口，但换成一组便于手算预算
的十条 message entries：开头一条 system message，后面九条对话。表中最后一列是测试
估算器给每条消息返回的 token 数，不是真实 provider 的 tokenizer 结果。

| entry id | message | 估算 token |
|---|---|---:|
| `sys` | system：基础 prompt `sys` | 3 |
| `u1` | user：检查 session 恢复逻辑 | 3 |
| `a1` | assistant：活动路径只恢复选中分支 | 4 |
| `u2` | user：确认 JSONL 写入边界 | 3 |
| `a2` | assistant：换行提交，未提交尾部只读恢复 | 4 |
| `u3` | user：读取实现并运行聚焦测试 | 3 |
| `calls` | assistant：调用 `read-1` 和 `test-1` | 3 |
| `r-test` | toolResult(`test-1`)：14 tests passed | 3 |
| `r-read` | toolResult(`read-1`)：context.ts loaded | 3 |
| `a3` | assistant：实现与测试一致 | 3 |

`calls` 先声明 `read-1`，随后声明 `test-1`。测试先完成，所以 `r-test` 在路径中排在
`r-read` 前面。每个 result 仍可通过 `toolCallId` 找回自己的 call。

`groupInteractions()` 跳过 `sys`，以 user 消息为起点，把其余九条记录分成三组：

```text
group 1 = [u1, a1]
group 2 = [u2, a2]
group 3 = [u3, calls, r-test, r-read, a3]
```

第三组包含 user、两个 tool call、两个 result 和最终 assistant。它是预算可以整体保留
或整体丢弃的最小单位。result 的出现顺序不影响配对，也不会把这一组拆开。

现在把这条活动路径交给 `buildContext()`。例子中的 `maxTokens` 是 31；重放出的 system
message 占 3，回答预留 4，安全余量占 2。消息还剩 22。三组成本依次为 7、7、15，所以
函数从最新一组向前选择，结果正好保留第二、三组。返回的 `messages` 依次是：

```text
system("sys") → u2 → a2 → u3 → calls → r-test → r-read → a3
```

其余字段是：

```ts
{
  keptEntryIds: [
    "u2", "a2",
    "u3", "calls", "r-test", "r-read", "a3",
  ],
  reason: "trimmed",
  tokens: {
    maxTokens: 31,
    system: 3,
    messages: 22,
    reservedOutput: 4,
    safetyMargin: 2,
    availableForMessages: 22,
    total: 31,
  },
}
```

`sys` 排在 `messages` 最前面，却不在 `keptEntryIds` 里；它不属于任何一组，后文再解释。
`u1` 和 `a1` 仍在 session 中，只是没有进入这次模型请求。这里的有限消息数组叫
context projection，也就是从历史派生出的临时视图。换一个模型窗口或预留量，同一段
历史可以得到另一份视图。

:::rebuild title="Checkpoint 11 · 从固定 transcript 派生有限上下文"
**模式：** 重建

**起终点：** `parent` `4f5de3800ed6e68561c33ad4a3e753cf524e8495` 是第 10 章完成后的起点；
`target` `19d902b4e18abd42018f30eb01a47cf04a7119de` 是 compaction 记录、上下文投影和
15 项聚焦测试完成后的终点。

**教学文件：** `packages/pi-course/src/session.ts`、
`packages/pi-course/src/context.ts`

**学习脚手架：** parent 中还没有 `context.ts`。practice 会加入
`starters/11-context.ts`，并用 `starters/11-session.ts` 保留第 10 章能力。公共类型和
函数签名已经固定；五个 Lab 的分支分别抛出明确异常。

**动手前只需知道：** user message 开始一个 interaction，直到下一条 user message；
组内每个 tool call 都由 `toolCallId` 找到唯一 result。预算只在这些完整组之间裁剪。
system message 不属于任何组，它们被重放成结果最前面的一条。

**第一步：** 先不看 target diff，让 `parseSessionEntry()` 收窄一条正常的 compaction
记录，并让两种 Store 写入、读回它。预算选择留到后面的 Lab。

**第一次红灯：** 初始 build 可以通过。只运行 Lab 11.1 时，三项测试都停在
`Lab 11.1 compaction entry 尚未实现`。

**聚焦测试：** `packages/pi-course/test/11-context-compaction.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 11`

**练习目录：** `npm run practice -w @pi/course -- 11`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/11-*.test.js`

**通过证据：** 15 项测试按 `3/3 → 3/3 → 3/3 → 2/2 → 4/4` 覆盖记录解析、
交互分组、预算投影、摘要创建、重复恢复和跨 compaction 的 system 重放。
:::

## 摘要先成为 session 中的一条普通事实

当较早的消息以后不再原样进入模型窗口，session 需要留下它们的结构化摘要。摘要不是
对原记录的覆盖；它是一条追加到当前 leaf 后面的 `CompactionSessionEntry`：

```ts
interface CompactionSessionEntry {
  id: string;
  parentId: string;
  timestamp: number;
  type: "compaction";
  summary: CompactionSummary;
  firstKeptEntryId: string;
  tokensBefore: number;
}
```

继续使用开篇路径，可以创建 `compact-1`，让它的 `parentId` 指向当前末尾 `a3`。
`firstKeptEntryId: "u2"` 表示恢复时从第二组开始保留原消息。`tokensBefore` 由调用者
写入，用来记录压缩前的估算规模；parser 只检查它是非负有限数，不会重新估算并核对该值。

`summary` 的七个字段分别保存目标、约束、已完成事项、决策、变更文件、未解决事项和
下一步：

```ts
interface CompactionSummary {
  goal: string;
  constraints: string[];
  completed: string[];
  decisions: string[];
  changedFiles: string[];
  unresolved: string[];
  next: string[];
}
```

`parseSessionEntry()` 逐字段读取外部对象。`goal`、`parentId` 和
`firstKeptEntryId` 不能为空；数组中的每一项都是字符串；`tokensBefore` 是非负有限数。
解析器返回新对象，因此调用者之后修改 summary 数组也不会改动 Store 中的记录。

第 10 章的两个 Store 已经统一通过 `parseSessionEntry()` 获取写入快照。union 和解析
分支补齐后，`InMemorySessionStore` 与 `JsonlSessionStore` 不需要新增 compaction 专用
写入代码。JSONL 重新打开时，同一条解析路径会恢复 `compact-1`。

:::lab title="实践 11.1 · 保存并重开一条 compaction 记录"
**目标：** 让结构化摘要经过运行时收窄后进入两种 Store，并保持副本隔离。

**文件：** `packages/pi-course/src/session.ts`

**动作：**
1. 确认 `CompactionSummary`、`CompactionSessionEntry` 和 `SessionEntry` union 的形状。
2. 为七个 summary 字段实现严格解析。
3. 在 `parseSessionEntry()` 中读取非空 parent、first kept 和非负有限 tokens。
4. 让解析结果与输入的 summary、数组都不共享引用。
5. 用测试中的正常记录检查内存写入、JSONL 写入和重新打开。
6. 删除 Lab 11.1 的显式异常，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 11.1" \
  packages/pi-course/dist/test/11-*.test.js
```

**预期：** `3/3`。第三项确实关闭并重新打开 JSONL Store，不只检查 TypeScript 类型。
:::

## 两个 tool result 仍属于 `u3` 开始的同一组

`groupInteractions()` 接收活动路径中的 message entries。它先遇到 `sys`：system
message 记录的是 prompt 状态，不属于对话中的任何一组，函数直接跳过。随后它遇到 `u1`
时创建第一组，遇到 `u2` 时结束第一组并创建第二组，遇到 `u3` 时做同样的事。路径结尾
再结算第三组。system message 出现在两组之间时也一样跳过，不会切开或混入哪一组。

组内的工具事实靠 id 核对。处理 `calls` 时，函数记录 `read-1` 和 `test-1`；处理
`r-test`、`r-read` 时，它读取各自的 `toolCallId`。所以结果反序出现仍然合法，返回的
entries 保持原路径顺序：

```text
[u3, calls, r-test, r-read, a3]
```

分组函数保留 `r-test`、`r-read` 的原路径顺序，同时在这个 user group 内核对四个对象
关系：每个 `call.id` 只声明一次；每条 result 的 `toolCallId` 都能在组内找到对应 call；
一个 call 至多对应一条 result；group 结束时，所有 call 都已经配齐 result。这些关系只
依赖 id 集合，所以反序完成的两个 result 仍能组成同一组。`a3` 是这个 fixture 的终态
回答，也按原位置留在组中。

预算层之所以使用 group，而不是直接使用 message，是因为裁剪位置只能落在 `a1/u2`
或 `a2/u3` 之间。落在 `calls/r-test`、`r-test/r-read` 或 `r-read/a3` 之间都会丢掉一次
工具往返的一部分。

:::lab title="实践 11.2 · 用 user 边界和 callId 组成 interaction"
**目标：** 把开篇 transcript 分成三个可整体选择的组，同时保留工具结果的实际顺序。

**文件：** `packages/pi-course/src/context.ts`

**动作：**
1. 跳过 system message；user message 到达时结算上一组并开始新组。
2. 从 assistant content 中收集本组的 tool call id。
3. 用 `toolCallId` 配对 result，不依赖相邻位置或完成顺序。
4. 组结束时确认 call/result 完整且唯一。
5. 通过 `parseSessionEntry()` 或等价严格边界返回深副本。
6. 删除 Lab 11.2 的显式异常，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 11.2" \
  packages/pi-course/dist/test/11-*.test.js
```

**预期：** `3/3`。正常分组与反序 result 各有一项；第三项集中检查损坏的工具事实。
:::

## 31 个 token 怎样留下第二、三组

`buildContext()` 不负责从整棵 session tree 选择 leaf。调用者先用第 10 章的 `pathTo()`
得到活动路径，再把这条路径和预算选项传进来：

```ts
buildContext(activePath, {
  maxTokens: 31,
  reservedOutput: 4,
  safetyMargin: 2,
  estimateTokens,
});
```

选项里没有 prompt 字段。system prompt 已经写在 active path 里，`buildContext()` 自己从
路径中取出它：

```ts
function replayedSystemMessage(
  activePath: readonly SessionEntry[],
): SystemMessage | undefined {
  return currentSystemMessage(
    activePath.flatMap((entry) =>
      entry.type === "message" ? [entry.message] : []
    ),
  );
}
```

`currentSystemMessage()` 是第 03 章的重放函数：非空 `content` 依次追加，`sections` 按名字
覆盖，`null` 删除段落。开篇路径只有 `sys` 一条，重放结果就是它本身。估算器把这条
重放出的消息当作一条普通消息计价，得到 3，记入 `tokens.system`。路径上没有 system
message 时，这一项为 0，结果里也没有开头的 system。

这个例子的扣除过程可以直接列成表：

| 项目 | token | 扣除后的消息额度 |
|---|---:|---:|
| `maxTokens` | 31 | 31 |
| 重放出的 system message | 3 | 28 |
| `reservedOutput` | 4 | 24 |
| `safetyMargin` | 2 | 22 |

`reservedOutput` 给本轮 assistant 回复留空间，`safetyMargin` 吸收估算误差。四个配置数值
和估算器的每次返回值都要是非负有限数。固定成本超过总窗口时，消息额度降到 0，不会
变成负数。

剩下的 22 从最新组向前使用。第三组成本 15，放得下；加上第二组正好是 22；再加第一
组会变成 29，于是选择停在 `u2`。最后按固定顺序拼出结果：

```ts
const messages: AgentMessage[] = [
  ...(systemMessage ? [systemMessage] : []),
  ...fixedMessages,
  ...selectedEntries.map((entry) => entry.message),
];
```

`fixedMessages` 目前为空，留给后文的压缩摘要。`keptEntryIds` 只记录被选中组的原始
entry，返回的 `messages` 则是深副本。重放出的 system message 可能由好几条 entry 合成，
没有一个 entry id 能单独代表它，所以它不进入 `keptEntryIds`。第 13 章把这份
`messages` 原样交给模型，prompt 已经在里面。

另一个边界仍使用开篇第三组。假设消息额度只有 10，而第三组单独需要 15，函数仍返回
完整的 `[u3, calls, r-test, r-read, a3]`，并把 reason 设为
`single_group_overflow`。结果允许超过 `maxTokens`，因为当前函数不能安全地从组内剪掉
call、result 或终态回答。上层看到这个 reason 后再决定摘要、缩短工具输出或换模型。

:::lab title="实践 11.3 · 在完整 group 边界选择消息后缀"
**目标：** 让固定成本和消息选择都能从返回值中核对，最新超限组仍保持完整。

**文件：** `packages/pi-course/src/context.ts`

**动作：**
1. 收窄 max、输出预留、安全余量和估算器返回值。
2. 从整条 active path 重放 system message，估算它的成本，再算 `availableForMessages`。
3. 调用 `groupInteractions()`，从最新组向前累加成本。
4. 最新组单独超限时完整保留，并返回 `single_group_overflow`。
5. 返回 `[system?, ...保留消息]` 的副本、来源 id、reason 和各项 token 数；system 不进入
   `keptEntryIds`。
6. 确认估算器收到的是消息副本，返回结果也不引用 active path。
7. 删除 Lab 11.3 的显式异常，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 11.3" \
  packages/pi-course/dist/test/11-*.test.js
```

**预期：** `3/3`。三项分别固定预算扣除、最新单组超限和多组裁剪边界。
:::

## `compact-1` 记录摘要与保留起点

开篇的预算结果丢弃了第一组，但 `buildContext()` 只读，不会自动生成摘要。调用者准备好
结构化 summary 后，再调用：

```ts
const compact1 = createCompactionEntry(activePath, {
  id: "compact-1",
  timestamp: 100,
  summary,
  firstKeptEntryId: "u2",
  tokensBefore: 29,
});
```

函数从 `activePath.at(-1)` 得到 `parentId: "a3"`。parent 不由调用者重复传入，因而不会
出现“记录追加在 a3 后面，字段却指向另一条 leaf”的两份答案。

`firstKeptEntryId` 的含义和 parent 不同。它是恢复上下文时保留原消息的起点，只能指向
一组的首条 user message。`u2` 合法；`a2`、`calls`、`r-test` 都位于组内，不能成为
切点。函数复用 `groupInteractions()` 找到这些组首，再把候选对象交给
`parseSessionEntry()` 做最后一次运行时校验和复制。

返回 `compact1` 以后，active path 仍保持原样。函数也不接收 Store。调用者可以展示
summary、记录审计或请求确认，最后再显式调用 `store.append(compact1)`。写入权仍由
Session Store 持有。

:::lab title="实践 11.4 · 创建记录，但不替调用者写 Store"
**目标：** 从活动路径推导唯一 parent，并只允许 interaction 起点成为 first kept。

**文件：** `packages/pi-course/src/context.ts`

**动作：**
1. 拒绝空路径，以及与路径中现有 entry 重复的新 id。
2. 从路径最后一项推导 `parentId`。
3. 复用分组结果，只接受每组第一条 message 的 id。
4. 用 parser 校验 summary、timestamp 和 `tokensBefore`。
5. 修改输入 summary 或返回记录，active path 都应保持不变。
6. 删除 Lab 11.4 的显式异常，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 11.4" \
  packages/pi-course/dist/test/11-*.test.js
```

**预期：** `2/2`。第一项观察 parent 和副本；第二项检查空路径、重复 id 与组内切点。
:::

## 恢复时把最新摘要接在保留后缀前面

`compact-1` 追加以后，十条原消息一条也没有删除：

```text
sys → u1 → a1 → u2 → a2 → u3 → calls → r-test → r-read → a3 → compact-1
                    ↑                                           │
                    └──── firstKeptEntryId = u2 ────────────────┘
```

新的 `u4 → a4` 可以继续追加在 `compact-1` 后面。下一次调用 `buildContext()` 时，函数从
活动路径末尾向前找到最新 compaction，然后完成三件事：

1. 把七字段 summary 按固定顺序转换成一条 synthetic user message；
2. 从 `u2` 收集原消息，并继续收集 compaction 之后的 `u4`、`a4`；
3. 跳过 metadata 与 compaction entry，再对消息后缀分组并应用预算。

结果的顺序是 `[system?, 摘要, ...保留的后缀]`。合成的摘要消息紧跟在重放出的 system
message 后面，它有自己的 token 成本。这个成本先从消息额度中扣除，余量才交给完整
groups。`keptEntryIds` 只列原 session 中保留的 message entries，不为合成消息制造虚假
id。

路径中若已经有 `compact-2`，恢复只读取它。`compact-1` 及更早消息仍在 session 中，
但不会再生成第二份摘要消息。最新摘要负责接续此前事实；把所有摘要同时放入模型窗口会
重复内容，也可能让旧决策和新决策互相冲突。

第二次 compaction 使用同一个创建函数。假设 `compact-2` 保留 `u3`，它会追加在当时的
leaf 后面。后续 `buildContext()` 先读取 `compact-2`，再从 `u3` 收集原消息。预算选择
仍从最新组向前进行，工具组仍不会被拆开。

在确定性、无状态的估算器下，相同 active path 与 options 应得到深相等结果。每次结果
又是独立副本：修改第一次返回的摘要文字或工具参数，不会影响第二次构建，也不会改写
session entries。

### system 状态跨过 compaction 边界

开篇路径里的 `sys` 在 `u2` 之前，按 `compact-1` 的 `firstKeptEntryId`，它属于被摘要
替代的那一段。若 system message
也只从保留后缀里收集，恢复后的请求就会丢掉基础 prompt。下面这条路径把问题放大：

```text
sys      system: content "BASE", sections.rules = "RULE v1"
u1 → a1
patch-1  system: sections.rules = "RULE v2"
u2 → a2                                    ← firstKeptEntryId
compact-1
patch-2  system: content "Prefer small diffs."
u3 → a3
```

`replayedSystemMessage()` 读取的是整条 active path，包括 compaction 之前的部分。三条
system message 依次重放，得到：

```ts
{
  role: "system",
  content: "BASE\n\nPrefer small diffs.",
  sections: { rules: "RULE v2" },
  timestamp: 1,
}
```

它的 `timestamp` 取第一条 system message。返回的 `messages` 依次是这条重放结果、
压缩摘要、`u2 → a2 → u3 → a3`；`patch-2` 已经折进开头，不再在后缀中原位出现。

compaction 本身不改变 system 状态。摘要消息只由七个字段生成，不携带 prompt 文本；
system message 也不能成为切点，`createCompactionEntry()` 遇到 `firstKeptEntryId:
"patch-2"` 会报告它不是完整 interaction 的首条 message。既然 system 状态只由 system
message 决定，重放整条路径与在压缩边界另存一份快照得到的结果相同，课程因此不给
compaction entry 增加 system 字段。

:::lab title="实践 11.5 · 从最新摘要恢复并再次压缩"
**目标：** 让重启、重复构建和第二次 compaction 遵循同一条确定路径，并让 system 状态
跨过压缩边界。

**文件：** `packages/pi-course/src/context.ts`

**动作：**
1. 从活动路径末尾向前找到最新 compaction。
2. 确认 first kept 位于该 compaction 之前，并且是完整组的 user 起点。
3. 按固定字段顺序生成 synthetic user message。
4. 从 first kept 收集消息，跳过 metadata 和所有 compaction entries。
5. 先扣摘要消息成本，再复用分组和预算选择。
6. system message 仍从整条 active path 重放，摘要排在它后面。
7. 重复调用并修改第一次结果，第二次结果与 active path 都应不变。
8. 在恢复后的路径上创建第二条 compaction，再验证完整组边界。
9. 删除 Lab 11.5 的显式异常，运行本段和全章测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 11.5" \
  packages/pi-course/dist/test/11-*.test.js
node --test packages/pi-course/dist/test/11-*.test.js
```

**预期：** 本段 `4/4`，全章 `15/15`。第四项就是上面的 `sys → patch-1 → compact-1 →
patch-2` 路径。
:::

## 损坏记录在进入预算前就会被拒绝

正常路径已经闭合以后，再看输入边界会更清楚。

先破坏 `compact-1` 的一个字段。正常 summary 使用 `changedFiles`；若把它换成早期草案中的
`files`，输入会变成：

```text
compact-1.summary.changedFiles  被移除
compact-1.summary.files         = ["context.ts"]
  → parseSessionEntry(compact-1) 报 schema 错误
  → Store 写入和 token 选择都没有开始
```

这里的 parser 只生成前文定义的七字段 `CompactionSummary`。旧记录需要先在边界外迁移成
当前形状；缺少当前字段或加入旧别名时，错误停在 `compact-1`，不会延后成预算差异。

再回到开篇的第三组。把 `r-test.toolCallId` 从 `test-1` 改成 `unknown-1`：

```text
[u3, calls(read-1, test-1), r-test(unknown-1), r-read(read-1), a3]
  → groupInteractions() 找不到 unknown-1 对应的 call
  → 第三组不进入预算选择
```

若只把正常的 `r-test(test-1)` 移到 `calls` 前面，函数仍返回这一组。它先用 user 划定
interaction，再核对上一节的四个 id 关系；result 的数组位置、`toolName` 与终态 assistant
不参与这次配对。错误信息携带 entry id 或 call id，读者可以在历史边界定位第一处偏差。

:::failure title="预期失败 · 按三条消息截取工具组"
临时把 Lab 11.3 的组选择改成 `messages.slice(-3)`，然后只运行 Lab 11.3。开篇第三组会
被截成 `r-test、r-read、a3`；`u3` 和声明两个 call 的 `calls` 消失。

聚焦测试期望最新超限组完整返回五条记录，因此 `keptEntryIds` 和角色序列都会立即失败。
恢复“从最新 group 向前选择”后，Lab 11.3 应回到 `3/3`，全章回到 `15/15`。
:::

## 15 项测试固定到哪里

这些测试固定了课程实现的确定性规则：严格 compaction schema、两个 Store 的重开、
user 分组、call/result 配对、固定成本、完整组裁剪、最新组超限、纯创建、最新摘要恢复、
二次压缩、跨压缩边界的 system 重放和公开副本隔离。

这 15 项测试把 compaction 固定在四个范围内：

- 预算使用调用者提供的确定性估算器，并扣除本章列出的固定成本。真实 tokenizer、tool
  schema、图片和缓存成本需要由 Provider 层给出另一套估算。
- `createCompactionEntry()` 校验七字段 summary 的形状；summary 正文与 `tokensBefore` 由
  调用者提供，函数不重新判断业务事实是否完整，也不重算压缩前规模。
- `groupInteractions()` 以 user 边界和四个 call/result id 关系组成不可拆分组。Result
  位置、toolName 和终态 assistant 不属于这层配对规则。
- `single_group_overflow` 只报告最新一组无法放入当前窗口。截短工具输出、生成专用摘要、
  换模型、自动触发时机和并发摘要写入都由上层生命周期选择。

:::pi title="与上游 Pi v1.0.0 对照"
Pi v1.0.0 的 coding-agent 仍把 compaction 作为 session entry 追加，记录
`firstKeptEntryId` 和 `tokensBefore`（`packages/coding-agent/src/core/compaction/compaction.ts:105-108`）。
`buildContextEntries()`（`packages/coding-agent/src/core/session-manager.ts:476-512`）沿当前
leaf 取最新 compaction，把它与保留后缀交给模型；早期摘要和已概括前缀仍留在 session。
上游的 `summary` 主体仍是字符串，产品压缩代码还能在超大 turn 中间切开，为前缀单独
生成摘要（`isSplitTurn`，`compaction.ts:427,780`）。课程使用七字段对象，并把整个 user
interaction 设为不可拆分单位。

两边对 system message 的结论一致：它是 prompt 状态，不进入摘要。1.0 在挑选摘要输入时
过滤掉 system message（`compaction.ts:101`），估算上下文时也只把重放出的当前 system
message 计一次（`compaction.ts:256-259`），与课程的 `tokens.system` 对应。

做法不同。8479bd8 时 system prompt 在 transcript 之外，compaction entry 也不含 system
状态；1.0 给 compaction entry 增加
`systemMessage` 快照，保存压缩边界处完整的 prompt 与工具状态（`session-manager.ts:103`）。
恢复时这条快照与摘要一起成为开头两条消息（`:461-464`），保留区间里的旧 system message
被丢弃（`:506`）；compaction 之后的补丁仍按原位置出现，由 provider 层决定原位发送还是
折叠（`packages/ai/src/utils/transcript.ts:108-123`）。
这样恢复只需读取 compaction 及其之后的 entry。课程不存快照，而是每次从整条 active path
重放全部 system message，并把补丁也折进开头那一条。system 状态只由 system message
决定，在课程只有 `content` 与 `sections` 的范围内，两种做法得到同样的 prompt。课程的严格 parser、确定性估算器和
`single_group_overflow` 是教学契约，不能当作上游实现的逐行复刻。
:::

## 本章验收

:::checkpoint title="Checkpoint 11 · 固定 transcript 能被分组、裁剪和恢复"
在隔离 practice 目录运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/11-*.test.js
```

结果应为 `15/15`。随后用开篇十条记录说明以下五段数据流：

1. `groupInteractions()` 为什么跳过 `sys`，得到 `[u1,a1]`、`[u2,a2]` 和包含完整工具
   往返的第三组；
2. 31 token 预算怎样先扣重放出的 system message、输出预留和安全余量，再保留第二、
   三组；
3. `compact-1` 为什么以 `a3` 为 parent、以 `u2` 为 first kept，并且不修改旧记录；
4. 恢复为什么只生成最新摘要消息，再从 first kept 接上原消息后缀；
5. `sys` 位于被摘要替代的那一段，为什么恢复后的请求仍以它开头。

还要修改一次 `buildContext()` 返回的工具参数，证明 active path 不变；再创建第二条
compaction，证明下一次恢复只使用最新摘要。重新定位可运行
`npm run checkpoint -w @pi/course -- 11`；重做时新建 practice 目录，不复用已改过的
脚手架。
:::

## 可选迁移练习

:::transfer title="陪练迁移 · 记录每个 group 的预算去向"
在不改变 `BuildContextResult` 的前提下，先写一个纯函数，输入
`InteractionGroup[]` 和同一个估算器，返回每组的 entry ids、token 成本和
`kept | trimmed | overflow` 状态。

至少覆盖开篇三组、最新工具组超限和没有工具的单组路径。函数只读输入，不能重新定义
`buildContext()` 的选择规则。
:::

## 小结

开篇十条消息始终留在 session 中。`groupInteractions()` 跳过 `sys`，把其余九条分成三个
user interactions，第三组完整保存两个 call、反序到达的两个 result 和终态 assistant。
`buildContext()` 扣除固定成本后，从最新组向前选择，因此 31 token 的例子只把第二、
三组交给模型。

compaction 把摘要、first kept 和压缩前规模追加成一条新记录。恢复读取活动路径上的
最新摘要，再接上完整消息后缀；第二次压缩仍然只追加，不删除旧事实。system message
始终从整条路径重放，排在摘要之前，不进入任何一组。第 12 章会把项目资源整理成 system
message 中的一个具名段落，它同样经过这里的重放，继续使用同一个上下文入口。
