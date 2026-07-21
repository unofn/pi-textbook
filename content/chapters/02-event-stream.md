---
id: "02"
slug: event-stream
part: foundations
partTitle: 第一部 · 建立可执行语言
chapter: "02"
title: EventStream：同一个对象怎样交付下一项和最终结果
summary: 跟随一个 EventStream 实例，观察 push、next 与 result 怎样在两种到达顺序下汇合。
minutes: 95
difficulty: 进阶
artifact: packages/pi-course/src/event-stream.ts
prerequisites: 01
terms: AsyncIterable, EventStream, queue, waiter, terminal event
upstream: packages/ai/src/utils/event-stream.ts
---

## 你将得到什么

上一章中的事件已经放在数组里，读取它们时不用等待。真实模型会分段返回内容：第一段
文字到达时，第二段可能还在网络上；界面想立刻显示第一段，Agent 又要等整条回复结束
后取得 stop reason、usage 和错误信息。

这一章始终使用同一个 `EventStream` 实例 `events`。生产者调用 `push()` 交出事件，
消费者调用异步迭代器的 `next()` 取下一项，也可以调用 `result()` 等最终结果。我们会
观察两种时间顺序：事件先到，以及消费者先等待。

```text
生产者                         同一个 events                         消费者
push(delta "A")  ───────▶  EventStream  ───────▶  next()
push(done "AB")  ───────▶       │        ───────▶  next()
                                  └──────────────▶  result() == "AB"
```

这里不连接网络，也不定义 Agent 消息。取消需要生产者观察 `AbortSignal`，不在
checkpoint 02 的实现范围内。我们只建立一条规则：

> 同一个结束动作要让迭代器停止，也要让 `result()` 得到最终值。

## 先手动读取同一个 events

先看完成后的调用方式。流里的事件只有两种：`delta` 携带过程片段，`done` 携带最终
字符串。

```ts
type Event =
  | { type: "delta"; value: string }
  | { type: "done"; value: string };

const events = new EventStream<Event, string>(
  (event) => event.type === "done",
  (event) => event.value,
);
```

构造器收到两个函数。第一个函数识别哪种事件会结束这条流；这种事件叫**终态事件**。
第二个函数从终态事件中取出 `result()` 要返回的值。`EventStream` 因此不需要认识
`delta` 或 `done` 的业务含义。

先不用 `for await...of`。手动取得迭代器，能直接看到每一次 `next()` 的结果：

```ts
const iterator = events[Symbol.asyncIterator]();

events.push({ type: "delta", value: "A" });
console.log(await iterator.next());

events.push({ type: "done", value: "AB" });
console.log(await iterator.next());
console.log(await iterator.next());
console.log(await events.result());
```

稳定输出是：

```text
{ value: { type: "delta", value: "A" }, done: false }
{ value: { type: "done", value: "AB" }, done: false }
{ value: undefined, done: true }
AB
```

输出里出现了两种容易混淆的“完成”。事件 `{ type: "done" }` 仍是流里的一项，所以
读取它的那次 `next()` 返回 `done: false`。下一次 `next()` 才用
`IteratorResult.done === true` 表示迭代器已经结束。与此同时，终态事件中的 `"AB"`
完成了 `events.result()`。

`for await...of` 只是替我们反复调用 `next()`，直到它返回 `done: true`：

```ts
for await (const event of events) {
  // 依次看到 delta 和终态事件
}
```

接下来把刚才的四次调用放慢，观察 `events` 内部的值怎样变化。

:::rebuild title="Checkpoint 02 · 让 push、next 与 result 汇合"
**模式：** 重建

**起终点：** `parent` 是第 01 章完成后的起点；`target` 是 2 项聚焦测试通过的终点。

**教学文件：** `packages/pi-course/src/event-stream.ts`

**动手前只需知道：** 事件先到时，`events` 把它放进一个数组；`next()` 先到时，
`events` 保存这次等待的 `resolve`；终态事件既是一项可读取的事件，也会给出最终值。

**第一次红灯：** parent 中还没有 `event-stream.ts`。首次 build 会报告
`Cannot find module '../src/event-stream.js'`。测试中的 `.js` 是编译后的导入路径；
你要创建对应的 `.ts` 源文件。

**第一步：** 先不看 target diff。运行 build，确认第一条错误；随后读“事件先到”这条
时间线，声明完整公共接口，只实现 queue 路径。

