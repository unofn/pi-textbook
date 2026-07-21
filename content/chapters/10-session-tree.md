---
id: "10"
slug: session-tree
part: state
partTitle: 第三部 · 让 Harness 可靠
chapter: "10"
title: 从一棵会话树恢复当前对话
summary: 给完成消息加上稳定 id 与 parentId，追加到 JSONL；从选中的叶子恢复 active path，并明确副本、顺序和断尾边界。
minutes: 150
difficulty: 核心
artifact: packages/pi-course/src/session.ts
prerequisites: 03,09
terms: append-only log, JSONL, parent pointer, active path, branch, recovery
upstream: packages/coding-agent/src/core/session-manager.ts, packages/coding-agent/docs/session-format.md
---

## 先看这一棵树

第 09 章结束时，`Agent` 已经能完成多轮运行。现在把其中一次“读取 README”的对话保存
下来。每个完成对象都得到一个稳定的 `id`，并用 `parentId` 指向上一条记录：

```text
追加顺序    id          parentId     内容
1           u-1         null         user: 读取 README.md，告诉我项目名
2           a-read      u-1          assistant: toolCall call-1 / read
3           r-read      a-read       toolResult call-1: # tiny-pi ...
4           a-final     r-read       assistant: 项目名是 tiny-pi
5           a-alt       u-1          assistant: 我无法读取该文件
6           meta-cwd    a-final      metadata: cwd=/workspace/tiny-pi
```

数组记录的是写入先后，`parentId` 表达的关系却是：

```text
u-1
├── a-read
│   └── r-read
│       └── a-final
│           └── meta-cwd
└── a-alt
```

`a-read` 和 `a-alt` 都接在 `u-1` 后面，所以同一段历史长出了两个分支。旧分支没有被
覆盖，新的尝试也没有要求重写前面的记录。

假设界面当前选择的 leaf 是 `meta-cwd`。`pathTo(entries, "meta-cwd")` 返回：

```text
u-1 → a-read → r-read → a-final → meta-cwd
```

这就是本章所说的 **active path**：调用者选中一个 leaf，`pathTo()` 沿 parent pointer
回到 root，再把顺序翻转为 root 到 leaf。Session 本身没有一个会偷偷变化的“当前指针”；
当前是哪条路径，由调用 `pathTo()` 时传入的 leaf id 决定。

模型需要的是消息，不是所有磁盘记录。对同一个 leaf 调用
`messagesOnPath(entries, "meta-cwd")`，得到：

```text
user(u-1)
→ assistant(a-read, toolCall call-1)
→ toolResult(r-read, toolCallId call-1)
→ assistant(a-final)
```

`meta-cwd` 在路径上，但它是 metadata，所以不会进入 `AgentMessage[]`。`a-alt` 是 sibling，
也不会混入当前对话。若改选 `a-alt`，路径就只有 `u-1 → a-alt`。

本章的六段实现都在回答同一个问题：**这棵树怎样从内存安全地落到磁盘，又怎样从指定
leaf 无损恢复为模型消息？**

:::predict title="物理最后一行等于当前 leaf 吗"

上面的最后一条物理记录是 `meta-cwd`。如果随后又追加一个以 `u-1` 为 parent 的新节点，
当前 leaf 是否会自动切换？`pathTo(entries, "meta-cwd")` 的结果会不会改变？

---answer
不会。追加顺序与 active path 是两个维度。只要旧记录没有改写，传入的 leaf 仍是
`meta-cwd`，恢复结果就仍是 `u-1 → a-read → r-read → a-final → meta-cwd`。只有调用者改传
另一个 leaf id，所选路径才会变化。

:::

## 从第 09 章进入第 10 章

第 09 章保留的是运行完成后的 `AgentMessage`。`text_delta`、`AbortController`、未消费的
队列和正在变化的局部文本仍属于一次运行，不写入 session。第 10 章只给完成事实增加
身份和父子关系：

```text
第 09 章的完成消息
  user / assistant / toolResult
          │ 加 id、parentId、timestamp
          ▼
第 10 章的会话记录
  message / metadata
          │ 选择 leaf
          ▼
active path → AgentMessage[]
```

