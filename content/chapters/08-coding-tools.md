---
id: "08"
slug: coding-tools
part: core
partTitle: 第二部 · 闭合 Agent 核心
chapter: "08"
title: 四个工具怎样在同一个 workspace 里完成文件任务
summary: 跟随 task.txt 的读取、覆盖、精确编辑和命令检查，理解文件与进程工具怎样返回可验证结果。
minutes: 220
difficulty: 核心
artifact: packages/pi-course/src/coding-tools.ts
prerequisites: 06,07
terms: bounded observation, path containment, mutation queue, exact edit, process lifecycle
upstream: packages/coding-agent/src/core/tools/read.ts, packages/coding-agent/src/core/tools/write.ts, packages/coding-agent/src/core/tools/edit.ts, packages/coding-agent/src/core/tools/bash.ts
---

## 同一个 task.txt 经过四次调用

第 07 章用返回固定 README 内容的内存 `read` 闭合了反馈回路。现在把它换成访问
同一个 workspace 的 `read`、`write`、`edit` 和 `bash`；Agent Loop 的接口不变。

下面的 `workspace` 是测试临时创建的目录。目录里只有一个文件：

```text
workspace/
└── task.txt        内容是 status: draft
```

`createCodingTools()` 为这个目录创建一张工具表：

```ts
const tools = createCodingTools({
  cwd: workspace,
  containment: "workspace",
});
```

四次调用始终使用同一个 `tools` 和同一个相对路径 `task.txt`。为了让代码短一些，下面的
`run()` 只负责构造 `ToolCall` 并交给第 06 章的 executor：

```ts
async function run(id: string, name: string, argumentsValue: unknown) {
  return executeToolCall({
    type: "toolCall",
    id,
    name,
    arguments: argumentsValue,
  }, tools);
}

const readResult = await run("read-1", "read", {
  path: "task.txt",
});

const writeResult = await run("write-1", "write", {
  path: "task.txt",
  content: "status: draft\ncheck: pending",
});

const editResult = await run("edit-1", "edit", {
  path: "task.txt",
  oldText: "status: draft",
  newText: "status: done",
});

const bashResult = await run("bash-1", "bash", {
  command:
    "node -e \"const fs=require('node:fs'); const s=fs.readFileSync('task.txt','utf8'); if(!s.includes('status: done')) process.exit(2); process.stdout.write('verified')\"",
});
```

四条结果的正文依次是：

```text
read   →    1│ status: draft
write  → 已写入 28 bytes
edit   → 已完成 1 处精确替换
bash   → verified
```

磁盘上的最终内容是：

```text
status: done
check: pending
```

这四次调用已经形成一条完整的正常路径。`read` 返回自己实际看见的内容；`write` 整体
覆盖文件；`edit` 替换一处经过检查的精确文本；`bash` 从同一个 `workspace` 启动，并读到修改
后的文件。

每条结果还有结构化的 `details`。其中的绝对路径随临时目录变化，下面用
`$workspace/task.txt` 表示同一个文件：

```text
read.details  = { path: "$workspace/task.txt", bytes: 13,
                  lines: 1, startLine: 1, endLine: 1, truncated: false }
write.details = { path: "$workspace/task.txt", bytes: 28 }
edit.details  = { path: "$workspace/task.txt", oldBytes: 28,
                  newBytes: 27, edits: 1 }
bash.details  = { exitCode: 0, timedOut: false,
                  aborted: false, truncated: false, ... }
```

正文给下一轮模型阅读，`details` 给程序检查。四条结果仍沿用原 call 的 id 和 name；这项
配对工作已经由第 06、07 章完成。`coding-tools.ts` 只负责把文件或进程的实际结果填进
这两个位置。

:::rebuild title="Checkpoint 08 · 在一个临时 workspace 中接入四个工具"
**模式：** 重建。从 07 的 target 开始，只增加 coding tools。

**起终点：** parent 是本章开始时的起点快照；target 是 12 项聚焦测试通过的终点快照。

**教学文件：** `packages/pi-course/src/coding-tools.ts`

**学习脚手架：** 练习目录保留公共类型、工具注册入口和 Lab 8.1–8.6 的施工位置，
不包含路径解析、截断、文件提交、编辑与子进程管理实现。

