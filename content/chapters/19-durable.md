---
id: "19"
slug: durable
part: advanced
partTitle: 第五部 · Pi 1.0 进阶
chapter: "19"
title: Durable：先提交，再可见
summary: 让会话 entry 与任务检查点经一条变更线原子提交后才可见；重新打开时把 running 任务改回 pending，按存储的工具意图与 replay 策略决定重跑还是给出 interrupted，并把已提交的部分输出转成 aborted entry 后从头重发请求。
minutes: 150
difficulty: 进阶
artifact: packages/pi-course/src/durable.ts
prerequisites: 06,07,13
terms: durable harness, mutation line, atomic commit, task checkpoint, tool intent, replay policy, partial output
upstream: packages/durable/src/session/session.ts, packages/durable/src/harness/scheduler.ts, packages/durable/src/harness/generation.ts, packages/durable/src/harness/tool.ts, packages/durable/src/storage/jsonl/storage.ts
---

## 进程停在工具执行中间时，存储里该有什么

第 13 章的 `Runtime.prompt()` 等 Agent 跑完一整轮，才把本轮 suffix 逐条 append 到
Session Store。这个时点让“prompt 完成”有了清楚的含义，代价落在另一侧：一轮还没结束时
进程退出，Store 里没有这一轮的任何记录。用户消息、模型已经流出的半句话、已经开始执行的
工具，重启后都找不到。

固定一轮对话来看这件事。用户说 `go`，模型先输出 `calling`，再调用
`echo({ value: "x" })`；工具返回 `echo:x` 后，模型回答 `done`。本章的 durable harness
把这一轮拆成十次存储提交。测试在每次提交后记下写入了什么，格式是
`提交序号:记录种类:状态:阶段`：

```text
1:entry:user
1:generation:pending:request
2:generation:running:request
3:generation:running:request          流式部分输出 "calling"
4:entry:assistant
4:tool:pending:call
4:generation:completed:request
5:tool:running:call
6:tool:running:execute                工具意图：参数 { value: "x" } 与 replay 策略
7:entry:toolResult
7:tool:completed:execute
7:generation:pending:request
8:generation:running:request
9:generation:running:request          流式部分输出 "done"
10:entry:assistant
10:generation:completed:request
```

记录分两类。entry 是会话里写下后不再改变的消息，和第 10 章的 session entry 是同一种
东西；task 是一件待完成的工作，带状态和检查点（checkpoint），完成前会被整条替换多次。
`generation` 任务负责调用一次模型，`tool` 任务负责执行一个工具调用。同一个序号下的几行
属于同一次提交。

假设进程在第 6 次提交之后、第 7 次提交之前退出。`echo` 已经开始执行，结果还没写下。
存储里留下的是：

```text
entries   user "go"
          assistant "calling" + echo 调用
tasks     generation  completed
          tool        running   checkpoint { phase: "execute", arguments: { value: "x" }, replay: "safe" }
```

新进程打开这份存储，能读出三件事：这一轮已经走到哪个工具；这个工具开始执行时用的是什么
参数；当时注册它的代码有没有声明“中断后可以从头重跑”。工具结果还没写下，所以 UI、模型
和下一次请求都没有看到过它。

本章的不变量由此而来：任何进展在被看见之前先提交到存储；调用模型、执行工具这些副作用都
发生在提交之外。

围绕这条不变量，harness 只做四件事：

1. 先提交，再可见。所有提交排在一条变更线上；一次提交是一批写入，要么全部进入存储，
   要么一条都不进；存储接受之后，内存里的可见状态才更新。
2. 重新打开时，把 `running` 任务改回 `pending`。
3. 工具在 `execute()` 之前提交意图。恢复时，存储的意图与当前注册都声明
   `replay: "safe"` 才重跑，否则给模型一条 `interrupted` 错误结果。
4. 模型的部分输出逐步提交。恢复时把它转成 `aborted` assistant entry，再用同样的消息
   从头重发请求。

这套做法来自 Pi 1.0 新增的 `packages/durable`（pi-durable）。1.0 的主力 coding-agent
还没有用它：交互会话仍走第 10、13 章对应的 `SessionManager`，pi-durable 只出现在未发布的
实验目录里。本章讲的是 1.0 新确立的方向。课程 harness 放在 Runtime 旁边，第 13 章的代码
一行不改。

## 一次提交是一批写入

存储只认识两个集合：`entries` 和 `tasks`。一条写入按 id 整条替换一条记录：

```ts
export type DurableCollection = "entries" | "tasks";

export interface DurableWrite {
  collection: DurableCollection;
  id: string;
  value: JsonValue;
}
```

`DurableStore.commit(writes)` 接收一批写入，成功时返回递增的提交序号 `seq`。开篇第 4 次
提交同时写下 assistant entry、新的 tool 任务和已完成的 generation 任务；读者要么看到这
三样都在，要么一样都看不到。