**聚焦测试：** `packages/pi-course/test/02-event-stream.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 02`

**练习目录：** `npm run practice -w @pi/course -- 02`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/02-*.test.js`

**通过证据：** 2 项测试分别固定“事件先到”和“等待先到”的输出；终态事件仍能被
`next()` 读取，`result()` 也从同一次结束中取得值。
:::

## 事件先到：它留在 queue 里

新建 `events` 时，还没有事件，也没有消费者在等待：

```text
queue = []
waiting = []
done = false
result = pending
```

生产者先交出第一项：

```ts
events.push({ type: "delta", value: "A" });
```

`push()` 检查出这不是终态。此时没有一项 `next()` 正在等待，`events` 只能暂存这条
事件。保存“已经到达、还没有被读取的事件”的数组叫 `queue`，也就是队列：

```text
queue = [delta "A"]
waiting = []
done = false
result = pending
```

消费者随后调用 `next()`。迭代器先看 queue，从头取出 `delta "A"`，立刻返回：

```text
next() → { value: delta "A", done: false }

queue = []
waiting = []
done = false
result = pending
```

再让终态事件先于下一次 `next()` 到达：

```ts
events.push({ type: "done", value: "AB" });
```

这一次 `push()` 做两件事。它用 `"AB"` 完成最终 Promise，并把 `done` 设为
`true`，表示以后不再接受新事件。终态事件本身仍然进入 queue：

```text
queue = [done "AB"]
waiting = []
done = true
result = fulfilled("AB")
```

现在内部已经是 `done = true`，queue 却还有一项。因此迭代器每次循环要按照固定顺序
检查：

```text
1. queue 有事件 → 交出队首事件
2. queue 为空且 done → 结束迭代
3. queue 为空且未结束 → 等待下一次 push
```

如果先检查 `done`，消费者会漏掉已经排队的终态事件。正确顺序下，接下来的两次
`next()` 分别得到：

```text
{ value: done "AB", done: false }
{ value: undefined, done: true }
```

:::predict title="终态已经排队时，next 先看哪里"
现在 `queue = [done "AB"]`，同时 `done = true`。若迭代器先检查 `done`，再检查
queue，消费者会观察到什么？`events.result()` 又会得到什么？
---answer
迭代器会直接结束，漏掉终态事件；`result()` 仍会得到 `"AB"`。同一个流由此出现两
份不一致的观察结果。迭代器要先清空 queue，再根据 `done` 结束。
:::

## events 保存三类状态

刚才的时间线需要三个容器和一个最终 Promise：

```ts
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiting: Array<
    (value: IteratorResult<T>) => void
  > = [];
  private done = false;
  private readonly finalResult: Promise<R>;
  private resolveFinalResult!: (result: R) => void;

  // constructor、push、end、result、异步迭代器
}
```

`queue` 保存已经到达的事件。`waiting` 保存已经发生、但还没有等到事件的
`next()`；其中每个回调就是一名等待者（waiter）。`done` 记录这条流是否已经结束。
`finalResult` 在构造时只创建一次，所以先后多次调用 `result()` 等待的是同一份最终
事实。

`push(event)` 的状态迁移可以先写成普通步骤：

```text
流已经结束
  → 忽略这次 push

收到终态事件
  → 从事件提取最终值
  → 完成 finalResult
  → 标记 done

仍有 waiter
  → 取出最早的 waiter，把 event 直接交给它

没有 waiter
  → 把 event 放到 queue 末尾
```

终态处理之后仍要继续走交付分支。这样，终态既会完成 `result()`，也会像普通事件一样
交给正在等待的消费者或进入 queue。

:::lab title="实践 2.1 · 让先到的事件排队"
**目标：** 复现 `push(delta) → push(done) → next() → next()`，同时取得最终值。

**文件：** `packages/pi-course/src/event-stream.ts`

**动作：**
1. 声明构造器、`push()`、`end(result)`、`result()` 和异步迭代器的完整公共接口。
2. 创建 queue、waiting、done 与 finalResult；暂未进入的分支可以抛出
   `new Error("not implemented in lab 2.1")`。
3. 实现 `push()`。终态先完成 finalResult，随后继续走普通事件的交付路径。
4. 实现迭代器的 queue 与 done 分支，只运行第一项聚焦测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="先到的事件" \
  packages/pi-course/dist/test/02-*.test.js
```