第 11 章才会从这条真实路径派生较短的模型上下文。当前 checkpoint 只有 `message` 和
`metadata` 两种 entry；不要提前加入 compaction entry。

练习在教学历史仓库 `pi-course` 中运行：

```bash
cd <你的工作区>/pi-course
npm run practice -w @pi/course -- 10 <新目录>
cd <新目录>
npm install
```

生成的 `packages/pi-course/src/session.ts` 已经声明公共类型和六处施工位。它能通过
TypeScript 编译，但每段行为都还没有实现。

:::rebuild title="Checkpoint 10 · 从固定 leaf 恢复一条可持久化路径"

**模式：** 重建

**起终点：** `parent` `d055d832cec5b95b0d5c7bdc46e6dc689d846ad0` 是第 09 章
完成后的起点；`target` `555162636bf0a8fd6e667e366d0103891cef1d6c` 是会话树与
14 项聚焦测试通过的终点。

**教学文件：** `packages/pi-course/src/session.ts`

**动手前只需知道：** `id` 标识一条不会原地改写的记录；`parentId` 指向它的直接父节点，
root 的 `parentId` 为 `null`。`pathTo()` 从调用者给出的 leaf 选择路径，物理最后一行不代表
当前路径。

**第一步：** 实现 `pathTo(entries, leafId)`：建立 `id → entry` 索引，从 leaf 沿
`parentId` 回溯到 root，再反转并返回深副本。

**第一次红灯：** 脚手架可通过 TypeScript 编译；只运行 Lab 10.1 时，应看到
`Lab 10.1 pathTo 尚未实现`，而非模块缺失或隐式 `any`。

**聚焦测试：** `packages/pi-course/test/10-session-tree.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 10`

**练习目录：** `npm run practice -w @pi/course -- 10`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/10-*.test.js`。

**通过证据：** 14 项测试按 `2/2 → 2/2 → 2/2 → 3/3 → 3/3 → 2/2` 检查路径、外部
数据收窄、内存副本、JSONL 恢复、writer 状态和消息投影。

第一次尝试先不看 target diff。卡住时只比较当前 Lab 的输入、输出与第一次偏差，不把
六段 Store 一次写完。

:::

## 1. `id` 和 `parentId` 如何组成路径

会话记录共享三个基础字段：

```ts
interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: number;
}

type SessionEntry =
  | (EntryBase & { type: "message"; message: AgentMessage })
  | (EntryBase & { type: "metadata"; key: string; value: JsonValue });
```

`id` 回答“这是哪条记录”，`parentId` 回答“它直接接在哪条记录后面”。数组下标只说明
写入位置，不能表达分支。上例中 `a-alt` 的下标在 `a-final` 之后，逻辑 parent 却是
`u-1`。

`pathTo(entries, leafId)` 可以分成两次遍历：

```text
第一次遍历 entries
  建立 byId
  发现任意重复 id → 立即失败

第二次从 leaf 回溯
  current 放进 reversePath
  parentId === null → 到达 root
  parent 不存在 → 报告 child id 与 parent id
  再次遇到 seen 中的 id → 报告环

reversePath.reverse()
返回每个 entry 的深副本
```

为什么重复 id 要在全数组检查，而缺失 parent 与环只检查所选路径？重复 id 会让
`byId.get(id)` 不再具有唯一含义，任何路径选择都不可信。相反，`pathTo()` 的契约只是
恢复指定 leaf；未选中的另一棵 root 或坏分支不应阻止健康路径被读取。

返回深副本也属于契约。若调用者改写返回值里的 `toolCall.arguments.path`，Store 中的事实
不能跟着变化。

:::lab title="实践 10.1 · 从固定会话树选出 active path"

**目标：** 让 `pathTo()` 只凭稳定 id 恢复指定路径，并给坏路径可定位的错误。

**文件：** `packages/pi-course/src/session.ts`

**动作：**

1. 扫描所有 entries，建立全局唯一的 `byId`。
2. 从 `leafId` 向 root 回溯，用 `seen` 检测两节点和更长的环。
3. leaf 不存在时报告 leaf id；parent 不存在时同时报告 child 与 parent id。
4. 允许多个 root，也允许未选中的分支缺 parent。
5. 把结果反转为 root 到 leaf，并返回深副本。
6. 删除 Lab 10.1 的显式异常，只运行本段测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 10.1" \
  packages/pi-course/dist/test/10-*.test.js
```