存储之上是 `DurableSession`。它保存一份可见状态（view），对外提供 `get()`、`list()` 和
`commit(change)`。`change` 是一个回调，参数是一次事务：

```ts
export interface Transaction {
  get(collection: DurableCollection, id: string): JsonValue | undefined;
  list(collection: DurableCollection): { id: string; value: JsonValue }[];
  put(collection: DurableCollection, id: string, value: JsonValue): void;
}
```

`tx.get()` 和 `tx.list()` 读的是已经提交的状态；`tx.put()` 只把写入记下来，这时存储和
view 都没有变化。`change` 返回之后，session 才把收集到的写入整批交给存储：

```text
session.commit(change)
  → 排到变更线末尾，等前一次提交结束
  → change(tx)：读已提交状态，put 只收集
  → 没有写入：直接返回 change 的结果
  → store.commit(writes)：整批检查，整批写入，seq += 1
  → 把 writes 写进 view
  → 返回 change 的结果
```

最后两步的顺序就是“先提交，再可见”。`change` 里只做读取和计算，不调用模型，也不执行
工具。`change` 抛错时整批作废；如果副作用已经在里面发生，存储里就找不到它的任何记录。

任务记录的形状在脚手架里已经给出：

```ts
export type TaskStatus = "pending" | "running" | "completed" | "failed";

export type GenerationCheckpoint = {
  phase: "request";
  partial?: AssistantMessage;
};

export type ToolCheckpoint =
  | { phase: "call" }
  | { phase: "execute"; arguments: JsonValue; replay: ReplayPolicy };
```

generation 任务的 `input.inputEntryCount` 规定这次请求用哪些消息：会话里 `index` 小于它的
entry。tool 任务的 `input` 记下 assistant entry 的 id 和 tool call id，执行时从 entry 里
读回调用。两类任务都有 `order`，`run()` 按它从小到大取 `pending` 任务。

## 建立练习起点

在教学历史仓库中生成隔离练习：

```bash
cd <你的工作区>/pi-course
npm run checkpoint -w @pi/course -- 19
npm run practice -w @pi/course -- 19 <新目录>
cd <新目录>
npm install
```

本章只修改：

```text
packages/pi-course/src/durable.ts
```

:::rebuild title="Checkpoint 19 · 让每一步进展先落盘再可见"
**模式：** 重建。从第 18 章 target 开始，在 Runtime 旁边新建一个最小 durable harness，
不修改第 13 章的 Runtime。

**起终点：** `parent` `842d35ec4e60943a94d8df5389e728c7b75823eb` 是第 18 章虚拟模型完成后的
起点；`target` `8d54ddb44957f886be77c302c0becc3b8d2b6848` 是本章 10 项测试通过的终点。

**教学文件：** `packages/pi-course/src/durable.ts`

**学习脚手架：** practice 把 `starters/19-durable.ts` 放到 `src/durable.ts`。它已经给出记录
形状、读取方法、`prompt()`、生成的流式提交与最终提交，以及工具的 `execute()` 与
`settle()`。`DurableStore.commit` 与 `DurableSession.commit`（Lab 19.1）、`open` 与 `run`
（Lab 19.2）、`runTool`（Lab 19.3）和部分输出恢复（Lab 19.4）留给你实现。

**动手前只需知道：** 一次提交是一批按 id 整条替换的写入；存储先检查整批再写入，会话等存储
接受后才更新 view。所有提交排在一条 promise 链上。调用模型和执行工具都在提交之外发生。

**第一步：** 先实现 `DurableStore.commit()`：排在 `tail` 上，整批检查，任一不合法就抛
`StorageRejected`；通过后深复制写入、`seq += 1`、通知监听者。再实现
`DurableSession.commit()` 的收集、提交与 adopt。

**第一次红灯：** fresh starter 可以 build；只运行 Lab 19.1 时三项都失败，第一项显示
`Lab 19.1 DurableStore.commit 尚未实现`，后两项显示 `Lab 19.1 DurableSession.commit 尚未实现`。

**聚焦测试：** `packages/pi-course/test/19-durable.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 19`

**练习目录：** `npm run practice -w @pi/course -- 19`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/19-*.test.js`。

**施工顺序：** 原子提交与单一变更线 `3/3` → 任务与重新打开 `2/2` → 工具意图与回放 `3/3`
→ 部分输出恢复 `2/2`。

**通过证据：** 四个 Lab 可独立运行，失败注入能被现有测试捕获，最后本章 `10/10`。

第一次尝试先不看 target diff。每个 Lab 只问一个问题：这一批写入里有什么，在哪一步崩溃，
重启后会看到什么。
:::

验证起点：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 19.1" \
  packages/pi-course/dist/test/19-*.test.js
```

正确结果是 `0/3` 和上面的 starter 错误。若 build 失败，先检查 practice 是否从正确 parent
生成。