**动手前只需知道：** `createCodingTools({ cwd, containment: "workspace" })` 返回
`ToolRegistry`。相对文件路径以 `cwd` 为基准；read 产生观察，write/edit 提交修改，
bash 从同一目录启动进程。

**第一次红灯：** 脚手架可以通过 TypeScript 编译。首次只运行 Lab 8.1 时，会看到
`Tool read failed: Lab 8.1 Read 尚未实现`。

**第一步：** 先不看 target diff。从 read 的完整编号行开始，只实现 Lab 8.1 所需分支。
后面的路径、提交、编辑和进程分支由各自 Lab 接续。

**聚焦测试：** `packages/pi-course/test/08-coding-tools.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 08`

**练习目录：** `npm run practice -w @pi/course -- 08`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/08-*.test.js`

**通过证据：** 12 项测试依次观察有界读取、workspace 路径、完整文件提交、精确编辑、
进程终态，以及一次 `read → edit → bash → final` 的真实 Agent Loop。
:::

## read 只返回能够完整显示的行

开头的一行文件没有触发截断。文件变成两行以后，可以把同一个 `task.txt` 放进更小的
读取窗口：

```ts
const limitedTools = createCodingTools({
  cwd: workspace,
  containment: "workspace",
  maxReadLines: 1,
});

await executeToolCall({
  type: "toolCall",
  id: "read-page-1",
  name: "read",
  arguments: { path: "task.txt" },
}, limitedTools);
```

第一份正文是：

```text
   1│ status: done

[已显示第 1-1 行，共 2 行；继续读取：offset=2]
```

第二次传入 `offset: 2`，就会从下一条尚未显示的完整行开始：

```text
   2│ check: pending
```

`read` 同时接受行数上限和字节上限。实现逐行生成带编号的候选正文，并把续读提示也
算进字节数。只有整条候选仍在 `maxReadBytes` 内，这一行才进入结果。

因此，`endLine` 记录实际显示的最后一条完整行。它不能记录循环原本准备读取到哪里。
文件还有内容时，续读位置为 `endLine + 1`。这两个值都从已经加入正文的行推导，所以
下一次读取不会漏掉被字节上限挡住的内容。

如果第一条编号行连同续读提示也放不下，工具返回错误。当前接口只提供按行续读的
`offset`，没有一行内部的字节游标；返回半行后将无法准确继续。

`ReadDetails` 中的 `bytes` 和 `lines` 描述整个文件，`startLine/endLine` 描述这次真正
显示的窗口，`truncated` 表示文件后面是否仍有内容。这些字段与正文说的是同一次观察。

:::lab title="实践 8.1 · 让 read 返回可续读的完整行"
**目标：** 让行窗口、字节上限、details 和续读位置指向同一段实际输出。

**文件：** `packages/pi-course/src/coding-tools.ts`

**动作：**
1. 加入 read 的 schema 和工具注册。
2. 读取 UTF-8 文件，并检查 offset 是否落在文件行范围内。
3. 逐行生成带编号的候选正文，把续读提示一起计入字节上限。
4. 用实际加入的完整行填写 `startLine`、`endLine` 和 `truncated`。
5. 返回整个文件的字节数、行数与本次窗口。
6. 删除 Lab 8.1 的临时异常，只运行对应测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 8.1" \
  packages/pi-course/dist/test/08-*.test.js
```

**预期：** `2/2`。第一项读取普通行窗口；第二项压低字节上限，确认正文没有半行，
下一次 offset 也没有跳行。
:::

## 三个文件工具从同一个 root 解析路径

正常轨迹中的 `task.txt` 是相对路径。`path.resolve(workspace, "task.txt")` 把它变成
`$workspace/task.txt`。在 `containment: "workspace"` 下，read、write 和 edit 都调用
同一个 `resolvedPath()`，所以三者以相同方式理解这个名字。

路径检查分两层。第一层处理字符串路径：

```text
workspace + task.txt       → $workspace/task.txt       接受
workspace + ../secret.txt → $parent/secret.txt         拒绝
绝对的 /outside/file.txt  → /outside/file.txt          拒绝
```

第二层处理符号链接。字符串 `$workspace/link/secret.txt` 看起来仍在 root 里面，但
`link` 可能指向外部目录。目标存在时，`realpath()` 取得目标的真实位置；目标尚未存在时，
`nearestExistingPath()` 向父目录查找，直到找到一个能取得真实位置的祖先。真实位置仍在
root 内，文件工具才继续。