**预期：** `2/2`。第一项覆盖 root、深链和 sibling；第二项覆盖未知 leaf、重复 id、缺失
parent、环、未选中坏分支与返回副本。

:::

`pathTo()` 通过后，固定样例已经能得到
`u-1 → a-read → r-read → a-final → meta-cwd`。现在再处理一个现实问题：磁盘读回的对象
还不能直接当作 `SessionEntry`。

## 2. JSON 进入程序时仍然是 `unknown`

TypeScript 类型只约束通过编译器的源码。下面的断言不会检查磁盘内容：

```ts
const entry = JSON.parse(line) as SessionEntry;
```

`JSON.parse()` 可能得到数组、缺字段的对象、未知 `type`，或一条结构残缺的 assistant
message。正确边界是 `parseSessionEntry(value: unknown)`：从最外层开始，每验证一项事实，
才把类型收窄一层。

以固定树中的 `a-read` 为例，解析后的记录要完整保留这次工具请求：

```text
entry a-read
  id: 非空字符串
  parentId: "u-1"
  timestamp: 有限数
  type: "message"
  message.role: "assistant"
  message.content[0].type: "toolCall"
  message.content[0].id: "call-1"
  message.content[0].name: "read"
  message.content[0].arguments: { path: "README.md" }
```

解析器需要逐层检查：

| 位置 | 接受什么 |
| --- | --- |
| entry base | 非空 `id`；`parentId` 为非空字符串或 `null`；有限 `timestamp` |
| entry 类型 | 当前 checkpoint 只接受 `message`、`metadata` |
| message | 完整的 `user`、`assistant` 或 `toolResult` |
| metadata value | `null`、布尔、字符串、有限数、这些值组成的数组或普通对象 |
| object 字段 | 接受该结构声明的字段；遇到拼错或未知字段就在当前路径报错 |

递归检查的目标，是让内存中的值经过 JSONL 往返后仍表示同一份数据。用固定记录做三个
小实验就能看出问题：`a-read.arguments.path` 若是 `undefined`，写入 JSON 时这个字段会
消失；metadata 中的 `score: NaN` 会在磁盘上变成 `score: null`；metadata 对象若引用
自身，序列化会直接抛错。解析器在写入前拒绝这三类结果：字段丢失、形状改变和无法
序列化。

因此 metadata 中的 object 要有普通对象的 prototype，数组中的每个位置都有实际值，
数值保持有限，并且嵌套值能继续通过同一检查。Lab 10.2 的测试证据再覆盖完整的非法值
矩阵；正文先用上面三个可观察结果说明这条边界为何存在。

解析成功后返回新对象。这样 `parseSessionEntry()` 同时完成两件事：证明形状符合协议，
并切断外部对象对内部记录的可变引用。

:::lab title="实践 10.2 · 把 unknown 收窄为两种会话记录"

**目标：** 建立磁盘数据进入类型世界的唯一运行时边界。

**文件：** `packages/pi-course/src/session.ts`

**动作：**

1. 先验证普通 JSON object、精确字段、非空字符串与有限数。
2. 分别解析 `message` 和 `metadata`，未知 entry type 立即失败。
3. 逐层解析三种 `AgentMessage` 及其 content block、usage 和 tool details。
4. 递归验证 JSON-safe 值，并检测循环引用和数组空洞。
5. 让错误路径指出失败字段，例如 `session entry a-read.message.content[0]`。
6. 返回深副本，删除 Lab 10.2 的显式异常。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 10.2" \
  packages/pi-course/dist/test/10-*.test.js
