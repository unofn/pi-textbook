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
的九条 message entries。表中最后一列是测试估算器给每条消息返回的 token 数，不是真实
provider 的 tokenizer 结果。

| entry id | message | 估算 token |
|---|---|---:|
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

`groupInteractions()` 以 user 消息为起点，把这九条记录分成三组：

```text
group 1 = [u1, a1]
group 2 = [u2, a2]
group 3 = [u3, calls, r-test, r-read, a3]
```

第三组包含 user、两个 tool call、两个 result 和最终 assistant。它是预算可以整体保留
或整体丢弃的最小单位。result 的出现顺序不影响配对，也不会把这一组拆开。

现在把这条活动路径交给 `buildContext()`。例子中的 `maxTokens` 是 31；system prompt
占 3，回答预留 4，安全余量占 2。消息还剩 22。三组成本依次为 7、7、15，所以函数从
最新一组向前选择，结果正好保留第二、三组：

```ts
{
  systemPrompt: "sys",
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

`u1` 和 `a1` 仍在 session 中，只是没有进入这次模型请求。这里的有限消息数组叫
context projection，也就是从历史派生出的临时视图。换一个模型窗口或预留量，同一段
历史可以得到另一份视图。

:::rebuild title="Checkpoint 11 · 从固定 transcript 派生有限上下文"
**模式：** 重建

**起终点：** `parent` `555162636bf0a8fd6e667e366d0103891cef1d6c` 是第 10 章完成后的起点；
`target` `5fb517c2012d8e6227c0e17ee65e530e18ac13e6` 是 compaction 记录、上下文投影和
14 项聚焦测试完成后的终点。

**教学文件：** `packages/pi-course/src/session.ts`、
`packages/pi-course/src/context.ts`

**学习脚手架：** parent 中还没有 `context.ts`。practice 会加入
`starters/11-context.ts`，并用 `starters/11-session.ts` 保留第 10 章能力。公共类型和
函数签名已经固定；五个 Lab 的分支分别抛出明确异常。

**动手前只需知道：** user message 开始一个 interaction，直到下一条 user message；
组内每个 tool call 都由 `toolCallId` 找到唯一 result。预算只在这些完整组之间裁剪。

**第一步：** 先不看 target diff，让 `parseSessionEntry()` 收窄一条正常的 compaction
记录，并让两种 Store 写入、读回它。预算选择留到后面的 Lab。

**第一次红灯：** 初始 build 可以通过。只运行 Lab 11.1 时，三项测试都停在
`Lab 11.1 compaction entry 尚未实现`。

**聚焦测试：** `packages/pi-course/test/11-context-compaction.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 11`

**练习目录：** `npm run practice -w @pi/course -- 11`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/11-*.test.js`

**通过证据：** 14 项测试按 `3/3 → 3/3 → 3/3 → 2/2 → 3/3` 覆盖记录解析、
交互分组、预算投影、摘要创建和重复恢复。
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

`groupInteractions()` 接收活动路径中的 message entries。它遇到 `u1` 时创建第一组，
遇到 `u2` 时结束第一组并创建第二组，遇到 `u3` 时做同样的事。路径结尾再结算第三组。

组内的工具事实靠 id 核对。处理 `calls` 时，函数记录 `read-1` 和 `test-1`；处理
`r-test`、`r-read` 时，它读取各自的 `toolCallId`。所以结果反序出现仍然合法，返回的
entries 保持原路径顺序：

```text
[u3, calls, r-test, r-read, a3]
```

分组函数不会把 `r-test` 重排到 `r-read` 后面。它只在同一 user group 内建立 callId
集合配对：call id 唯一、result id 存在且唯一、每个 call 最终有 result。它不验证完整
工具时序。`a3` 在这个 fixture 中是终态回答，因此也留在同一组中。

预算层之所以使用 group，而不是直接使用 message，是因为裁剪位置只能落在 `a1/u2`
或 `a2/u3` 之间。落在 `calls/r-test`、`r-test/r-read` 或 `r-read/a3` 之间都会丢掉一次
工具往返的一部分。

:::lab title="实践 11.2 · 用 user 边界和 callId 组成 interaction"
**目标：** 把开篇 transcript 分成三个可整体选择的组，同时保留工具结果的实际顺序。

**文件：** `packages/pi-course/src/context.ts`