## Lab 19.1：原子批量与单一变更线

### 存储先检查整批，再写入

`DurableStore.commit()` 分两段。第一段逐条检查：collection 只能是 `entries` 或 `tasks`，
id 是非空字符串，value 是合法 JSON。脚手架给出的 `isJsonValue()` 拒绝 `NaN`、函数和类
实例。任何一条不合格就抛出 `StorageRejected`，这时一条都还没写。第二段才深复制整批写入，
逐条放进集合，`seq` 加一，通知 `onCommit` 监听者，返回新的 `seq`。

测试里的第二批写入说明了为什么要先检查完：

```ts
store.commit([
  write("entries", "e2", { index: 1 }),
  { collection: "tasks", id: "t2", value: { bad: Number.NaN } },
]);
```

`e2` 本身合法。边检查边写入的话，`e2` 会先落下，第二条再失败，存储里就多出一条没有配套
任务的 entry。整批检查后，被拒绝的这次提交不改变 `seq`，`e2` 也读不到。

存储同样要串行。多个 `commit()` 同时到达时，每次操作挂在 `tail` 后面；`tail` 吞掉错误，
只负责让下一项排队。第 13 章 Runtime 的 operation queue 用的是同一种写法：

```ts
const operation = this.tail.then(() => {
  // 先检查整批，再写入、seq += 1、通知监听者
});
this.tail = operation.then(
  () => undefined,
  () => undefined,
);
return operation;
```

快照用来模拟进程重启。`snapshot()` 导出 `{ seq, entries, tasks }` 的深副本，
`DurableStore.fromSnapshot()` 用它建一个新存储。测试把快照先 `JSON.stringify` 再
`JSON.parse`，确认里面只有 JSON；新存储的下一次提交得到 `seq` 3，旧存储仍停在 2。

### 会话在存储接受之后才更新 view

`DurableSession.commit(change)` 也排在自己的 `tail` 上。轮到它时，先建一个 `tx`：`get` 和
`list` 读 view，`put` 把写入推进一个局部数组。`change` 返回后分两种情况：

- 数组为空：不调用存储，直接返回结果。只读的 `change` 不产生提交。
- 数组非空：`await this.store.commit(writes)`，成功后把每条写入放进 view，再返回结果。

两种失败都碰不到 view。`change` 抛错时还没走到存储；存储抛 `StorageRejected` 时，写 view
的那一步不会执行。错误交还给调用者，`tail` 让后面的提交继续运行。

第二项测试检查变更线。第一个 `change` 停在一个 gate 上，第二个 `change` 一直不开始；
gate 打开后，第二个 `change` 里的 `tx.get("entries", "e1")` 读到 `{ n: 1 }`。两个
`change` 若交错运行，第二个看到的是第一次提交之前的状态，它据此算出的写入会覆盖前者。

:::lab title="实践 19.1 · 原子提交与单一变更线"
**目标：** 存储整批接受或整批拒绝；会话的所有提交串行执行，存储接受之后才可见。

**文件：** `packages/pi-course/src/durable.ts`

**动作：**
1. 实现 `DurableStore.commit()`：排在 `tail` 上；先整批检查 collection、非空 id 与
   `isJsonValue()`，不合法就抛 `StorageRejected`；通过后深复制、写入、`seq += 1`、通知
   `listeners`、返回 `seq`。
2. 实现 `DurableSession.commit()`：排在 `tail` 上；`tx.get/list` 读 view，`tx.put` 只收集；
   没有写入直接返回；否则 `await this.store.commit(writes)` 后再写 view。
3. 两条 `tail` 都用 `then(() => undefined, () => undefined)` 吞掉错误，公开 Promise 仍把
   原错误交给调用者。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 19.1" packages/pi-course/dist/test/19-*.test.js`。

**预期：** `3/3`。三项分别证明：被拒绝的批次连同其中合法的写入一起消失，按 id 整条替换，
快照导入导出不共享状态；并发提交按到达顺序执行，后一个 `change` 读到前一次提交的结果；
`change` 抛错或存储拒绝后 view 与存储都为空，后续提交照常得到 `seq` 1，只读 `change`
不产生提交。
:::

## Lab 19.2：任务在存储里走完生命周期

### prompt 与 run

`prompt(conversationId, value)` 已经给出。它在一次提交里写下用户 entry 和一个 `pending` 的
generation 任务，`inputEntryCount` 是用户 entry 的 `index + 1`。两条记录一起出现，存储里
不会留下一条没有任务去回答的用户消息。

`run()` 是一个循环：

```text
for (;;)
  signal 已触发              → 返回
  按 order 找第一个 pending 任务；没有 → 返回
  提交：这个任务改成 running
  在提交之外执行 runGeneration / runTool
  返回 false（被 signal 打断）→ 返回
```