```

**预期：** `2/2`。一项接受完整 message 与 metadata；另一项覆盖错误 role、未知字段、
非有限数、非 JSON 值、循环引用和返回副本。

:::

## 3. Store 在 `append()` 调用时取得快照

把固定树先放进内存，可以暂时排除文件系统，只观察所有权和顺序：

```ts
const first = store.append(u1);
const second = store.append(aRead);

// 两次调用以后，外部代码立刻修改原对象。
u1.message.content[0].text = "被改写";

await Promise.all([first, second]);
```

可靠的 Store 保存的仍应是调用 `append()` 那一刻的 `u-1` 与 `a-read`。如果等 Promise
真正排到队首才复制，调用者在等待期间的修改就会改变待提交事实。

因此 `append()` 分为两个时刻：

```text
调用发生
  parseSessionEntry(entry) → 得到 snapshot
  snapshot 加入本实例 FIFO

任务轮到执行
  检查 snapshot.id 是否重复
  检查 snapshot.parentId 是否已经存在
  通过后提交 snapshot
```

parent 检查必须在队列中执行。`a-read` 调用时，`u-1` 的 Promise 可能还没完成；但只要
两次调用顺序是 `u-1`、`a-read`，FIFO 就应让 child 在 parent 提交后通过。

一个任务失败也不能毒死队列。缺 parent 的 entry 失败以后，下一条合法 root 仍应执行。
`entries()` 则先等待当前队列结算，再交出内部数组的深副本。

Promise FIFO 的关键不是某个库，而是把公开操作与内部 tail 分开：

```ts
const operation = this.tail.then(async () => {
  // 在这里按顺序检查并提交本次 snapshot
});

this.tail = operation.catch(() => undefined);
return operation;
```

调用者拿到原来的 `operation`，所以本次错误不会丢；内部 tail 把错误结算掉，下一项才能
继续排队。snapshot 必须在创建 `operation` 之前取得。

:::lab title="实践 10.3 · 固定内存 Store 的快照与 FIFO"

**目标：** 分清调用者对象、Store 内部记录和读取结果三份所有权。

**文件：** `packages/pi-course/src/session.ts`

**动作：**

1. 在 `append()` 调用时通过 `parseSessionEntry()` 取得 snapshot。
2. 用单实例 Promise tail 按调用顺序执行 duplicate 与 parent 检查。
3. parent 必须已提交；root 的 `parentId` 为 `null`。
4. 单次失败只拒绝该次 append，内部 tail 仍能接续下一项。
5. `entries()` 等待 tail，再返回深副本。
6. 删除 Lab 10.3 的显式异常。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 10.3" \
  packages/pi-course/dist/test/10-*.test.js
```

**预期：** `2/2`。测试会并发发起 parent/child append，随后修改输入；还会验证重复 id、
缺 parent、非法 JSON 值、失败后的下一条合法记录与输出副本。

:::

## 4. JSONL 用换行标记一条记录已经提交

内存中的六条记录落盘后，每行一个 JSON 对象：

```text
{"id":"u-1",...}\n
{"id":"a-read","parentId":"u-1",...}\n
{"id":"r-read","parentId":"a-read",...}\n
```

本课程为 JSONL 规定一个明确边界：**只有以 `\n` 结束的行才算 committed record。**

若进程在写 `r-read` 时中断，文件可能停在：

```text
{"id":"u-1",...}\n
{"id":"a-read","parentId":"u-1",...}\n
{"id":"r-read","parentId":"a-read"
```

前两行完整且已提交；最后一段含有非空白内容却没有换行，只是 unterminated tail。
即使尾部碰巧是一段可以单独 `JSON.parse()` 的完整 JSON，只要没有换行，本章仍把它
视为未提交。恢复结果返回前两条和结构化 warning：

```ts
{ code: "unterminated_tail", line: 3 }
```

若最后一段只有空白字符，它按空行忽略，不产生 warning。

另一种情况是坏内容后面已有换行：

```text
{"id":"r-read","parentId":}\n
```

这是一条已提交的坏记录，`recoverJsonl()` 必须失败并报告物理行号，不能把它伪装成可
忽略尾部。空行可以跳过，但仍占用物理行号。