新文件也要检查最近的已存在祖先。否则，write 可以沿一个指向外部的目录链接创建
`link/new.txt`，即使 read 已经挡住同一条路径。

:::lab title="实践 8.2 · 让三个文件工具共用 workspace root"
**目标：** 让 read、write 和 edit 对外部绝对路径与越界符号链接给出一致结果。

**文件：** `packages/pi-course/src/coding-tools.ts`

**动作：**
1. 实现共用的 `resolvedPath()`。
2. 先拒绝词法上落在 workspace 外的结果。
3. 对已有目标检查 realpath；对新目标检查最近的已存在祖先。
4. 让三个文件工具都通过这一个函数取得最终路径。
5. 删除 Lab 8.2 的临时异常，只运行对应测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 8.2" \
  packages/pi-course/dist/test/08-*.test.js
```

**预期：** `1/1`。外部文件保持原值，符号链接外部目录中不会出现新文件，三种工具都
返回 `isError: true`。
:::

这层检查会减少练习中的路径误操作。检查路径与真正打开文件之间仍有时间窗口，其他
进程可以在这个窗口修改符号链接。它是一层课程 containment，不是操作系统安全边界。

## write 用 rename 提交完整内容

开头的 write 把 `task.txt` 从一行整体覆盖成两行。它不会推测“这段 content 是追加
还是合并”；传入的字符串就是文件的新内容。

`atomicWrite()` 先创建父目录，再在目标文件旁边写一个临时文件：

```text
"status: draft\ncheck: pending"
        │
        ├─ mkdir($workspace)
        ├─ write($workspace/task.txt.pi-tmp-...)
        ├─ rename(temp, $workspace/task.txt)
        └─ details.bytes = 28
```

`rename` 替换目录项，成功后目标路径才指向新内容。测试为旧文件创建一个硬链接作为
见证：直接改写旧 inode 时，硬链接也会变化；使用 `rename` 后，硬链接仍保存旧版本。
测试还让一次 rename 提交失败，随后确认原目录内容未变，而且旁边没有残留临时文件。

write 和 edit 都会修改文件。现在让三项修改几乎同时到达：

```text
A: write(task.txt)   已进入写入步骤
B: edit(task.txt)    等待 A
C: write(notes.txt)  立即进入写入步骤

A 抛错并退出
B 随即进入写入步骤
```

B 等待，是因为它和 A 指向同一个解析后的绝对路径；C 指向另一个路径，因此可以和 A
同时前进。A 即使抛错，B 也会在它退出后取得执行权。

`MutationQueue` 保存的正是这组等待关系。解析后的绝对路径是 key，每个 key 对应一条
Promise gate；操作离开临界区时释放 gate，同 key 的下一项便能继续。

`MutationQueue` 的职责到这组 Promise 等待关系为止：它只协调当前进程中由课程工具
发起的修改。进程间互斥、多文件事务和断电持久性是另外三层问题；`rename` 的作用只是
缩短半成品对外可见的窗口。

:::lab title="实践 8.3 · 完整覆盖文件并排列同路径修改"
**目标：** 让 write 创建父目录、提交完整内容，并让修改队列按路径安排操作。

**文件：** `packages/pi-course/src/coding-tools.ts`

**动作：**
1. 实现 `MutationQueue.run()`，让同 key 操作串行、不同 key 操作独立前进。
2. 在目标同目录写临时文件，用 rename 提交，并在 finally 清理临时文件。
3. 自动创建父目录，返回最终路径与 UTF-8 字节数。
4. 让 write 以解析后的绝对路径进入修改队列。
5. 删除 Lab 8.3 的临时异常，只运行对应测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 8.3" \
  packages/pi-course/dist/test/08-*.test.js
```

**预期：** `2/2`。第一项检查新建、完整覆盖、details、硬链接见证、提交失败后的临时
文件清理和默认队列实例；第二项用 Promise gate 观察同路径登记顺序、不同路径前进，
以及失败后释放下一项。
:::

## Edit 先验证整批，再写一次

开头的 edit 在当前 `task.txt` 中查找 `status: draft`。这个例子里只有这一处，所以它
产生新字符串 `status: done`，然后通过同一个 `atomicWrite()` 提交。