**动作：**
1. user message 到达时结算上一组并开始新组。
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
  systemPrompt: "sys",
  reservedOutput: 4,
  safetyMargin: 2,
  estimateTokens,
});
```

这个例子的扣除过程可以直接列成表：

| 项目 | token | 扣除后的消息额度 |
|---|---:|---:|
| `maxTokens` | 31 | 31 |
| system prompt | 3 | 28 |
| `reservedOutput` | 4 | 24 |
| `safetyMargin` | 2 | 22 |

`reservedOutput` 给本轮 assistant 回复留空间，`safetyMargin` 吸收估算误差。四个配置数值
和估算器的每次返回值都要是非负有限数。固定成本超过总窗口时，消息额度降到 0，不会
变成负数。

剩下的 22 从最新组向前使用。第三组成本 15，放得下；加上第二组正好是 22；再加第一
组会变成 29，于是选择停在 `u2`。`keptEntryIds` 记录原始 entry 的来源，返回的
`messages` 则是这些 entry 中消息的深副本。计入预算的 `systemPrompt` 也随结果返回，
第 13 章可以把两者一起交给模型。

另一个边界仍使用开篇第三组。假设消息额度只有 10，而第三组单独需要 15，函数仍返回
完整的 `[u3, calls, r-test, r-read, a3]`，并把 reason 设为
`single_group_overflow`。结果允许超过 `maxTokens`，因为当前函数不能安全地从组内剪掉
call、result 或终态回答。上层看到这个 reason 后再决定摘要、缩短工具输出或换模型。

:::lab title="实践 11.3 · 在完整 group 边界选择消息后缀"
**目标：** 让固定成本和消息选择都能从返回值中核对，最新超限组仍保持完整。

**文件：** `packages/pi-course/src/context.ts`

**动作：**
1. 收窄 max、输出预留、安全余量和估算器返回值。
2. 计算 system 成本与 `availableForMessages`。
3. 调用 `groupInteractions()`，从最新组向前累加成本。
4. 最新组单独超限时完整保留，并返回 `single_group_overflow`。
5. 返回 system prompt、消息副本、来源 id、reason 和各项 token 数。
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

`compact-1` 追加以后，九条原消息一条也没有删除：

```text
u1 → a1 → u2 → a2 → u3 → calls → r-test → r-read → a3 → compact-1
              ↑                                           │
              └──── firstKeptEntryId = u2 ────────────────┘
```

新的 `u4 → a4` 可以继续追加在 `compact-1` 后面。下一次调用 `buildContext()` 时，函数从
活动路径末尾向前找到最新 compaction，然后完成三件事：

1. 把七字段 summary 按固定顺序转换成一条 synthetic user message；
2. 从 `u2` 收集原消息，并继续收集 compaction 之后的 `u4`、`a4`；
3. 跳过 metadata 与 compaction entry，再对消息后缀分组并应用预算。

合成的摘要消息位于返回 messages 的最前面，它有自己的 token 成本。这个成本先从消息
额度中扣除，余量才交给完整 groups。`keptEntryIds` 只列原 session 中保留的 message
entries，不为合成消息制造虚假 id。

路径中若已经有 `compact-2`，恢复只读取它。`compact-1` 及更早消息仍在 session 中，
但不会再生成第二份摘要消息。最新摘要负责接续此前事实；把所有摘要同时放入模型窗口会
重复内容，也可能让旧决策和新决策互相冲突。

第二次 compaction 使用同一个创建函数。假设 `compact-2` 保留 `u3`，它会追加在当时的
leaf 后面。后续 `buildContext()` 先读取 `compact-2`，再从 `u3` 收集原消息。预算选择
仍从最新组向前进行，工具组仍不会被拆开。

在确定性、无状态的估算器下，相同 active path 与 options 应得到深相等结果。每次结果
又是独立副本：修改第一次返回的摘要文字或工具参数，不会影响第二次构建，也不会改写
session entries。

:::lab title="实践 11.5 · 从最新摘要恢复并再次压缩"
**目标：** 让重启、重复构建和第二次 compaction 遵循同一条确定路径。

**文件：** `packages/pi-course/src/context.ts`

**动作：**
1. 从活动路径末尾向前找到最新 compaction。
2. 确认 first kept 位于该 compaction 之前，并且是完整组的 user 起点。
3. 按固定字段顺序生成 synthetic user message。
4. 从 first kept 收集消息，跳过 metadata 和所有 compaction entries。
5. 先扣摘要消息成本，再复用分组和预算选择。
6. 重复调用并修改第一次结果，第二次结果与 active path 都应不变。
7. 在恢复后的路径上创建第二条 compaction，再验证完整组边界。
8. 删除 Lab 11.5 的显式异常，运行本段和全章测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 11.5" \
  packages/pi-course/dist/test/11-*.test.js
node --test packages/pi-course/dist/test/11-*.test.js
```

**预期：** 本段 `3/3`，全章 `14/14`。
:::

## 损坏记录在进入预算前就会被拒绝

正常路径已经闭合以后，再看输入边界会更清楚。