**领域输出：** 手动调用 `next()` 时，先读到 `delta "A"`，再读到 `done "AB"`，
第三次才得到迭代结束；`result()` 返回 `"AB"`。

**测试证据：** 局部测试应为 `1/1`，并比较事件顺序和最终字符串。
:::

## next 先到：它把 resolve 留在 waiting 里

重新创建一个空的 `events`，这次消费者先行动：

```ts
const iterator = events[Symbol.asyncIterator]();
const pending = iterator.next();
```

queue 为空，流也没有结束，所以 `next()` 还不能返回。迭代器创建一个 Promise，把它的
`resolve` 放进 `waiting`：

```text
queue = []
waiting = [resolve next #1]
done = false
pending = pending
result = pending
```

`waiting` 中的这一个 resolve 就是一名 waiter。它代表一项具体请求：“请把下一条
事件交给我。”

生产者随后推入 `delta "A"`：

```ts
events.push({ type: "delta", value: "A" });
```

`push()` 取出最早的 waiter，直接用这条事件完成它。事件已经交到消费者手里，无需再
进入 queue：

```text
queue = []
waiting = []
done = false

await pending
  → { value: delta "A", done: false }
```

所以每次 `push()` 只走一条交付路径：有 waiter 就直接交付，没有 waiter 才排队。
同一条事件不能既唤醒 waiter，又进入 queue，否则消费者会读到两次。

异步迭代器等待下一项的核心动作是：

```ts
const next = await new Promise<IteratorResult<T>>((resolve) => {
  this.waiting.push(resolve);
});
```

这段 `await` 暂停当前迭代器。它没有阻塞 JavaScript 继续执行；生产者仍能调用
`events.push(...)`，再由 `push()` 唤醒这一次等待。

## end() 在没有终态事件时关闭流

有时生产者已经在别处算出最终结果，没有一条终态事件需要交付。`end(result)` 提供这
条显式关闭路径：

```ts
events.end("A");
```

它完成 finalResult，把 `done` 设为 `true`，并把仍在 `waiting` 中的每一项请求唤醒为：

```text
{ value: undefined, done: true }
```

`end("A")` 不会制造 `{ type: "done" }` 事件。下一次 `next()` 只观察到迭代结束，
`result()` 则返回 `"A"`。这与 `push({ type: "done", value: "AB" })` 的区别是：

| 结束动作 | 迭代器是否读到终态事件 | `result()` |
|---|---:|---:|
| `push(done "AB")` | 是 | `"AB"` |
| `end("A")` | 否 | `"A"` |

两条路径共享同一个 finalResult 和同一个 `done`。`end()` 还会唤醒已经登记的 waiter，
防止它们在流关闭后一直等待。

:::lab title="实践 2.2 · 让先等待的 next 被唤醒"
**目标：** 复现 `next() → push(delta) → end(result)`，不借助定时器。

**文件：** `packages/pi-course/src/event-stream.ts`

**动作：**
1. queue 为空且流未结束时，创建 Promise，把它的 resolve 放进 waiting。
2. 下一次 `push()` 取出最早的 waiter，直接交付事件。
3. 实现 `end(result)`：完成最终值、标记结束，并把剩余 waiter 唤醒为 `done: true`。
4. 删除 Lab 2.1 的临时异常，运行两项聚焦测试。

**运行：**

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/02-*.test.js
```

**领域输出：** 第一项 `next()` 在 `push(delta "A")` 后返回该事件；`end("A")` 以后，
下一项 `next()` 返回 `done: true`，`result()` 返回 `"A"`。

**测试证据：** 完整聚焦测试应为 `2/2`。第二项测试直接比较 pending next 被唤醒后的
`IteratorResult`。
:::

## 四个调用现在怎样连起来

同一个 `events` 只维护一份状态。生产者与消费者谁先行动，决定事件暂时停在哪里：

```text
push 先到
  → 没有 waiter
  → event 进入 queue
  → 后来的 next 从 queue 取走

next 先到
  → queue 为空
  → resolve 进入 waiting
  → 后来的 push 直接唤醒 waiter

终态通过 push 到达
  → 完成 result
  → 终态仍交给 iterator
  → queue 清空后，iterator 才结束

显式 end(result)
  → 完成 result
  → 唤醒 waiter 为 done: true
  → 不额外生成事件