`running` 先提交，执行在提交之外发生。用 Lab 19.2 第一项的 ScriptedModel 跑一次纯文本
回复，存储看到的是：

```text
1:entry:user
1:generation:pending:request
2:generation:running:request
3:generation:running:request
4:entry:assistant
4:generation:completed:request
```

第 3 次提交来自脚手架里的流式部分：模型每发一个 `text_delta`，`runGeneration()` 就把当前
partial 写进检查点。第 4 次提交把 assistant entry 与任务完成放在一起，检查点整条替换回
`{ phase: "request" }`，不再带 partial。此后再调用 `run()`，没有 pending 任务，`seq` 停在 4。

### 重新打开时，没有人在跑 running 任务

存储里的 `running` 表示“某个进程正在执行它”。进程退出后，这句话就不成立了：新进程打开
存储时，没有任何代码在执行这个任务。`DurableHarness.open()` 读完已提交状态后，在一次提交
里把所有 `running` 任务改回 `pending`：

```ts
await session.commit((tx) => {
  for (const { id, value } of tx.list("tasks")) {
    const task = value as unknown as TaskRecord;
    if (task.status === "running") {
      tx.put("tasks", id, toJson({ ...task, status: "pending" }));
    }
  }
});
```

这里只改状态，检查点原样保留。下一次 `run()` 照常按 `order` 取到它，再由检查点决定从哪里
继续，这是后两个 Lab 的内容。没有 `running` 任务时，这次 `commit` 没有写入，也就不产生
提交。

### 测试怎样模拟崩溃

测试不杀进程。它在 `store.onCommit` 里等到第 N 次提交，然后 abort 传给 `run()` 的 signal：

```ts
store.onCommit((seq) => {
  if (seq === 6) controller.abort();
});
await harness.run({ signal: controller.signal });
const crashed = store.snapshot();
```

第二项测试里，第一轮 `first` 已经完成，第 5 次提交是 `second` 的用户 entry 与 generation
任务，第 6 次提交把这个任务改成 `running`。signal 触发后，`runGeneration()` 停止等待模型并
返回 `false`，之后不再提交。这时拍下的快照里，任务状态是 `["completed", "running"]`。

用快照建一个新存储并 `open()`，状态变成 `["completed", "pending"]`；再 `run()`，新的
ScriptedModel 回答 `two`，会话依次是 `user`、`one`、`user`、`two`。

挂起的模型和工具响应 signal，只是为了让测试进程能结束。对存储来说，signal 触发的那一刻就是
崩溃：之后不再有提交，`run()` 返回时任务仍停在 `running`。

:::lab title="实践 19.2 · 打开与调度"
**目标：** 任务按 `order` 走完 `pending → running → completed`；重新打开时 `running` 回到
`pending`，其余任务不变。

**文件：** `packages/pi-course/src/durable.ts`

**动作：**
1. 实现 `DurableHarness.open()`：建 session 和 harness 后，在一次提交里把所有 `running`
   任务改回 `pending`，保留检查点。
2. 实现 `run()`：循环检查 signal，取 `order` 最小的 `pending` 任务，先提交 `running`，再在
   提交之外调用 `runGeneration()` 或 `runTool()`；它们返回 `false` 时停止。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 19.2" packages/pi-course/dist/test/19-*.test.js`。

**预期：** `2/2`。第一项固定上面的六行提交记录、完成后的检查点，以及没有 pending 任务时
`seq` 不变；第二项从第 6 次提交后的快照重新打开，得到 `["completed", "pending"]`，跑完后
会话以 `two` 结尾。这时 Lab 19.4 已经是 `1/2`：错误回复那一项只依赖 `run()` 和脚手架里的
最终提交；另一项要等 Lab 19.4 的恢复分支，现在显示
`Lab 19.4 partial output recovery 尚未实现`。
:::

## Lab 19.3：execute() 之前先提交意图

### 从调用到意图

generation 收到 `stopReason: "toolUse"` 的回复时，脚手架里的最终提交为每个 tool call 建一个
tool 任务，检查点是 `{ phase: "call" }`，与 assistant entry 在同一次提交里出现（开篇第 4 次）。
`run()` 取到它，提交 `running`（第 5 次），再进入 `runTool()`。

`runTool()` 先用 `readCall()` 从 assistant entry 读回调用，再处理两种不需要执行的情况：工具
没有注册，或参数通不过 `tool.schema.parse()`。两者都用 `settle()` 写一条错误结果，任务以
`completed` 结束；这次调用的结局已经确定，模型下一轮会看到错误。

参数通过后，`runTool()` 先提交意图，然后才执行：

```ts
await this.session.commit((tx) => {
  this.putTask(tx, {
    ...this.toolTask(taskId),
    checkpoint: {
      phase: "execute",
      arguments: toJson(parameters),
      replay: this.replay.get(call.name) ?? "unsafe",
    },
  });
});
return this.execute(task, { ...call, arguments: parameters }, signal);
```