edit 也接受数组。下面两项按数组顺序作用于同一个内存副本：

```ts
[
  { oldText: "status: draft", newText: "status: ready" },
  { oldText: "status: ready", newText: "status: done" },
]
```

第二项可以匹配第一项刚生成的 `status: ready`。循环只改变局部变量 `next`：

```ts
let next = current;
for (const edit of edits) {
  // 找到第一处，并确认其后没有第二个非重叠匹配
  next = applyExactReplacement(next, edit);
}
await atomicWrite(file, next);
```

每一项的 `oldText` 都要非空。实现找到第一处后，会从这段文本的结束位置继续查找；
零次匹配表示当前文件已经和调用者的观察不同，第二个非重叠匹配表示定位不够具体。
任意一项失败时，代码还没有调用 `atomicWrite()`，磁盘上的 `task.txt` 保持原样。
空 `newText` 是合法值，它表示删除找到的那段文本。

:::lab title="实践 8.4 · 按顺序验证并提交一批精确编辑"
**目标：** 让相关替换共享一份内存副本，全部通过后只提交一次。

**文件：** `packages/pi-course/src/coding-tools.ts`

**动作：**
1. 解析单项和数组两种参数形状，并拒绝空数组。
2. 按顺序在内存字符串上应用编辑。
3. 拒绝空 `oldText`、零匹配和第二个非重叠匹配。
4. 全部通过后调用一次 `atomicWrite()`，并与 write 共用修改队列。
5. 返回替换数、修改前字节数和修改后字节数。
6. 删除 Lab 8.4 的临时异常，只运行对应测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 8.4" \
  packages/pi-course/dist/test/08-*.test.js
```

**预期：** `2/2`。第一项检查依赖前一项结果的替换、删除、details 和共用队列；第二项
依次检查空批次、空 oldText、零匹配、非重叠重复和中途失败，并在每次失败后读取原文件。
:::

## bash 从同一个 cwd 启动并结算进程

正常轨迹里的命令只读取 `task.txt`，然后输出 `verified`。`spawn()` 使用
`cwd: workspace`，所以命令中的相对路径仍指向前三个工具看到的目录。

进程退出以后，bash 工具把正文与状态分开保存：

```text
content = "verified"
details = {
  exitCode: 0,
  timedOut: false,
  aborted: false,
  truncated: false,
  ...
}
isError = false
```

退出码非零时，已经产生的 stdout/stderr 仍留在 content，`exitCode` 保存具体数字，
`isError` 变成 true。这样下一轮模型既能看到命令说了什么，也能区分正常退出与失败。

一个已经启动的进程会同时产生 stdout、stderr、close、timeout 和 abort 事件。
`runCommand()` 同时订阅两条输出流，并把收到的字节放进同一预算。stdout、stderr 与截断说明共用
`maxBashOutputBytes`。达到上限后，监听器仍继续消费后续数据，只是不再
保存；否则未被排空的管道可能让子进程停在那里。

发生截断时，结果先为 `… [输出已截断]` 留出空间，再从已捕获内容中取能放下的 UTF-8
前缀。正文连同提示不超过配置的字节数。两条输出流谁先到由实际进程调度决定，课程
没有为 stdout 与 stderr 重新规定稳定顺序。

### 取消和超时结束同一个进程组

signal 在调用前已经 aborted 时，工具不执行 `spawn()`，而是直接返回
`aborted: true` 的结果。进程启动后收到 abort，或者 timer 到达
`bashTimeoutMs`，都会调用同一个 `terminate()`。

在 POSIX 系统上，子进程以独立进程组启动。`terminate()` 先向进程组发送 `SIGTERM`，
100 毫秒后再发送 `SIGKILL`，并等待强杀步骤结算。测试会启动一个忽略 `SIGTERM` 的后代进程；
bash 工具返回后，这个后代不能再写出存活标记。Windows 没有使用这条负 pid
进程组路径，当前实现退回到直接进程信号。

timer 和 abort listener 最终在 `finally` 中移除。timeout、abort 与进程自行退出可能
靠得很近，`forceKillDone` 让重复终止请求共享同一个延迟任务。最终只返回一条
`ToolResultMessage`。

### workspace 模式对命令做有限的字符串检查

`containment: "workspace"` 还会检查 command 中显式出现的绝对路径、`../` 和 `~/`。
命中时，bash 在 spawn 之前返回工具错误。这个检查能挡住练习中最直接的越界写法，
但 shell 仍可以通过环境变量、程序参数或系统调用访问 cwd 之外；固定 cwd 也不会隔离
网络、当前用户权限和密钥。

:::lab title="实践 8.5 · 让 bash 的每个终点都返回结果"
**目标：** 让成功、非零退出、预取消、运行中取消、超时和超长输出都得到有限结果。

**文件：** `packages/pi-course/src/coding-tools.ts`

**动作：**
1. 在 signal 已预取消时直接返回，不启动子进程。
2. 从配置的 cwd spawn 命令，同时消费 stdout 与 stderr。
3. 让两条输出和截断提示共用字节预算。
4. 保存 exit code，并区分 timedOut 与 aborted。
5. 终止时处理直接进程；POSIX 上同时处理同一进程组。
6. 等待 close 和延迟强杀步骤，最后清理 timer 与 listener。
7. 删除 Lab 8.5 的临时异常，只运行对应测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 8.5" \
  packages/pi-course/dist/test/08-*.test.js
```