```

`result()` 没有另一套结束状态。它只返回构造时创建的 finalResult。终态 `push()` 或
`end()` 完成这一个 Promise，迭代器也由同一个 `done` 状态收口。

这一版只支持一个事件消费者。多个调用者可以等待同一个 `result()`；两个异步迭代器
却会争抢 queue 和 waiter，不会各自收到完整副本。如果界面和 Agent loop 都要观察
过程事件，上层需要显式转发。

`AsyncIterable` 也不限制生产速度。生产者持续调用 `push()`，消费者读取较慢时，queue
会继续增长。容量上限、暂停、丢弃与背压策略属于另一层；checkpoint 02 只固定交付和
结束语义。

:::note title="这里没有实现取消"
消费者从 `for await...of` 中 `break`，只表示它不再调用 `next()`。生产者不会因此
停止，`result()` 也不会自动完成。取消需要 `AbortSignal`、生产者协作和错误终态。
第 04 章处理开始前已经取消的模型调用，第 05 章处理传输中的取消，第 09 章再由
`Agent` 管理一次运行的控制器。
:::

:::note title="两项测试覆盖到哪里"
聚焦测试覆盖 queue 路径、waiter 路径、可观察终态和显式 `end()`。它们没有证明多个
事件消费者、背压、错误终态或取消已经实现。测试使用固定事件和手动 next，因此也不
涉及真实网络与调度延迟。
:::

:::pi title="与当前上游 Pi 对照"
固定提交 `8479bd8` 的 `packages/ai/src/utils/event-stream.ts` 也让
`EventStream<T, R>` 实现 `AsyncIterable<T>`，并提供 `result(): Promise<R>`。
上游的 `AssistantMessageEventStream` 把 `done` 和 `error` 都识别为终态。课程此处
保留更小的单消费者容器；消息、错误与取消在后续 checkpoint 接入。
:::

## 完成正常路径后再做一次诊断

临时让终态完成 `result()` 后立刻返回：

```ts
if (this.isComplete(event)) {
  this.done = true;
  this.resolveFinalResult(this.extractResult(event));
  return;
}
```

此时 `events.result()` 仍能得到 `"AB"`，迭代器却只读到 `delta "A"`。第一处偏差
发生在终态的交付路径：它没有进入 queue，也没有交给 waiter。

:::failure title="诊断 · result 完成了，迭代器漏掉终态"
加入上面的 `return`，运行聚焦测试。先用手动 `next()` 确认领域输出只剩 delta，再看
测试报告的事件序列差异。删除 `return`，让终态继续走普通交付路径；恢复后手动输出与
`2/2` 测试都应回到正常状态。
:::

## 本章验收

:::checkpoint title="Checkpoint 02 · 两种到达顺序都能结束"
运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/02-*.test.js
```

结果应为 `2/2`。测试之外，再对同一个 `events` 手动说明四次状态变化：

1. `push(delta)` 发生时没有 waiter，事件停在哪里；
2. `next()` 发生时 queue 为空，哪一个值被保存在 waiting；
3. `push(done)` 为什么既完成 `result()`，又仍被 `next()` 读到；
4. `end(result)` 怎样结束已有 waiter，而不生成终态事件。

确认只修改 `packages/pi-course/src/event-stream.ts`。重新定位起终点可运行
`npm run checkpoint -w @pi/course -- 02`；创建新的隔离练习目录可运行
`npm run practice -w @pi/course -- 02 <新目录>`。第 03 章会把这里的通用 `T` 和 `R`
换成 Agent 的消息与最终回复。
:::

## 可选迁移练习

:::transfer title="迁移 · 用同一容器传送字节块"
定义 `ByteEvent = chunk | complete`。`chunk` 携带 `Uint8Array`，`complete` 携带总字节
数。复用现有 `EventStream<ByteEvent, number>`，分别写出“两个 chunk 先到”和
“next 先等待”两条测试。两条路径都要观察事件顺序、迭代结束和 `result()`；不加入
取消、网络或新的流实现。
:::

## 小结

一个 `EventStream` 同时接住生产者和消费者。事件先到时进入 queue；`next()` 先到时，
它的 resolve 作为 waiter 留在 waiting。后来的动作会取出另一边已经保存的值。

终态事件完成 finalResult，也继续交给迭代器。queue 清空后，`done` 才让迭代器停止。
`end(result)` 则在没有终态事件时显式关闭流。下一章会为这条时间协议加入 Agent 自己
的消息类型。