`parseSessionEntry()` 只接受上面展示的七字段 summary。缺字段、多字段、数组中混入非
字符串、空 parent、负数或无限 `tokensBefore` 都会报错。早期草案中出现过 `files`、
`nextSteps`、`invariants` 和 `compactedEntryIds`；target 不迁移这些旧字段，也不在运行
时维护两套 schema。

`groupInteractions()` 同样会在分组结束时核对事实：第一条消息必须是 user；每个
toolResult 都能在本组找到 call；同一个 `callId` 不会出现重复 call 或重复 result；每个
call 最终都有 result。这是 user 边界内的 id 集合配对，不会检查 result 的 `toolName`
是否等于 call name、result 是否出现在 call 之后，也不要求 group 以终态 assistant 结束。
错误文字带 entry id 或 call id，使问题停在历史边界，不会伪装成稍后的 token 选择错误。

:::failure title="预期失败 · 按三条消息截取工具组"
临时把 Lab 11.3 的组选择改成 `messages.slice(-3)`，然后只运行 Lab 11.3。开篇第三组会
被截成 `r-test、r-read、a3`；`u3` 和声明两个 call 的 `calls` 消失。

聚焦测试期望最新超限组完整返回五条记录，因此 `keptEntryIds` 和角色序列都会立即失败。
恢复“从最新 group 向前选择”后，Lab 11.3 应回到 `3/3`，全章回到 `14/14`。
:::

## 14 项测试固定到哪里

这些测试固定了课程实现的确定性规则：严格 compaction schema、两个 Store 的重开、
user 分组、call/result 配对、固定成本、完整组裁剪、最新组超限、纯创建、最新摘要恢复、
二次压缩和公开副本隔离。

它们没有证明：

- 测试估算器等于任一 provider 的 tokenizer；
- tool schema、图片、缓存和传输协议的额外成本已经计入；
- 真实模型能生成完整、正确的 summary；
- `tokensBefore` 已经由函数重新估算并与真实压缩前规模核对；
- summary 自身超过可用消息预算时应采用哪一种 reason 或保留策略；
- 有状态或非确定性估算器重复调用时仍得到相同结果；
- toolResult 的 name 与 call name 一致、result 位于 call 之后，或 interaction 以终态
  assistant 结束；
- 单个超大 interaction 应采用哪一种产品策略；
- compaction 应在什么时刻自动触发；
- 多个并发摘要任务可以安全写同一条 session；
- summary 中的业务事实能够无损还原成原消息。

`single_group_overflow` 只报告当前投影无法安全放入窗口。它没有替上层选择截短工具输出、
生成专用摘要、换模型或停止运行。

:::pi title="与上游 Pi 的固定提交对照"
固定提交 `8479bd8` 的 coding-agent 也把 compaction 作为 session entry 追加，记录
`firstKeptEntryId` 和 `tokensBefore`。`buildContextEntries()` 沿当前 leaf 取最新
compaction，把摘要消息与保留后缀交给模型；早期摘要和已概括前缀仍留在 session。

上游该提交的 `summary` 主体是字符串，并且产品压缩代码还能为超大 turn 生成前缀摘要。
课程使用七字段对象，并把整个 user interaction 设为不可拆分单位。课程的严格 parser、
确定性估算器和 `single_group_overflow` 是教学契约，不能当作上游实现的逐行复刻。
:::

## 本章验收

:::checkpoint title="Checkpoint 11 · 固定 transcript 能被分组、裁剪和恢复"
在隔离 practice 目录运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/11-*.test.js
```

结果应为 `14/14`。随后用开篇九条记录说明以下四段数据流：

1. `groupInteractions()` 为什么得到 `[u1,a1]`、`[u2,a2]` 和包含完整工具往返的第三组；
2. 31 token 预算怎样先扣 system、输出预留和安全余量，再保留第二、三组；
3. `compact-1` 为什么以 `a3` 为 parent、以 `u2` 为 first kept，并且不修改旧记录；
4. 恢复为什么只生成最新摘要消息，再从 first kept 接上原消息后缀。

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

开篇九条消息始终留在 session 中。`groupInteractions()` 把它们分成三个 user
interactions，第三组完整保存两个 call、反序到达的两个 result 和终态 assistant。
`buildContext()` 扣除固定成本后，从最新组向前选择，因此 31 token 的例子只把第二、
三组交给模型。

compaction 把摘要、first kept 和压缩前规模追加成一条新记录。恢复读取活动路径上的
最新摘要，再接上完整消息后缀；第二次压缩仍然只追加，不删除旧事实。第 12 章会把项目
资源产生的提示加入这里返回的 `systemPrompt`，继续使用同一个上下文入口。