这就是开篇的第 6 次提交。`arguments` 是解析后的最终参数，`replay` 是此刻注册时声明的策略，
缺省为 `unsafe`。`execute()` 已经给出：它调用第 06 章的 `executeToolCall()`，signal 触发时
返回 `false`，否则交给 `settle()`。

`settle()` 也已给出。它在一次提交里写下 toolResult entry 和任务终态；同一条 assistant 的其他
工具任务都结束时，还在这次提交里创建下一轮 generation（开篇第 7 次）。工具结果、任务结束和
下一次请求的任务，三者同时变得可见。

### 恢复时谁有资格让工具重跑

意图提交后，进程可能在任何时刻退出：工具也许还没真正开始，也许改了一半文件，也许已经做完、
只差结果没写下。存储分辨不出这三种情况。重新打开后，任务回到 `pending`，检查点仍是
`execute`。`runTool()` 看到这个阶段，就不再走调用路径，改用一条规则：

```text
存储的意图 replay    当前注册的 replay      恢复动作
safe                 safe                   用存储的参数从头重跑一次
safe                 unsafe 或没有注册       interrupted 错误结果，任务 failed
unsafe               safe                   interrupted 错误结果，任务 failed
unsafe               unsafe                 interrupted 错误结果，任务 failed
```

存储的那一半记下执行开始时的承诺：那时注册这个工具的代码说过它可以重跑。当前注册那一半
处理代码升级：新版本可能已经认定这个工具不适合重跑。两边都同意才重跑，而且用意图里存下的
参数，不重新解析 tool call。

其余情况给模型一条 `isError: true` 的结果，`details` 是：

```json
{ "error": "interrupted", "message": "Tool echo was interrupted and may have partially run" }
```

任务状态写 `failed`，`error` 字段含 `interrupted`。模型下一轮读到“这个工具可能执行了一部分”，
由它决定先检查再继续，还是换一种做法。会话照常往前走，Lab 19.3 第三项最后的消息依次是
`user`、`assistant`、`toolResult`、`assistant`。

:::predict title="重启后 echo 会跑几次"
`echo` 注册为 `replay: "safe"`，进程在它执行时退出。新版本代码把 `echo` 改注册成 `unsafe`，
再打开同一份存储。重启后 `echo` 会运行几次，模型看到什么？
---answer
零次。存储的意图说 `safe`，当前注册说 `unsafe`，两边不一致，恢复路径直接 `settle()` 一条
`interrupted` 错误结果，任务以 `failed` 结束。测试用 `rerun.runs === 0` 检查这一点；模型看到
`isError: true` 的 toolResult，`toolCallId` 仍是 `c1`，下一轮 generation 照常创建。
:::

:::lab title="实践 19.3 · 工具意图与回放"
**目标：** 工具执行前意图已经落盘；恢复时只有两边都声明 `safe` 才重跑，否则给出
`interrupted`。

**文件：** `packages/pi-course/src/durable.ts`

**动作：**
1. 在 `runTool()` 开头读出调用和工具。检查点已是 `execute` 时进入恢复分支：存储的
   `replay` 与 `this.replay.get(call.name)` 都是 `safe` 就用存储的参数调用 `execute()`；
   否则用 `failedResult(call, "interrupted", …)` 调 `settle(…, "failed", …)`。
2. 普通路径先处理未注册工具与参数解析失败，两者都 `settle(…, "completed")`。
3. 参数合法时提交 `{ phase: "execute", arguments, replay }`，提交返回后再调用 `execute()`。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 19.3" packages/pi-course/dist/test/19-*.test.js`。

**预期：** `3/3`。第一项固定开篇的十次提交，工具只执行一次；第二项在工具挂起时检查意图已经
可见、结果尚未可见，恢复后安全工具重跑一次并返回 `echo:x`；第三项依次检查
`unsafe/safe`、`safe/unsafe`、`unsafe/unsafe` 三种组合，都不重跑，并给出同样的
`interrupted` 结果。
:::

## Lab 19.4：部分输出变成 aborted entry，再从头重发

### 部分输出只在检查点里

`runGeneration()` 的流式部分已经给出：每收到一个 `text_delta`，就把事件里的 `partial` 写进
检查点。课程没有节流，每个增量提交一次。Lab 19.4 第一项用一个手动推进的模型流出 `Hel`、
`lo`，然后一直挂起：

```text
2:generation:running:request
3:generation:running:request      partial "Hel"
4:generation:running:request      partial "Hello"
```

测试在第 4 次提交后触发 signal。快照里，generation 任务的检查点带着 `partial`，文本是
`Hello`；会话 entries 只有一条用户消息。这时部分输出还算未完成工作的进度，没有成为会话的
一部分。

### 恢复：先落成 entry，再从头请求