`recoverJsonl(value)` 是纯函数：切分文本，只遍历 committed lines，每行先
`JSON.parse()`，再交给 `parseSessionEntry()`。它报告恢复事实，不截断或改写文件。

:::lab title="实践 10.4 · 恢复已提交前缀并识别断尾"

**目标：** 用一个纯函数固定 JSONL 的提交语义。

**文件：** `packages/pi-course/src/session.ts`

**动作：**

1. 空文件返回空 entries 与空 warnings。
2. 按顺序解析所有以换行结束的非空行。
3. 已提交行的 JSON 或 schema 错误必须失败，并包含物理行号。
4. 最后一段含有非空白内容且没有换行时，无论它看似完整还是残缺，都忽略并报告
   `unterminated_tail`。
5. 跳过空白行，但不要压缩后续错误的行号。
6. 删除 Lab 10.4 的显式异常。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 10.4" \
  packages/pi-course/dist/test/10-*.test.js
```

**预期：** `3/3`。三项分别覆盖正常恢复、两种非空白无换行尾部，以及已提交的坏 JSON、坏
schema 和中段损坏。

:::

## 5. JSONL writer 只在确定安全时继续追加

`JsonlSessionStore.open(file)` 先确保文件存在，再用 `recoverJsonl()` 读取 committed
prefix。正常文件进入 `ready`；发现 unterminated tail 的文件仍可读取完整前缀，但进入
`needs-repair`，拒绝追加。本章不会擅自截断用户历史。

恢复出来的行还要按文件顺序重放树约束：每个 id 全局唯一，每个非 root 的 parent 必须
已经出现在更早的 committed line。否则 `open()` 立即失败。能通过 schema 不等于能组成
一棵可追加的历史。

正常追加仍沿用内存 Store 的两条规则：调用时快照、单实例 FIFO。不同之处是 snapshot
要立刻序列化为固定字符串：

```text
append(entry) 调用时
  parseSessionEntry(entry)
  JSON.stringify(snapshot) + "\n"
  固定 line 加入 FIFO

任务轮到执行
  检查 writer 状态、重复 id、parent
  io.appendFile(file, line)
  成功后把 snapshot.id 加入 committed id set
```

这样即使调用者随后修改 `a-final`，排队等待的 line 也不会变化。每次成功追加后，旧文件
的全部 bytes 都应是新文件的前缀。

底层写入失败有更强的后果。`appendFile()` 抛错时，无法证明它一个字节都没有写；文件
可能已经留下半行。若当前 writer 继续把 `meta-cwd` 接在半行后面，原本可识别的断尾会
变成一条以换行结束的坏记录。因此状态是：

```text
ready
├── 调用时校验/序列化失败 → 当前 append 失败，仍 ready
├── appendFile 成功         → 仍 ready
└── appendFile 失败         → tainted
                              ├── 后续 append 不再调用 I/O
                              ├── read/entries 抛最初的错误
                              └── 已排队任务也抛同一个错误对象

open 时发现断尾 → needs-repair
                   ├── read/entries 返回 committed prefix + warning
                   └── append 拒绝，不调用 I/O
```

`tainted` 描述当前实例可能刚造成了半写；它无法再相信自己的内存状态。重新
`open()` 同一个文件会重新检查磁盘：完整前缀仍可读，非空白无换行尾部进入
`needs-repair`。自动修复、文件锁和多进程写入都不属于本章。

:::lab title="实践 10.5 · 让 JSONL writer 按序提交并 fail closed"

**目标：** 固定正常追加、断尾只读和半写后停机三条边界。

**文件：** `packages/pi-course/src/session.ts`

**动作：**

1. `open()` 恢复现有 committed prefix，并拒绝其中的重复 id 或缺失 parent；有断尾时
   进入 `needs-repair`。
2. `append()` 在调用时校验、深复制并序列化，再把固定 line 加入 FIFO。
3. 在队列中检查 duplicate 与 parent，成功写入后才把 id 加入 committed id set。
4. 调用时校验失败不碰 I/O，也不污染 writer。
5. 第一次底层 append 失败时保存原 Error，进入 `tainted`。
6. 已排队和后续操作都返回同一个 Error；禁止再次调用底层 I/O。
7. 重新 `open()` 后只读恢复完整前缀，不自动修复尾部。
8. 删除 Lab 10.5 的显式异常。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 10.5" \
  packages/pi-course/dist/test/10-*.test.js
```

