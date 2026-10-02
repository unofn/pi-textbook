---
id: "01"
slug: typescript-survival
part: foundations
partTitle: 第一部 · 建立可执行语言
chapter: "01"
title: TypeScript 生存集：四个 DemoEvent 怎样进入测试
summary: 跟随一组事件对象，读懂联合类型、分支收窄、unknown 验证，以及 ESM 测试怎样加载源码。
minutes: 75
difficulty: 入门
artifact: packages/pi-course/src/survival/events.ts
prerequisites: 00
terms: tagged union, narrowing, never, unknown, ESM, Promise, node:test
upstream: packages/agent/src/types.ts
---

## 你将得到什么

序章播放的是一条固定轨迹。现在把其中的事件缩小成四个普通对象：请求开始、文字到达、
请求完成、请求取消。它们共享 `type` 字段，却各自保存不同的数据。

```ts
{ type: "started", requestId: "r1" }
{ type: "delta", requestId: "r1", text: "Pi" }
{ type: "finished", requestId: "r1", reason: "stop" }
{ type: "aborted", requestId: "r2" }
```

课程代码会把这组对象格式化成四行文字：

```text
start r1
delta r1 Pi
finish r1 stop
abort r2
```

这条很短的数据链串起本节需要的 TypeScript：`type` 怎样帮助编译器区分对象，
`switch` 怎样逐分支收窄类型，外部的 `unknown` 怎样经过运行时检查，测试又怎样通过
ESM 导入编译后的文件。Promise 只保留后续异步流需要的两个动作：函数交出一个未来
结果，调用者用 `await` 等到它完成。

最终只新增一个文件：
`packages/pi-course/src/survival/events.ts`。前端、DOM、装饰器和复杂泛型都不在这条
轨迹上。

## `type` 区分四种事件

先给四个对象一个共同名字：

```ts
export type DemoEvent =
  | { type: "started"; requestId: string }
  | { type: "delta"; requestId: string; text: string }
  | {
      type: "finished";
      requestId: string;
      reason: "stop" | "length";
    }
  | { type: "aborted"; requestId: string };
```

竖线表示“其中一种”。`DemoEvent` 的值可以是 started、delta、finished 或 aborted，
但不会同时是其中两种。四个成员都带有字面量字段 `type`，所以它是一组带标签的联合
类型（tagged union）。

这个写法把合法字段组合写进类型。delta 一定有 `text`，finished 一定有 `reason`；
started 和 aborted 没有这两个字段。若把它们合并为
`{ type: string; text?: string; reason?: string }`，`started` 携带 `reason` 这样的无效
对象也会通过类型检查。

`event.type` 还会改变编译器对整个对象的认识：

```ts
function inspect(event: DemoEvent): string {
  if (event.type === "delta") {
    return event.text;
  }
  return event.requestId;
}

console.log(inspect({
  type: "delta",
  requestId: "r1",
  text: "Pi",
}));
```

输出是：

```text
Pi
```

进入 `event.type === "delta"` 的分支后，编译器已经排除另外三个成员，所以
`event.text` 可以直接读取。这个过程叫收窄（narrowing）。分支结束后，参数仍是完整的
`DemoEvent`。

:::rebuild title="Checkpoint 01 · 建立 TypeScript 协议证据"
**模式：** 重建

**起终点：** `parent` 是第 00 章完成后的起点；`target` 是 2 项聚焦测试通过的终点。

**教学文件：** `packages/pi-course/src/survival/events.ts`

**动手前只需知道：** 四种 `DemoEvent` 共享 `type` 标签；`formatEvent()` 根据标签
读取当前成员的字段；`readDelta()` 从 `unknown` 中检查并构造一条 delta。

**第一次红灯：** parent 还没有 `events.ts`。build 会报告
`Cannot find module '../src/survival/events.js'`。测试中的 `.js` 指向编译后的 ESM 文件，
不需要改成 `.ts`。

**第一步：** 先不看 target diff。创建教学文件，写出 `DemoEvent` 与
`formatEvent()`，运行第一项聚焦测试。随后补上 `readDelta()`，让两项测试一起通过。

**聚焦测试：** `packages/pi-course/test/01-typescript-survival.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 01`