重新打开后，任务回到 `pending`，`run()` 再次进入 `runGeneration()`。检查点里有 `partial`，
说明上一个进程已经让读者看到过这些文字。恢复代码在一次提交里做两件事：

```text
一次提交
  putEntry   assistant，内容是 partial，stopReason: "aborted"
  putTask    checkpoint 换回 { phase: "request" }，去掉 partial
```

然后重新读取任务，用同样的边界取消息，从头发起请求。上一次请求的连接已经随进程消失，模型的
流式输出没法从中间续上。

边界由 `inputEntryCount` 决定，这段读取脚手架已经写好：

```ts
const messages = this.entries(conversationId)
  .filter((record) => record.index < task.input.inputEntryCount)
  .map((record) => record.entry.message);
```

这个 generation 创建时，`inputEntryCount` 是 1，只覆盖用户消息。aborted entry 的 `index` 是 1，
落在边界之外，所以重发的请求与第一次完全相同。测试比较两次请求的 `messages`，长度都是 1。

恢复后的会话有三条消息：

```text
user        say hello
assistant   "Hello"           stopReason: "aborted"
assistant   "Hello there"     stopReason: "stop"
```

aborted entry 留在会话里，因为之前已经有读者看见过 `Hello`。把它记成一条中断的回复，读者
就能知道那半句话去了哪里。任务最后 `completed`，检查点回到 `{ phase: "request" }`。

### 模型以 error 结束

第二项测试走另一条路径。ScriptedModel 第一次返回 `stopReason: "error"`、`errorMessage:
"rate limited"`。这条错误回复照常落成 assistant entry，generation 任务 `completed`，不建新的
generation：只有 `toolUse` 才会产生后续任务。用户再 `prompt("again")`，新的用户 entry 与
generation 一起提交，会话继续成 `user`、`assistant(error)`、`user`、`assistant`。

:::lab title="实践 19.4 · 部分输出恢复"
**目标：** 崩溃前已经可见的部分输出成为 `aborted` entry，请求用同样的消息从头重发。

**文件：** `packages/pi-course/src/durable.ts`

**动作：**
1. 在 `runGeneration()` 的恢复分支里，用一次提交写入 `{ ...partial, stopReason: "aborted" }`
   的 assistant entry，并把检查点替换成 `{ phase: "request" }`。
2. 提交后重新读取任务，让后面已有的请求代码用 `inputEntryCount` 之前的消息发起请求。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 19.4" packages/pi-course/dist/test/19-*.test.js`。

**预期：** `2/2`，全章 `10/10`。第一项检查第 3、4 次提交里的部分输出、崩溃时 entries 只有
用户消息、恢复后三条消息的形状，以及两次请求的 `messages` 相同；第二项检查错误回复落盘后
不创建新的 generation。
:::

## 用现有测试破坏一次“先提交再可见”

:::failure title="失败注入 · 先更新 view，再交给存储"
四个 Lab 通过后，临时把 `DurableSession.commit()` 里的两段对调，先写 view，再交给存储：

```ts
for (const write of writes) {
  this.view[write.collection].set(write.id, write.value);
}
await this.store.commit(writes);
```

运行全章：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/19-*.test.js
```

只有 Lab 19.1 第三项变红，其余 9 项照常通过。这一项的第二次提交里，`tasks/t1` 的值含一个
函数，存储整批拒绝；`e1` 却已经进了 view，`session.list("entries")` 不再是空数组。对调回来后
恢复 `10/10`。

其余 9 项不受影响，因为它们的每次提交都会被存储接受，两种顺序得到同样的 view。只有存储拒绝
一批写入时，这个顺序才看得出来。
:::

## 课程 harness 与 pi-durable

:::pi title="与上游 Pi v1.0.0 对照"
**状态。** `packages/durable` 是 1.0 新增的包：8479bd8 时还没有这个目录，只有
`packages/agent/src/harness` 下的实验性 harness。README 第一行标着 Experimental
（`packages/durable/README.md:3`）。主力 coding-agent 没有使用它：`AgentSession` 在
`message_end` 时调用 `SessionManager.appendMessage()`
（`packages/coding-agent/src/core/agent-session.ts:1133`），也就是第 13 章对照里说的“完成
一条便持久化一条”。引用 pi-durable 的代码只在 `src/experimental/`（例如
`experimental/session-worker.ts:15`），`package.json` 的 `files` 用 `!dist/experimental`
把这部分排除在发布包之外（`packages/coding-agent/package.json:32`）。

**先提交，再可见。** 上游 `SessionImpl` 的注释把它称为 one mutation line
（`packages/durable/src/session/session.ts:53-58`）。`commitWith()`（`:94-101`）经
`#enqueue()`（`:529-536`）排队；`#runCommit()`（`:404-444`）的顺序与课程相同：运行 change，
收集写入，没有写入就丢弃，然后 `storage.commit(writes)`、`tx.adopt(seq)`，最后发布给监听者。
`StorageRejected` 的约定也一样，它保证这一批没有任何持久效果，Session 可以继续
（`packages/durable/src/errors.ts:11-17`）。`MemoryStorage.prepareCommit()` 先校验并复制
整批，`apply()` 才改变状态（`packages/durable/src/storage/memory.ts:245-271`）。