**预期：** `4/4`。四项测试覆盖成功与非零退出、cwd 和命令字符串检查、预取消、共同
输出预算、timeout 与运行中取消。POSIX 分支还检查忽略 SIGTERM 的后代进程。
:::

:::mechanism title="workspace containment 管到哪里"
文件工具会把词法路径和真实路径限制在 root 内。bash 只从 root 启动，并做一层有限的
命令字符串检查。它们没有建立网络、系统调用、环境变量或用户权限隔离，也没有命令
审批。执行不可信代码仍需要操作系统级沙箱。
:::

## 四个工具回到 Agent Loop

四个工具都来自 `ToolRegistry`，所以第 07 章不需要知道当前执行的是 echo 还是文件操作。
聚焦测试用 `ScriptedModel` 安排下面四轮：

```text
assistant(read task.txt)  → toolResult(read)
assistant(edit task.txt)  → toolResult(edit)
assistant(bash verify)    → toolResult(bash)
assistant(final)          → stop
```

临时 workspace 起初包含 `task.txt = "draft"`。edit 把它改成 `"done"`，bash 在同一 cwd
读取并验证新值。最终有两类证据：文件确实等于 `done`；三条 tool result 的 id/name
分别与原 call 配对。

最终 role 顺序是：

```text
user
→ assistant(read) → toolResult(read)
→ assistant(edit) → toolResult(edit)
→ assistant(bash) → toolResult(bash)
→ assistant(final)
```

这条测试使用固定本地命令，不访问模型 API。`model.requests.length` 是 4，说明每个工具
结果都在下一轮请求前写回了 transcript。

:::lab title="实践 8.6 · 让真实工具走完既有反馈回路"
**目标：** 让 read、edit 和 bash 在同一临时 workspace 中形成三次配对结果。

**文件：** `packages/pi-course/src/coding-tools.ts`

**动作：**
1. 让 `createCodingTools()` 注册四个工具及其 Provider definitions。
2. 使用现有 `runAgentLoop()` 执行四轮 `ScriptedModel`。
3. 检查三条 call/result 的 id、name 与 `isError`。
4. 检查文件最终内容、bash 输出、消息 role 顺序和模型请求次数。
5. 删除 Lab 8.6 的临时异常，运行局部测试，再运行全部聚焦测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 8.6" \
  packages/pi-course/dist/test/08-*.test.js
