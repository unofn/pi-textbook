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
finalResult = pending
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
finalResult = pending
```

消费者随后调用 `next()`。迭代器先看 queue，从头取出 `delta "A"`，立刻返回：

```text
next() → { value: delta "A", done: false }

queue = []
waiting = []
done = false
finalResult = pending
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
finalResult = fulfilled("AB")
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

## events 保存两条交付队列和一条完成状态

刚才的时间线落在五个字段上：两个数组、一个布尔值，以及构造时配成一对的 Promise 与
resolver：

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

`queue` 保存已经到达、尚未读取的事件；`waiting` 保存已经调用 `next()`、尚未得到事件
的 resolver。`done` 是流的结束标记。构造器创建 `finalResult` 时，把它的 resolve 函数
保存为 `resolveFinalResult`；`result()` 始终返回这个 `finalResult`，所以多个调用者等待
的是同一个最终值。

`push(event)` 按函数入口时的旧状态决定是否接收本次事件：

```text
1. 入口读取 done
   ├─ 原来就是 true  → 返回，本次 event 不再进入流
   └─ 原来是 false   → 继续处理本次 event

2. 检查本次 event
   ├─ 普通事件        → 完成状态不变
   └─ 终态事件        → 提取最终值，置 done = true，完成 finalResult

3. 交付本次 event；这里不重新用新的 done 状态拦截它
   ├─ waiting 非空    → 取出最早的 waiter，返回 { value: event, done: false }
   └─ waiting 为空    → queue.push(event)
```

第 2 步把 `done` 改成 `true`，只影响下一次 `push()` 和 queue 清空后的 `next()`。当前这
条终态事件已经通过入口检查，因此仍执行第 3 步：它会交给 waiter 或进入 queue，不会被
刚写入的新 `done` 状态吞掉。

:::lab title="实践 2.1 · 让先到的事件排队"
**目标：** 复现 `push(delta) → push(done) → next() → next()`，同时取得最终值。

**文件：** `packages/pi-course/src/event-stream.ts`

**动作：**
1. 声明构造器、`push()`、`end(result)`、`result()` 和异步迭代器的完整公共接口。
2. 创建 queue、waiting、done 与 finalResult；暂未进入的分支可以抛出
   `new Error("not implemented in lab 2.1")`。
3. 实现 `push()`。终态写入 done、完成 finalResult，随后继续走本次事件的交付路径。
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
finalResult = pending
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

## 四个公开调用各改哪一份状态

前面的两条时间线可以收成一张状态查找表：

| 调用时的状态 | 本次动作 | 调用者观察到什么 |
|---|---|---|
| `push(event)`，入口 `done === true` | 状态不变 | 本次事件不进入流 |
| `push(event)`，入口 `done === false` | 若本次是终态，写入 `done` 并完成 `finalResult`；随后交给 waiter 或 queue | 本次事件仍以 `done: false` 交付 |
| `next()`，queue 非空 | 取出队首 | 立即得到一条事件 |
| `next()`，queue 为空且 `done` | 状态不变 | `{ value: undefined, done: true }` |
| `next()`，queue 为空且未结束 | resolver 进入 waiting | Promise 等待下一次 `push()` 或 `end()` |
| `end(result)` | 尚未结束时完成最终值；置 `done` 并结束现有 waiter | 迭代结束，不生成事件 |
| `result()` | 返回同一个 `finalResult` | 等到唯一的最终值 |

当前 `EventStream` 的直接范围是一名事件消费者：queue 与 waiting 由这个消费者使用；两个
异步迭代器会争抢同一批事件，而不是各得一份副本。第 03 章把 `T/R` 换成 Agent 消息并
加入错误终态，第 04、05 章接入模型行为与传输，第 09 章再由运行控制器管理取消。

:::pi title="与上游 Pi v1.0.0 对照"
1.0 的 `packages/ai/src/utils/event-stream.ts:26` 仍让 `EventStream<T, R>` 实现
`AsyncIterable<T>`，`:86` 提供 `result(): Promise<R>`。同一文件 `:91-101` 的
`AssistantMessageEventStream` 在这个通用容器上把 `done` 和 `error` 识别为终态，并从两者
提取最终 `AssistantMessage`。这一分工与 8479bd8 时相同：通用类不认识消息业务类型；第 03 章
会沿用同一分工完成课程里的消息特化。
:::

## 完成正常路径后再做一次诊断

:::failure title="诊断 · result 完成了，迭代器漏掉终态"
临时让终态完成 `result()` 后立刻返回：

```ts
if (this.isComplete(event)) {
  this.done = true;
  this.resolveFinalResult(this.extractResult(event));
  return;
}
```

运行聚焦测试后，`events.result()` 仍得到 `"AB"`，事件序列却只剩 `delta "A"`。这项
差异直接定位到多出的 `return`：终态没有继续进入 waiter 或 queue。删除它以后，事件
序列恢复为 `delta → done`，两项测试回到 `2/2`。
:::

## 本章验收

:::checkpoint title="Checkpoint 02 · 两种到达顺序都能结束"
运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/02-*.test.js
```

结果应为 `2/2`：第一项同时观察 queue 中的 `delta → done` 和最终值 `"AB"`；第二项观察
waiting 中的 `next()` 被 `push(delta)` 唤醒，并由 `end("A")` 结束同一个流。

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

`EventStream` 在一个生命周期上提供两个观察接口：异步迭代器读取每条已接收事件，
`result()` 等待唯一的最终值。queue 与 waiting 解决事件和消费者谁先到，`done` 与
finalResult 共同收束结束。下一章会保持这套时间协议，只把 `T/R` 换成 Agent 的消息与
最终回复。