**预期：** `3/3`。一项使用真实文件验证旧 bytes 前缀与重开；一项用 Promise gate 固定
调用时快照和 FIFO；一项注入半写错误，检查同一错误身份、I/O 次数、`tainted` 与重开
后的只读恢复。

:::

## 6. active path 最终投影为完整消息

磁盘层已经能保存固定树，现在回到开头的输出。`messagesOnPath()` 的数据流很短：

```text
entries + "meta-cwd"
  → pathTo()
  → [u-1, a-read, r-read, a-final, meta-cwd]
  → 只选择 type === "message"
  → [user, assistant(toolCall), toolResult, assistant]
```

“只选择 message”不等于“只取文本”。`a-read` 必须保留 `toolCall.id`、`name`、结构化
`arguments` 和 raw 参数；`r-read` 必须保留 `toolCallId`、`toolName`、`isError` 与
`details`。若先调用有损的 `textOf()`，下一次模型调用就无法知道 `call-1` 的请求和结果
如何配对。

`pathTo()` 已经返回 entry 深副本，`messagesOnPath()` 仍应保证公开结果不与输入共享嵌套
对象。测试会修改返回的 tool arguments 和 result details，再次投影时仍应得到原值。

:::lab title="实践 10.6 · 从 active leaf 无损恢复 AgentMessage"

**目标：** 只恢复选中分支，同时保留完整工具协议。

**文件：** `packages/pi-course/src/session.ts`

**动作：**

1. 调用 `pathTo(entries, leafId)` 得到 root 到 leaf。
2. 跳过 metadata，只收集 message entry。
3. 保留 assistant tool call 与 toolResult 的全部字段。
4. 用 `meta-cwd` 和 `a-alt` 两个 leaf 证明 sibling 不会混入。
5. 修改输出中的嵌套对象，输入和下一次投影必须保持不变。
6. 删除 Lab 10.6 的显式异常，先跑本段，再跑全章。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 10.6" \
  packages/pi-course/dist/test/10-*.test.js
node --test packages/pi-course/dist/test/10-*.test.js
```

**预期：** 本段 `2/2`，全章 `14/14`。第一项覆盖 active branch、sibling 与 metadata；
第二项覆盖完整 tool call/result 和返回副本。

:::

## 用一次故障确认 writer 的边界

正常路径已经闭合：固定树可以追加、重开并投影。现在临时删除
`JsonlSessionStore` 在 I/O 失败后设置或检查 `tainted` 的分支。

:::failure title="半写以后继续追加会发生什么"

只运行 Lab 10.5。测试中的假 I/O 会先写入一段不完整字节，再抛出固定 Error。正确实现
会让已经排队的下一次 append 返回同一个 Error，且底层 append 调用次数不再增加。

错误实现会把下一条 JSON 接到半行后面。重开时，原本的 `unterminated_tail` 可能变成
以换行结束的坏行，连 committed prefix 都无法正常恢复。恢复 `tainted` 状态后，本段应
回到 `3/3`，全章回到 `14/14`。

:::

## 14 项测试证明到哪里

这些测试证明：单个 Store 实例按调用顺序工作；输入与输出使用深副本；指定路径能诊断
重复 id、缺 parent 与环；JSONL 能区分 committed bad line 和非空白 unterminated tail；一次
可能半写的 I/O 失败会让当前 writer 停止。

它们没有证明：

- 多个实例或多个进程可以安全写同一文件；
- `appendFile()` 返回后已经 `fsync` 到物理介质；
- 任意文件系统会原子追加整行；
- 断尾可以自动备份、截断或修复；
- 所有未选中分支都通过了整棵树完整性检查；
- session 已自动接入 `Agent.run_end`；本章只提供 Store 与恢复函数；
- compaction、token budget 或上下文裁剪已经实现；
- 超大文件、恶意深度和磁盘配额已有资源限制。

“同一文件只有一个 writer”是调用者的前置条件。`tainted` 也不是修复机制；它只阻止
当前实例在磁盘状态不确定时继续扩大损坏。

:::pi title="与上游 Pi 的固定提交对照"

固定提交 `8479bd8` 的 `packages/coding-agent/src/core/session-manager.ts` 同样使用 `id`、
`parentId` 和 leaf 表达历史树，从旧节点 branch 时继续追加。产品格式还包含 header、
版本、compaction、模型变化、label 与扩展数据。

课程 checkpoint 没有照搬上游全部容错细节。该固定提交会跳过部分无法解析的行，路径
构造也不负责诊断重复 id、缺 parent 或环。本章采用自己的可执行契约：换行结束的坏行
立即失败，指定路径必须可验证，公开返回值使用深副本。不要把课程测试固定的保证写成
上游已经提供的保证。

:::

## 本章验收

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/10-*.test.js
```