node --test packages/pi-course/dist/test/08-*.test.js
```

**预期：** 局部 `1/1`，完整 `12/12`。文件内容是 `done`，bash 返回 `verified`，消息按
`user → assistant → result → assistant → result → assistant → result → assistant`
排列。
:::

## 这四个工具的边界停在哪里

本章的 12 项测试把四个工具固定在三个范围内。

- `resolvedPath()` 约束课程进程准备访问的路径。检查完成后，另一个进程仍可能改动
  符号链接；操作系统沙箱是更外层的能力。
- `MutationQueue` 只排列经过同一队列、使用同一解析路径 key 的修改。`rename` 让目录项
  一次切到完整新文件，但没有把多文件、多进程或断电恢复变成一笔持久化事务。
- bash 的输出、超时和进程组清理以本章的测试平台与 fixture 为准。Windows 进程树、命令
  审批、网络和密钥隔离属于产品入口的另一层设计。

重叠 edit、超大文件流式读取和更多字符编码可以作为这四个接口之上的扩展；它们不会
改变本章已经建立的 call/result 配对与 workspace 边界。

:::pi title="与上游 Pi v1.0.0 对照"
1.0 的上游 coding tools 仍处理更多生产细节。read 支持文本和图片，并按行数与字节数截断
（`packages/coding-agent/src/core/tools/read.ts:76`）；write 自动创建父目录，同文件修改经
`withFileMutationQueue` 串行（`write.ts:36,67,78`）；bash 还会把被截断的完整输出保存到
临时文件（`output-accumulator.ts:4,28`）。上游 edit 支持一次提交多个彼此不重叠的替换
（`edit.ts:37`）；每项都匹配原始文件，并在 `edit-diff.ts:347` 明确拒绝重叠或嵌套编辑。
课程 target 则按数组顺序修改同一份内存副本，所以后一项可以匹配前一项刚生成的文本。

文件布局与 8479bd8 时有一处不同：8479bd8 时各工具的终端渲染代码写在工具文件里，1.0 改为
集中在 `core/tools/renderers/`。共享的 `file-mutation-queue.ts`、`path-utils.ts`、
`output-accumulator.ts`、`edit-diff.ts` 仍在 `core/tools/`。

路径边界没有变化。内建 coding tools 把相对路径解析到 cwd，也接受绝对路径和解析到 cwd
外的 `..`（`packages/coding-agent/src/utils/paths.ts:103-106`，
`core/tools/path-utils.ts:48`）。上游没有课程 `containment: "workspace"` 的 cwd jail。
课程的路径限制是保护练习环境的主动强化，不能表述成上游默认行为。
:::

## 去掉第二个非重叠匹配检查

完成正常 edit 后，可以临时删掉“发现第二个非重叠匹配时报错”的分支。对内容
`same same` 执行 `same → X`，两种行为会分开：

```text
正常：匹配 2 次 → isError=true  → 文件仍是 same same
改坏：匹配 2 次 → isError=false → 文件变成 X same
```

:::failure title="诊断 · edit 擅自选择了第一个非重叠匹配"
只改变非重叠重复分支，运行 Lab 8.4。第一处偏差应出现在“匹配多次”或“文件保持原样”
的断言。恢复第二次查找后，局部测试回到 `2/2`。
:::

## 本章验收

:::checkpoint title="Checkpoint 08 · 同一个 workspace 留下四类证据"
在 practice 目录运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/08-*.test.js
```

结果应为 `12/12`。再沿开头的 `task.txt` 回答四个问题：read 的 `endLine` 从哪个实际值
产生；write 为什么用临时文件和 rename；edit 中途失败为什么不会修改磁盘；bash 的
cwd、输出预算和终止步骤分别约束什么。

`npm run checkpoint -w @pi/course -- 08` 可以重新定位 parent 与 target；
`npm run practice -w @pi/course -- 08 <新目录>` 会从同一 parent 创建新的隔离目录。
下一章会保留这四个工具和 Agent Loop，在它们外面增加可持续的 Agent 状态。
:::

## 可选迁移练习

:::transfer title="迁移 · 为同一个 workspace 增加 list"
增加一个只读 `list` 工具。它复用 `resolvedPath()`，按名称排序结果，并同时限制条目数
与输出字节数。先写 details 和续读语义，再实现测试。list 不修改文件，因此不进入
write/edit 的 MutationQueue。
:::

## 小结

同一个临时 workspace 让四个动作连成一条可观察轨迹。read 从 `task.txt` 返回完整行；
write 用临时文件和 rename 提交整体内容；edit 在内存里排除第二个非重叠匹配，再提交一次；
bash 从相同 cwd 启动，并把输出、退出码、超时和取消收进一个有界的终态。

workspace containment 让三个文件工具共用 root，也为 bash 加了一层有限 guardrail。
它保护练习输入，但没有替代操作系统隔离。第 09 章会让同一个 Agent 对象跨多次运行
保存消息，并处理新的用户输入时序。