**练习目录：** `npm run practice -w @pi/course -- 01`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/01-*.test.js`

**通过证据：** 2 项测试观察四种事件的格式与顺序、一条合法 delta，以及数字 `text`
被运行时边界拒绝。
:::

## `switch` 把事件写成文字

`formatEvent()` 收到一条 `DemoEvent`。每个 `case` 都用刚才的 `type` 标签选中一个
联合成员：

```ts
export function formatEvent(event: DemoEvent): string {
  switch (event.type) {
    case "started":
      return `start ${event.requestId}`;
    case "delta":
      return `delta ${event.requestId} ${event.text}`;
    case "finished":
      return `finish ${event.requestId} ${event.reason}`;
    case "aborted":
      return `abort ${event.requestId}`;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
```

把开头那四条事件交给它：

```ts
const events: DemoEvent[] = [
  { type: "started", requestId: "r1" },
  { type: "delta", requestId: "r1", text: "Pi" },
  { type: "finished", requestId: "r1", reason: "stop" },
  { type: "aborted", requestId: "r2" },
];

console.log(JSON.stringify(events.map(formatEvent), null, 2));
```

结果保留输入顺序：

```text
[
  "start r1",
  "delta r1 Pi",
  "finish r1 stop",
  "abort r2"
]
```

started 分支只能读取 started 的字段，delta 分支才能读取 `text`，finished 分支才能读取
`reason`。四个成员都处理完以后，`default` 中已经没有可能的值，所以 `event` 可以赋给
`never`。`never` 在这里表示“这条路径没有合法输入”。

以后给联合类型增加新成员时，漏改 `switch` 会改变这个结论。剩余的 `event` 不再是
`never`，编译器会把遗漏直接标在 `const unreachable: never = event` 这一行。

:::lab title="实践 1.1 · 格式化四种 DemoEvent"
**目标：** 让 `type` 标签选择正确字段，并让格式化结果保持事件顺序。

**文件：** `packages/pi-course/src/survival/events.ts`

**动作：**
1. 写出 started、delta、finished、aborted 四个联合成员。
2. 实现 `formatEvent()` 的四个 `case`。
3. 在 `default` 中加入 `never` 穷尽检查。
4. build 后只运行名称含“tagged union”的测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="tagged union" \
  packages/pi-course/dist/test/01-*.test.js
```

**预期：** `1/1`。实际数组依次是 `start r1`、`delta r1 Pi`、
`finish r1 stop`、`abort r2`。
:::

## `unknown` 在检查后变成 delta

上面的四个对象由课程代码创建，TypeScript 能检查它们。网络响应、配置文件和
`JSON.parse()` 的结果来自运行时。边界代码把这类值明确保存为 `unknown`：

```ts
const raw = '{"type":"delta","requestId":"r1","text":"Pi"}';
const value: unknown = JSON.parse(raw);
```

`unknown` 暂时不允许读取字段，因为程序还没有证据说明它是对象。`readDelta()` 逐项
建立这份证据：

```ts
export function readDelta(value: unknown): DemoEvent {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "delta" &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "text" in value &&
    typeof value.text === "string"
  ) {
    return {
      type: "delta",
      requestId: value.requestId,
      text: value.text,
    };
  }
  throw new Error("invalid delta event");
}
```

这些条件分三层建立证据。`typeof`、null 和数组检查先确认 `value` 是普通对象；`type`
字段再把它收窄到 `delta` 分支；最后，`requestId` 与 `text` 各自经过存在性和字符串检查。
到这一步，函数才读取两个数据字段并构造新的 delta。外部值上的其他字段不会顺便进入
Agent 协议。

用一条合法输入和一条非法输入观察边界：

```ts
console.log(JSON.stringify(
  readDelta({
    type: "delta",
    requestId: "r1",
    text: "Pi",
  }),
  null,
  2,
));

try {
  readDelta({ type: "delta", requestId: "r1", text: 42 });
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
```

输出是：

```text
{
  "type": "delta",
  "requestId": "r1",
  "text": "Pi"
}
invalid delta event
```

`as DemoEvent` 只能改变编译器看待一个值的方式，不会把数字 `42` 转成字符串，也不会
检查 JSON 中的任何字段。联合类型约束进程内已经可信的对象；`readDelta()` 负责外部值
进入这组类型之前的运行时检查。

:::lab title="实践 1.2 · 检查一条外部 delta"
**目标：** 让合法对象进入课程协议，让错误字段停在边界。

**文件：** `packages/pi-course/src/survival/events.ts`

**动作：**
1. 让参数保持 `unknown`，检查非 null 对象并排除数组。
2. 检查 `type`、`requestId` 和 `text`。
3. 从已经收窄的字段构造新的 delta 对象。
4. 非法输入抛出 `invalid delta event`，随后运行两项聚焦测试。

**运行：**

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/01-*.test.js
```

**预期：** `2/2`。合法对象格式化为 `delta r1 Pi`；`text: 42` 在
`readDelta()` 中被拒绝，`formatEvent()` 不会收到它。
:::

## ESM 测试加载编译后的文件

聚焦测试写在 TypeScript 文件中，却用 `.js` 后缀导入教学模块：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatEvent,
  readDelta,
  type DemoEvent,
} from "../src/survival/events.js";
```

这条路径描述的是 Node 最终要加载的文件。项目采用 `NodeNext` 与 ESM；`npm run build`
调用 `tsc`，把源码和测试一起写入 `dist`：

```text
src/survival/events.ts
        │ tsc
        ▼
dist/src/survival/events.js

test/01-typescript-survival.test.ts
        │ tsc
        ▼
dist/test/01-typescript-survival.test.js
        │ import ../src/survival/events.js
        └──────────────────────────────────▶ dist/src/survival/events.js
```

`DemoEvent` 只供编译器检查，所以 `type DemoEvent` 不会成为运行时导入。`formatEvent` 和
`readDelta` 会留在 JavaScript 中，由 Node 的测试运行器调用。这里把测试路径改成
`.ts`，反而会让编译后的 JavaScript 指向一个运行时不存在的文件。

一项测试固定四条输出，另一项测试观察 `unknown` 边界：

```ts
test("unknown 必须先通过运行时边界", () => {
  assert.equal(
    formatEvent(readDelta({
      type: "delta",
      requestId: "r1",
      text: "Pi",
    })),
    "delta r1 Pi",
  );
  assert.throws(
    () => readDelta({ type: "delta", requestId: "r1", text: 42 }),
    /invalid delta event/,
  );
});
```

完整运行使用 Node 的 TAP 输出。去掉每次都会变化的 duration，关键行是：

```text
TAP version 13
# Subtest: tagged union 的完成态覆盖所有事件
ok 1 - tagged union 的完成态覆盖所有事件
# Subtest: unknown 必须先通过运行时边界
ok 2 - unknown 必须先通过运行时边界
1..2
# tests 2
# pass 2
# fail 0
```

build 与测试提供不同证据。`tsc` 检查联合成员、分支字段和模块连接；`node --test`
把具体输入交给编译后的函数，再比较返回值和异常。两者都通过，才说明当前静态形状和
已覆盖行为同时成立。

## Promise 只增加“稍后得到结果”

下一章的事件会逐个到达，最终消息也要等到流结束才出现。这里用同一条 delta 看
Promise 的最小执行过程：

```ts
async function formatLater(event: DemoEvent): Promise<string> {
  return formatEvent(event);
}

const pending = formatLater({
  type: "delta",
  requestId: "r1",
  text: "Pi",
});

console.log("1 已拿到 Promise", pending instanceof Promise);
pending.then((value) => console.log("3 then 收到", value));
console.log("2 当前同步代码结束");
console.log("4 await 收到", await pending);
```

输出是：

```text
1 已拿到 Promise true
2 当前同步代码结束
3 then 收到 delta r1 Pi
4 await 收到 delta r1 Pi
```

调用 `formatLater()` 时，调用者立刻拿到 `Promise<string>`。`await pending` 暂停当前
async 函数或 ESM 模块的后续语句；第二行同步日志仍然先出现。当前同步代码退出后，
Promise 回调与 await continuation 才依次取得字符串。这条顺序直接显示：等待暂停的是
当前 async 控制流，不是整个 Node 进程；`formatEvent()` 产生的字符串也没有改变。

第 02 章会让 `next()` 返回等待下一条事件的 Promise。第 05 章会用
`for await...of` 顺序读取网络片段。多个工具何时可以并发、结果按什么顺序写回，会在
Agent Loop 已经出现后处理；这里不提前引入调度规则。

:::note title="两项测试覆盖到哪里"
聚焦测试覆盖四种事件的格式和顺序、一条合法 delta，以及数字 `text` 这一项边界反例。
`never` 对新联合成员的诊断来自 TypeScript 编译器；上面的 Promise 顺序是运行时观察，
没有进入这两项聚焦测试。第 02 章会把“稍后完成”放进真正逐条到达的事件流，再给等待
过程增加可执行证据。
:::

:::pi title="与上游 Pi v1.0.0 对照"
上游同样用带标签的联合类型表达消息和事件：`packages/ai/src/types.ts:610` 的 `Message`
按 `role` 区分，`:767` 的 `AssistantMessageEvent` 按 `type` 区分；
`packages/agent/src/types.ts:374` 的 `AgentMessage` 与 `:514` 的 `AgentEvent` 在此之上扩展。
`packages/agent/src/types.ts:1` 起的 `import type` 连接只存在于编译期的类型。8479bd8 时
`Message` 只有 user、assistant、toolResult 三种成员，1.0 增加了 `SystemMessage`
（`packages/ai/src/types.ts:522`），system prompt 从此作为消息留在 transcript 里，第 03 章
会讲这一点。
课程用四个 `DemoEvent` 练习同一组语言机制，没有复制上游的 Provider 字段、复杂泛型和
完整运行时验证。
:::

## 完成正常路径后的诊断实验

类型检查和行为测试可以分别撞出一次缺口。

第一种改动是在 `DemoEvent` 末尾临时加入：

```ts
| { type: "paused"; requestId: string }
```

保持 `formatEvent()` 不变，再运行 build。现有测试没有构造 paused，但 `default` 中的
`event` 已经可能是 paused，`never` 赋值会产生静态错误。

第二种改动保留所有类型，只把 delta 分支改成：

```ts
return `delta ${event.text}`;
```

这段代码的字段和返回类型都合法，所以 build 可以通过。聚焦测试会比较出
`delta Pi` 与 `delta r1 Pi` 的差异。

:::failure title="诊断 · 静态遗漏与行为偏差"
依次完成两次临时改动，每次只运行最小命令并记录第一处偏差。paused 实验恢复联合成员
后，build 应重新通过；delta 实验恢复 `requestId` 后，两项测试应回到 `2/2`。这两次
改动不进入最终实现。
:::

## 本节验收

:::checkpoint title="Checkpoint 01 · 四个 DemoEvent 通过两条证据链"
运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/01-*.test.js
```

结果应为 `2/2`。沿着同一组对象回答五个问题：

1. `type: "delta"` 怎样让编译器允许读取 `text`？
2. 新增联合成员却遗漏 `case` 时，`never` 行为什么会报错？
3. `text: 42` 在哪一步被拒绝？
4. 测试为什么导入 `events.js`，实际施工文件却是 `events.ts`？
5. 调用 async 函数后，Promise 与 `await` 分别代表什么？

确认练习中只修改 `packages/pi-course/src/survival/events.ts`。测试与 lockfile 保持原样。
`npm run checkpoint -w @pi/course -- 01` 可以重新查看 parent 与 target；
`npm run practice -w @pi/course -- 01 <新目录>` 会从同一 parent 创建新的隔离练习目录。
下一章会把 `DemoEvent` 的静态数组换成随时间到达的事件流。
:::

## 可选迁移练习

:::transfer title="迁移 · 定义下载事件"
独立定义 `queued | progress | completed | failed` 四种下载事件，并写一个穷尽的
`summarize()`。`progress` 保存百分比，`failed` 保存错误说明。再写
`readProgress(value: unknown)`，验证百分比是 0 到 100 的数字。新测试至少包含一个
合法值、一个越界值，以及四种事件的格式顺序。
:::

## 小结

四个 `DemoEvent` 都是普通对象。共享的 `type` 标签把它们组成联合类型，也让编译器在
分支中收窄到正确成员。`never` 检查联合成员是否全部处理；`readDelta()` 则用运行时
检查让外部 `unknown` 获得信任。

`tsc` 把 TypeScript 源码和测试编译成 ESM JavaScript，`node --test` 再观察具体行为。
async 函数交出 Promise，`await` 取得稍后完成的结果。下一章会把这些机制放进同一个
`EventStream`，让事件的到达时间也进入协议。