结果应为 `14/14`。随后用开头那棵树逐项说明：

1. 为什么追加 `a-alt` 不会覆盖 `a-read → r-read → a-final`。
2. 为什么 `meta-cwd` 在 active path 上，却不进入 `AgentMessage[]`。
3. `call-1` 经过写入、重开和投影后，哪些字段必须仍然存在。
4. 输入对象、Store 内部记录和公开返回值分别在哪一刻取得副本。
5. 为什么非空白无换行尾部可只读恢复，而换行结束的坏行必须失败。
6. 为什么一个 append I/O 失败后，当前 writer 不能继续尝试。

:::checkpoint title="Checkpoint 10 · 一棵树能从指定 leaf 无损恢复"

**完成状态：** `u-1` 下的两个分支都保留；选择 `meta-cwd` 时，只恢复
`u-1 → a-read → r-read → a-final` 四条完整消息。

**观察证据：** 六段聚焦测试依次为 `2/2、2/2、2/2、3/3、3/3、2/2`，全章
`14/14`；半写故障注入会准确打红，恢复 fail-closed 后回绿。

**责任边界：** parser 负责外部数据，Store 负责快照与顺序，JSONL 换行负责提交边界，
调用者提供 leaf，`pathTo()` 与 `messagesOnPath()` 负责恢复当前对话。

**恢复：** 回到 parent 后，第 09 章的内存 transcript 仍可运行，但进程结束后没有可分支、
可恢复的 session 历史。

:::

:::transfer title="陪练迁移 · 统计另一条 active path"

完成 `14/14` 后，自己写一个纯函数：输入 entries 与 leaf id，返回路径深度、消息数、
tool call 数和错误 toolResult 数。让陪练先给验收例子，不直接给实现。

例子至少包含纯文本路径、成功工具往返、错误 toolResult 和 sibling leaves。函数必须复用
`pathTo()`，不能把物理最后一行当作 active leaf。修改返回对象前后，输入 entries 的 JSON
表示应完全一致。

:::

## 小结

一份 session 同时有两种顺序：JSONL 保存追加顺序，`parentId` 保存逻辑关系。调用者给出
leaf，`pathTo()` 才能恢复 active path；`messagesOnPath()` 再跳过 metadata，保留完整的
user、assistant 与 toolResult。

外部 JSON 要从 `unknown` 逐层收窄。Store 在 `append()` 调用时取得快照，在公开读取时
返回新副本，并用 FIFO 让 parent 先于 child 提交。JSONL 的换行是提交标记：非空白的
无换行尾部只读恢复，换行结束的坏行立即失败。一次底层 append 失败可能已经写出半行，所以当前
writer 进入 `tainted`，不再碰文件。

下一章会把 `pathTo()` 返回的 active path 交给 `buildContext()`。它读取路径上最新的
compaction，把摘要转换成一条合成消息；metadata 与 compaction entry 本身不进入模型
消息。随后函数按完整 interaction 选择原始 message entries，返回消息的深副本，并在
`keptEntryIds` 中记录这些消息对应的 source entry id。整个投影只读 active path，原始
session 仍是 append-only，不会为了缩短上下文而改写过去。