上游多出 poison，课程 harness 没有。存储抛出 `StorageRejected` 以外的错误，或者存储已经
接受而 adopt 失败，Session 都记下 poison（`session.ts:431`、`:439`），之后每次操作都报
“poisoned … reopen it”（`:543-549`）。这和第 13 章 Runtime 的 poison 是同一个判断：无法证明
一次写入完全没有发生时，不再继续。课程的内存存储只会整批拒绝，不存在这种中间状态。上游事务
还有一条课程没有的规则：第一次表写入之后不能再读表（`errors.ts:3-9` 的 `ReadAfterWrite`）。

**存储后端。** 上游有 memory、JSONL、SQLite 三种实现。JSONL 后端打开时截掉没有换行结尾的
残行（`packages/durable/src/storage/jsonl/storage.ts:795-802`），写入失败后把自己标为
poisoned，必须重新打开（`:88-93`、`:836-844`）；`fsync` 默认关闭（`:76-79`、`:256`）。
课程简化：只用内存存储，用 `snapshot()` / `fromSnapshot()` 代替“写到磁盘再读回”，用
`run({ signal })` 的中止代替进程崩溃。

**重新打开。** 调度器的 `open()`（`packages/durable/src/harness/scheduler.ts:230-256`）在
一次提交里扫描所有存活任务，把 `running` 改回 `pending` 并保留检查点，然后不派发任何任务；
调用 `resume()`（`:258-262`）、提交输入或等待结果时才开始调度。上游任务另有 `waiting`、
`completing` 两种存活状态（`:54`），任务之间有归属关系，generation 拥有本轮的 tool 任务并
等待它们结束。课程简化：四种状态，由 `run()` 按 `order` 显式驱动。

**工具意图。** 上游 `ToolTaskCheckpoint`（`packages/durable/src/harness/tool.ts:35-38`）与
课程同形。`call` 阶段在参数校验和 `beforeTool` 钩子之后提交
`{ phase: "execute", arguments: final, replay: tool.replay ?? "unsafe" }`（`:85-91`），再执行。
`execute` 阶段只在恢复时进入（`:93-111`）：两边都是 `safe` 才清掉上次发布的进度并重跑，否则
以 `failed` 结束，消息是 `Tool … was interrupted and may have partially run`（`:107`）。上游的
interrupted 结果还带着被中断那次已经提交的输出（`:399-410`）。课程简化：`replay` 在上游声明在
工具注册类型上（`packages/durable/src/harness/types.ts:205-206`），课程放在
`DurableToolRegistration` 上，不改第 06 章的 `Tool`。

**部分输出。** 上游把部分输出写在会话文档 `pi.live` 的 `generation.message` 上，不放进任务
检查点；`streamResponse()` 用 100 ms 尾随定时器节流，同一时刻最多一次在途提交
（`packages/durable/src/harness/generation.ts:108`、`:358-413`）。`request` 阶段的第一次提交
调用 `convertPartial()`（`:184-192`、`:347-356`），把残留 partial 追加成 `aborted` assistant
entry，再按检查点里的 `cutoff` entry id 取上下文（`:195`）。课程简化：每个增量提交一次，
partial 放在检查点里，用 `inputEntryCount` 当边界。另有一处行为差异：上游此后每次构造模型
上下文都排除 `aborted`、`error`、`deferred` 的 assistant entry
（`packages/durable/src/harness/context.ts:8`）；课程只靠边界把 aborted entry 挡在重发的请求
之外，之后的新 prompt 会把它和 error 回复一起交给模型。

**课程没有的部分。** 文档（`packages/durable/src/documents.ts`，类型化 JSON 状态，与 entry
在同一次提交里修改）、分叉（`packages/durable/src/session/forks.ts`，新会话看到父会话截至某个
entry 的历史并复制文档）、submission 与 inbox（`requestId` 去重、steer 与 follow-up 排队）、
钩子、compaction、task graph 与子 agent。generation 的 `prepare` 阶段还会把 system 段落和
工具变化追加成 `pi.system` entry（`packages/durable/src/harness/prompt.ts:66-93`），这是第 13、
15 章 system 补丁在 durable 一侧的对应物，本章没有实现。
:::

## 十项测试与本章验收

| Lab | 数量 | 可观察事实 |
|---|---:|---|
| 19.1 | 3 | 整批拒绝、按 id 替换、快照往返；提交串行；失败不留可见进展 |
| 19.2 | 2 | 用户 entry 与任务同批出现；`pending → running → completed`；重新打开时 `running → pending` |
| 19.3 | 3 | 意图先于 `execute()`；两边 `safe` 才重跑；其余三种组合给出 `interrupted` |
| 19.4 | 2 | 部分输出逐步提交；恢复成 `aborted` entry 并用同样消息重发；错误回复不续轮 |

全章运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/19-*.test.js
```

再运行当前练习目录全部课程测试：

```bash
node --test packages/pi-course/dist/test/*.test.js
```

用开篇那一轮对话复述：

1. 第 4 次提交为什么必须同时写 assistant entry、tool 任务和 generation 完成；
2. `DurableSession.commit()` 为什么等存储接受后才写 view，`change` 里为什么不能调用模型；
3. 进程在第 6 次提交之后退出，重新打开时 `open()` 改了什么、没改什么；
4. 同样的崩溃下，`echo` 注册为 `safe` 和 `unsafe` 时，重启后各运行几次，模型各看到什么；
5. 新版本把 `echo` 改成 `unsafe` 时，存储里的 `safe` 为什么不足以重跑；
6. 模型流出 `Hello` 后崩溃，这五个字符最后放在哪里，为什么重发的请求里没有它们；
7. 测试为什么可以用 signal 和快照代替真正的进程崩溃。

验收记录可写成：

```text
Lab 19.1: 3/3
Lab 19.2: 2/2
Lab 19.3: 3/3
Lab 19.4: 2/2
fault injection: Lab 19.1 第三项 red
fault restored: 10/10
chapter total: 10/10
```

:::checkpoint title="Checkpoint 19 · 没有任何可见进展不先落盘"
**完成状态：** `DurableStore` 整批检查后整批写入，被拒绝的批次不改变 `seq`；
`DurableSession` 的所有提交排在一条 promise 链上，存储接受之后才更新 view。

**任务状态：** `prompt()` 把用户 entry 与 generation 任务放进同一次提交；`run()` 先提交
`running`，在提交之外执行；`open()` 把 `running` 改回 `pending`，检查点不变。

**恢复规则：** 工具在 `execute()` 之前提交参数与 `replay`；恢复时两边都是 `safe` 才用存储的
参数重跑，否则给出 `interrupted` 并以 `failed` 结束。已提交的部分输出变成 `aborted` entry，
请求用 `inputEntryCount` 之前的消息从头重发。

**边界：** 只有内存存储与快照；没有 poison、节流、文档、分叉和 JSONL。主力 coding-agent 1.0
仍未使用 pi-durable。

**公开证据：** `3/3 → 2/2 → 3/3 → 2/2`，共 `10/10`。

**恢复：** 回到 parent `842d35ec4e60943a94d8df5389e728c7b75823eb` 后，第 13 章的 Runtime 与
第 15–18 章的机制照常运行，只是没有一个能在进程中途退出后接着干的 harness。
:::

:::transfer title="迁移练习 · 两个工具调用中途崩溃"
完成 `10/10` 后，在独立测试文件里让模型一次发出两个 `echo` 调用，并让第二次执行挂起：第一个
工具的结果已经提交，第二个工具正在执行时触发 signal。先写下预测：重新打开后哪个工具会再跑，
下一轮 generation 在哪次提交里出现，会话里两条 toolResult 的顺序是什么。再仿照测试里的
`observe()` 记录每次提交，对照预测。`durable.ts` 不需要为这个场景增加分支。
:::

## 小结

开篇那一轮对话被拆成十次提交。每次提交是一批写入，排在同一条变更线上，存储接受之后才有人
看得见。进程在工具执行中途退出时，存储里留着 `running` 的任务和它的意图；重新打开后，
`running` 回到 `pending`，存储里的 `replay` 与当前注册一起决定工具重跑，还是让模型读到一条
`interrupted`。模型流到一半的文字也已经提交过，恢复时成为一条 `aborted` entry，请求再从头
发一次。

这四个机制共享一个判断：先写下，再让人看见；副作用发生在两次提交之间，恢复时只相信存储。
第 13 章的 Runtime 在一轮结束后才提交，pi-durable 把提交点推进到了每一步之前。Pi 1.0 的
主力 coding-agent 还没有换到这条路上，它是 1.0 新确立的方向。

这也是全书的最后一个 checkpoint。序章里那条离线轨迹中的每一个环节，现在都有一份你亲手
写过的实现：事件流和消息语言，把模型挡在边界外的 provider，类型化的工具和可证明的循环，
可以中断的 Agent，追加式的会话树和从中派生的 context，资源、扩展和把它们接起来的 Runtime，
用来证明这一切的评测；第五部又在这个 Runtime 上加了工具暴露、codemode、MCP、虚拟模型和
durable 执行。读上游源码时，你已经知道每段代码在回答什么问题。之后 Pi 会继续变化，课程的类名
和 helper 不必跟着迁移，每一章那条不变量仍然适用。
