---
id: "16"
slug: codemode
part: advanced
partTitle: 第五部 · Pi 1.0 进阶
chapter: "16"
title: Codemode：让模型写脚本调用工具
summary: 为每次执行新建 worker 与 QuickJS 虚拟机，让脚本里的 tools.<name>(args) 经消息桥回到宿主，以 script 作用域走既有执行路径，并由宿主持有 deadline 与取消。
minutes: 150
difficulty: 进阶
artifact: packages/pi-course/src/codemode.ts
prerequisites: 06,07,15
terms: codemode, worker thread, QuickJS, message bridge, nested tool call, deadline
upstream: packages/codemode/src/runtime/host.ts, packages/codemode/src/runtime/worker.ts, packages/codemode/src/runtime/protocol.ts, packages/codemode/src/runtime/prelude-source.ts, packages/coding-agent/src/core/nested-tool-calls.ts, packages/coding-agent/src/extensions/codemode/execute.ts, packages/coding-agent/src/extensions/codemode/tool.ts
---

## 第 15 章的可调用集合还没有调用者

第 15 章结束时，注册表能给出两个集合。对 `read`（`direct`）和 `mcp_github_issues`
（`deferred`）这张表，声明集合只有 `read`，可调用集合是 `read, mcp_github_issues`。
`executeToolCall(call, registry, context, "script")` 已经会按可调用集合把门，但整个课程里还没有
哪段代码以 `"script"` 作用域调用它。

模型想同时拿到两个工具的结果时，目前只有一条路：在 assistant 消息里发两个 call。若其中一个
是 `deferred` 工具，还要先调用 `tool_search`，多一次请求。每个中间结果都写进 transcript，
下一次请求时整段交还给模型，哪怕模型只需要把两段文字拼起来。

`codemode` 工具换了一种方式：模型写一段 JavaScript，脚本在沙箱里调用工具、处理中间结果，
只把最后 `return` 的值交回模型。本章固定一次运行作为地图。注册表里有三个工具：

```text
read                 direct        read returns its value
mcp_github_issues    deferred      mcp_github_issues returns its value
codemode             model-only    createCodemodeTool(registry)
```

模型只发出一个 call，参数是一段脚本：

```js
const [a, b] = await Promise.all([
  tools.read({ value: "1" }),
  tools.mcp_github_issues({ value: "2" }),
]);
return a.text + "|" + b.text;
```

loop 结束后的 transcript 只有五条消息：

```text
0  user        go
1  system      toolsAdded: read, codemode
2  assistant   c1 codemode { code: … }
3  toolResult  c1 content = JSON.stringify("read:1|mcp_github_issues:2")
               details.nestedCalls.calls = [c1/1 read ok, c1/2 mcp_github_issues ok]
4  assistant   done
```

两次请求的 `tools` 都是 `read, codemode`，`currentTools()` 重放结果也一样。
`mcp_github_issues` 运行了一次，却从未被声明。

这条 trace 里有本章要建立的四件事：

1. 脚本在一个新建的 worker 线程里、一个新建的 QuickJS 虚拟机中运行，宿主线程从不执行脚本
   代码；
2. `tools.<name>(args)` 变成线程之间的消息，参数和结果都以 JSON 字符串过桥；
3. 每次嵌套调用都是一个 id 为 `c1/<n>` 的 ToolCall，以 `script` 作用域走第 06 章的校验与
   执行；它不写进 transcript，只在父结果的 `details.nestedCalls` 里留下有界记录；
4. 宿主持有 deadline 与取消信号；脚本失败、超时或被取消都变成 `isError` 的工具结果，loop
   照常继续或收口。

## 三个参与者与两种消息

一次 `codemode` 执行有三个参与者：

```text
宿主（主线程）            worker 线程                   QuickJS VM（wasm 实例）
codemode.ts               codemode-worker.ts            prelude + 脚本
Execution                 创建 VM、转发消息             tools / ALL_TOOLS / console
持有工具表、pending、     不执行工具，不解析 JSON        没有计时器、I/O、fetch、
deadline、signal                                        require 或模块
```

把脚本放进 worker，是为了让宿主线程始终空闲。脚本写成 `for (;;) {}` 时，如果 VM 跑在主线程
上，宿主的 `setTimeout` 永远等不到触发的机会；放在 worker 里，主线程的计时器照常到期，宿主
再去终止那条线程。每次执行都新建 worker 和 VM，上一段脚本留下的全局变量不会被下一段看见，
终止时也不用担心伤到别的执行。

线程之间只传两类消息。worker 发给宿主的有四种：

```ts
type WorkerToHostMessage =
  | { type: "call"; id: number; name: string; args: string | undefined }
  | { type: "output"; text: string }
  | { type: "done"; ok: true; value: string | undefined }
  | { type: "done"; ok: false; error: ScriptErrorJson }
  | { type: "crash"; message: string };
```

宿主发给 worker 的只有一种：

```ts
interface HostToWorkerMessage {
  type: "result";
  id: number;
  ok: boolean;
  payload: string | undefined; // ok 时是结果 JSON，否则是错误信息
}
```

这两组类型和 VM 内的 prelude 都在 `codemode-protocol.ts` 里，practice 直接给出，与参考实现
相同。prelude 是一段在脚本之前求值的 JavaScript，返回 `{ settle, run, stalled }` 三个函数：
`run(fn)` 运行脚本，`settle(id, ok, payload)` 结算一次工具调用，`stalled()` 在“没有调用在途、
脚本却还没结束”时报告失败。它还在 VM 里搭出 `tools`、`ALL_TOOLS` 和 `console`。

一次 `await tools.add({ a: 2, b: 3 })` 的往返是：

```text
VM      prelude: id = 1，pending.set(1)，bridge("call", 1, "add", '{"a":2,"b":3}')
worker  post { type: "call", id: 1, name: "add", args: '{"a":2,"b":3}' }
宿主    handleCall：记录 { name: "add", status: "cancelled" }，pending.set(1)
        JSON.parse(args) → tool.execute(args, { signal }) → 5
        pending.delete(1) 成功 → status = "ok" → post { type: "result", id: 1, ok: true, payload: "5" }
worker  settle(1, true, "5") → executePendingJobs() → stalled()
VM      脚本从 await 处继续 → console.log → bridge("output", "sum is 5")
        return 值 → bridge("done", true, json)
宿主    finish：置中断标志 → worker.terminate() → resolve 结果
```

worker 自始至终只搬运字符串。参数在宿主侧 `JSON.parse`，所以工具收到的是宿主 realm 里的
普通对象，原型就是 `Object.prototype`。

## 建立练习起点

在教学历史仓库中生成隔离练习：

```bash
cd <你的工作区>/pi-course
npm run checkpoint -w @pi/course -- 16
npm run practice -w @pi/course -- 16 <新目录>
cd <新目录>
npm install
```

本章给 `@pi/course` 加入第一个运行时依赖 `quickjs-wasi@3.6.2`。practice 已经把本章的
`package.json` 放进沙箱，`npm install` 才会装上它；跳过这一步，每次执行都会以
`Failed to load QuickJS` 的 sandbox 错误结束。宿主从编译产物
`dist/src/codemode-worker.js` 创建 worker，所以每次改完都要先 build 再跑测试。第一次执行会
编译 `quickjs.wasm`，之后进程内复用。

本章修改两个文件，第三个文件是给定的协议：

```text
packages/pi-course/src/codemode-worker.ts     worker 入口：VM、桥接、脚本求值
packages/pi-course/src/codemode.ts            宿主、嵌套桥、deadline 与取消、codemode 工具
packages/pi-course/src/codemode-protocol.ts   消息类型与 prelude（给定，不修改）
```

:::rebuild title="Checkpoint 16 · 在独立 VM 里运行模型写的脚本"
**模式：** 重建。从第 15 章的可调用集合开始，只增加一个能运行脚本的沙箱和一个 `model-only`
的 `codemode` 工具。

**起终点：** `parent` `6a8eff4e26ed662861fe0199ddca582dcc4ea4ca` 是起点；`target` `ff14a103b53fe07b304e73d82364d69bdcb60cf8` 是终点。

**教学文件：** `packages/pi-course/src/codemode-worker.ts`、
`packages/pi-course/src/codemode.ts`；`packages/pi-course/src/codemode-protocol.ts` 是给定协议。

**学习脚手架：** `starters/16-codemode.ts` 固定脚本结果、嵌套记录与 `codemode` 工具的公共
表面，并保留 `Execution` 的 `handleMessage()` 与 `finish()`；`starters/16-codemode-worker.ts`
保留 worker 的辅助函数与入口，注释里列出 VM 的五个步骤。

**动手前只需知道：** 宿主、worker、VM 三个参与者；worker 发 `call` / `output` / `done` /
`crash`，宿主回 `result`；参数、结果、返回值都是 JSON 字符串。宿主为每个 call 先记一条
`cancelled` 记录，执行完成且 `pending` 里还有这个 id 时才改状态并回复。

**第一步：** 先实现 `Execution.handleCall()`，再实现 `Execution.start()`，最后实现 worker 的
`main()`。`handleCall()` 要等 `start()` 接上 `message` 监听后才会被调用，先写好它，接上 worker
时就不会撞进 starter 的异常。

**第一次红灯：** fresh starter 可以 build；只运行 Lab 16.1 时四项都失败，脚本结果是
`{ ok: false, error: { kind: "sandbox", message: "Lab 16.1 Execution.start 尚未实现" } }`。
实现 `start()` 之后，红灯换成 worker 报告的 `Error: Lab 16.1 codemode worker 尚未实现`。

**聚焦测试：** `packages/pi-course/test/16-codemode.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 16`

**练习目录：** `npm run practice -w @pi/course -- 16`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/16-*.test.js`。

**施工顺序：** 沙箱与消息桥 `4/4` → 嵌套调用与有界记录 `3/3` → deadline 与取消 `2/2` →
`codemode` 工具与 loop 接入 `3/3`。

**通过证据：** 四个 Lab 依次变绿，最后本章 `12/12`；第 15 章的 `12/12` 保持不变。

第一次尝试先不看 target diff。卡住时先判断偏差出在宿主、worker 还是 VM。
:::

验证起点：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 16.1" \
  packages/pi-course/dist/test/16-*.test.js
```

正确结果是 `0/4`。四项的实际结果都是 `kind: "sandbox"` 的失败；第一项 `deepEqual` 的差异里
能直接看到 `Lab 16.1 Execution.start 尚未实现`。

## Lab 16.1：一个 worker、一个 VM、一条消息桥

### 宿主收到 call

`handleCall()` 处理一条 `call` 消息。记录先写成 `cancelled`：若执行途中宿主已经结束（超时或
取消），这条记录就保持 `cancelled`，不用再补写。

```ts
const { id, name } = message;
const record: CodemodeCall = { name, status: "cancelled" };
this.calls.push(record);
const pending: PendingCall = { record, controller: new AbortController() };
this.pending.set(id, pending);

let status: CodemodeCallStatus;
let reply: HostToWorkerMessage;
try {
  const tool = this.tools.get(name);
  if (!tool) throw new Error(`Unknown tool "${name}"`);
  const args: unknown =
    message.args === undefined ? undefined : JSON.parse(message.args);
  const value = await tool.execute(args, { signal: pending.controller.signal });
  reply = {
    type: "result", id, ok: true,
    payload: value === undefined ? undefined : JSON.stringify(value),
  };
  status = "ok";
} catch (error) {
  reply = { type: "result", id, ok: false, payload: errorMessage(error) };
  status = "error";
}
if (!this.pending.delete(id)) return;
record.status = status;
this.post(reply);
```

最后三行的顺序有意义。`finish()` 会清空 `pending`，所以 `delete` 返回 `false` 说明宿主已经
收口：不改状态，也不再给正在消失的 worker 回消息。工具抛错只影响这一次回复，`payload`
是错误信息，脚本里对应的 promise 被 reject。

### 宿主启动 worker

`start()` 组装 `CodemodeWorkerData`，创建 worker，再挂三个监听：

```text
workerData = { code, tools: [{ name, description }], wasm, memoryLimitBytes, interrupt }
new Worker(workerUrl(), { workerData })   失败 → finish({ kind: "sandbox" })
worker.unref()                            宿主持有 promise，worker 不阻止进程退出
on("message") → handleMessage()
on("error")   → finish({ kind: "sandbox", name, message })
on("exit")    → finish({ kind: "sandbox", message: "Worker exited with code … before the script settled" })
```

`start()` 开头先检查 `this.finished`：调用方的 signal 可能在 wasm 编译期间就已经触发。
`wasm` 是编译好的 `WebAssembly.Module`，structured clone 让 worker 共享编译结果。`finish()`
在 `terminate()` 后也会触发一次 `exit`，那时 `finished` 已经是 `true`，这次 `finish()` 什么也
不做。

### worker 创建 VM 并接上桥

starter 注释列出了 `main()` 的五步：

```text
1. QuickJS.create({ wasm, memoryLimit, maxStackSize: MAX_STACK_SIZE, interruptHandler, wasi })
   interruptHandler 读取 interrupt 里的 Int32，非零就让 VM 停下
2. vm.newFunction("bridge", …) 把 prelude 的 call / output / done 转成 post()
3. 求值 PRELUDE_SOURCE 并调用它，得到 { settle, run, stalled }
4. 把脚本包成 (async (tools, console) => {<code>\n})；解析失败按 JSException 报 done:false
5. run(fn) 之后 executePendingJobs()，再调用 stalled()
```

第 3 步之后要监听 `parentPort` 的 `result` 消息。这里有一处注释没写出的细节：每次调用
`settle()` 之后，也要做第 5 步的两件事。

```ts
const drain = () => {
  vm.executePendingJobs();
  vm.callFunction(stalled, api).dispose();
};

parentPort?.on("message", (message: unknown) => {
  if (!isHostToWorkerMessage(message)) return;
  try {
    vm.withScope(() => {
      vm.callFunction(
        settle, api,
        vm.newNumber(message.id),
        message.ok ? vm.true : vm.false,
        message.payload === undefined ? vm.undefined : vm.newString(message.payload),
      );
    });
    drain();
  } catch (error) {
    crash(error);
  }
});
```

`settle()` 只把 promise 标记为已解决，`await` 之后的代码要等 `executePendingJobs()` 才会运行。
漏掉这次 `drain()`，脚本会永远停在第一个 `await tools.add(...)`；Lab 16.1 还没有缺省 deadline，
测试会一直等到自己的 10 秒上限。

第 4 步的包装让脚本成为一个 async 函数体，`return` 与顶层 `await` 都能用：

```ts
fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
```

前缀和脚本第一行在同一行，报错的行号就是脚本原本的行号。

### 四项测试观察什么

**往返。** 开头的 `tools.add` 脚本得到：

```text
{ ok: true,
  value: { doubled: 10, names: ["add"], kind: "function" },
  output: ["sum is 5"],
  calls: [{ name: "add", status: "ok" }] }
```

**失败都变成结果。** `throw new TypeError("nope")` 得到 `kind: "script"`，`name`、`message`、
`stack` 来自脚本里的错误；`return (;` 在 `evalCode` 时抛出 `JSException`，worker 直接报
`done:false`，`name` 是 `SyntaxError`。工具 `boom` 抛错时，脚本捕获就得到
`"caught: boom failed"` 且 `ok: true`；不捕获则 `ok: false`、`message` 是 `boom failed`。两种
情况下 `calls` 都记为 `{ name: "boom", status: "error" }`。宿主一次也没有抛异常。

**每次都是新 VM。** 第一段脚本写 `globalThis.leak = 1`，第二段读到的是 `undefined`。把
`memoryLimitBytes` 设为 16 MiB 后不停分配数组，QuickJS 在脚本内部抛出 out of memory 错误，
结果 `kind` 是 `script`，worker 和宿主都还完好。

**没有计时器。** `await new Promise(() => {})` 之后没有任何调用在途，VM 里也没有计时器或
I/O 能唤醒它。`run` 之后的那次 `drain()` 里，`stalled()` 发现这种状态，立刻以
`… can never settle …` 结束，测试要求 4 秒内返回。

:::lab title="实践 16.1 · 建立 worker、VM 与消息桥"
**目标：** 让 `runCodemodeScript()` 在一个新 worker 的新 VM 里运行脚本，工具调用经消息桥
往返，所有失败都以 `{ ok: false }` 返回。

**文件：** `packages/pi-course/src/codemode.ts`、`packages/pi-course/src/codemode-worker.ts`

**动作：**
1. 实现 `Execution.handleCall()`：先登记 `cancelled` 记录与 `pending`，解析参数、执行工具，
   `pending` 仍有该 id 时才改状态并回复；
2. 实现 `Execution.start()`：组装 workerData，创建 worker，`unref()`，挂 `message` / `error`
   / `exit` 监听；
3. 实现 worker 的 `main()`：按五步创建 VM 与桥，`settle()` 之后与 `run()` 之后都执行
   `drain()`。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 16.1" packages/pi-course/dist/test/16-*.test.js`。

**预期：** `4/4`。四项分别证明：工具调用经桥往返且返回值按 JSON 回到宿主；脚本抛错、语法
错误、工具拒绝都变成 `ok:false` 或被脚本捕获；全局变量不跨执行泄漏，内存上限下的失控分配以
out of memory 失败；等待永不结算的 promise 立刻以 stalled 失败。
:::

## Lab 16.2：嵌套调用走第 06/15 章的执行路径

`runCodemodeScript()` 接收的工具表是一张普通函数表：

```ts
type CodemodeToolFunction = (
  args: unknown,
  context: { signal: AbortSignal },
) => Promise<unknown>;
```

`createNestedToolBridge(registry, parentCallId, options)` 把注册表的可调用集合变成这样一张
表。表里每个函数做同一件事：把脚本的调用包装成一个 ToolCall，交给第 06 章的
`executeToolCall`，作用域是 `"script"`。

```ts
for (const tool of registry.callable()) {
  tools.set(tool.name, {
    description: tool.description,
    async execute(args, context) {
      const call: ToolCall = {
        type: "toolCall",
        id: `${parentCallId}/${count + 1}`,
        name: tool.name,
        arguments: args,
      };
      const record = start(call);
      const signal = options.signal
        ? AbortSignal.any([options.signal, context.signal])
        : context.signal;
      // execute(call, { signal }) → isError 则记录并抛错；成功则记 ok，
      // 返回 { text: textOf(result), details? }
    },
  });
}
```

省略的部分只有三种结局：

```text
result.isError === false   → status "ok"，返回 { text, details? }
result.isError === true    → status 为 signal.aborted ? "cancelled" : "error"，
                             throw new Error(textOf(result))
execute 本身抛出           → 同样按 signal 区分 cancelled / error，再抛出
```

缺省的 `execute` 是 `(call, context) => executeCoreToolCall(call, registry, context, "script")`。
调用方也可以通过 `options.executeToolCall` 注入别的执行器，比如第 12 章 Extension Host 包过
的版本；课程缺省不经过 hook。

### 表里只有可调用集合

对 `read`、`mcp_github_issues`（`deferred`）、`tool_search`（`model-only`）、`secret`
（`hidden`）这张注册表，桥的工具表只有前两个：

```text
bridge.tools.keys()   read, mcp_github_issues
```

脚本读取 `tools.tool_search` 时，prelude 的 Proxy 立刻抛出 TypeError，而不是等到调用时才报
“not a function”：

```text
TypeError: tools.tool_search does not exist. Available: read, mcp_github_issues. ALL_TOOLS lists every tool.
```

名字接近时给出建议。`return tools.readFile;` 去掉大小写和符号后是 `readfile`，包含 `read`，
于是错误里有 `Did you mean tools.read?`。

两次成功调用的 id 是 `call-1/1` 和 `call-1/2`，工具在 `context.callId` 里收到的就是这两个值。
脚本拿到的值是 `{ text: "read:x", details: { name: "read" } }` 这样的对象。

### 一个失败只影响自己

脚本用 `Promise.allSettled` 同时发出四个调用：

```text
call-2/1   ok({ value: "1" })        → "ok:1"
call-2/2   failing({ value: "2" })   → rejected: Tool failing failed: failing exploded
call-2/3   ok({ value: 3 })          → rejected: Tool ok failed: … 必须是 string
call-2/4   ok({ value: "4" })        → "ok:4"
```

第三个调用的参数在 `schema.parse()` 时失败，工具没有运行，所以 `ok.runs` 是 2。两种失败都由
`executeToolCall` 变成 `isError` 结果，再在桥里变成这一次调用的 reject；同批另外两个调用照常
完成。记录里 `call-2/2` 的 `error` 带着 `failing exploded`，任何记录都没有 `result` 字段。

### 记录有上限

`NESTED_CALL_LIMITS` 规定记录的上限：最多 256 条，单次参数 8 KiB，参数合计 32 KiB，错误
文字 500 字符。超过上限的调用照样执行，只是记录被省略或截断，`complete` 变成 `false`。

测试把上限调成 `maxCalls: 2`、`maxArgumentBytesPerCall: 32`，脚本依次传入 `"a"`、40 个 `x`、
`"c"`、`"d"`：

```text
tool.runs      4
tool.callIds   call-3/1, call-3/2, call-3/3, call-3/4
nestedCalls()  {
  calls: [
    { id: "call-3/1", name: "echo", status: "ok", arguments: { value: "a" } },
    { id: "call-3/2", name: "echo", status: "ok", argumentsBytes: 52 },
  ],
  count: 4,
  complete: false,
}
```

第二次的参数 JSON 是 `{"value":"` 加 40 个 `x` 再加 `"}`，共 52 字节，超过 32，只记字节数。
第三、四次调用时记录已满，`count` 继续增加，id 照样编号，记录不再追加。

:::failure title="失败注入 · 嵌套调用忘了 script 作用域"
Lab 16.2 通过后，临时把缺省执行器的第四个参数删掉：

```ts
((call, context) => executeCoreToolCall(call, registry, context))
```

运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 16.2 · 嵌套调用走" \
  packages/pi-course/dist/test/16-*.test.js
```

`tools.read` 仍然成功，`tools.mcp_github_issues` 却得到 `工具未声明给模型`，脚本不捕获，于是
`result.ok` 变成 `false`。第 15 章的作用域缺省是 `"model"`，只认声明集合。恢复第四个参数
`"script"` 后回绿，`deferred` 工具重新可以在脚本里调用。
:::

:::lab title="实践 16.2 · 实现嵌套工具桥"
**目标：** 让脚本的每次工具调用都成为一个 `<parent>/<n>` 的 ToolCall，走既有的校验与执行，
并留下有界记录。

**文件：** `packages/pi-course/src/codemode.ts`

**动作：**
1. 合并 `NESTED_CALL_LIMITS` 与 `options.limits`；
2. 写 `start(call)`：`count` 加一，记录满了就标记不完整并返回 `undefined`；参数 JSON 超过
   单次或合计上限时只记 `argumentsBytes`；
3. 为 `registry.callable()` 的每个工具生成执行函数：组合 signal，调用执行器，按三种结局更新
   记录、返回或抛错；错误文字按 `maxErrorChars` 截断；
4. `nestedCalls()` 返回记录的深副本、`count` 与 `complete`。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 16.2" packages/pi-course/dist/test/16-*.test.js`。

**预期：** `3/3`。三项分别证明：嵌套调用的 id、作用域与工具表只覆盖可调用集合，不存在的
成员抛出带近似名的 TypeError；参数校验失败与工具抛错都只影响自己；记录有界，超额调用照样
执行，结果从不记录。
:::

## Lab 16.3：deadline 与取消由宿主持有

脚本自己无法计时，也无法响应取消：VM 里没有计时器，`for (;;) {}` 更不会让出控制权。这两件
事都由宿主负责。

### 两个入口

`armDeadline()` 在构造时设一个计时器，`Infinity` 表示不设：

```ts
if (!Number.isFinite(timeoutMs)) return undefined;
return setTimeout(() => {
  this.finish({
    kind: "timeout",
    message: `Execution timed out after ${timeoutMs} ms`,
  });
}, timeoutMs);
```

starter 的构造函数为了让前两个 Lab 不依赖它，只在调用方给了 `timeoutMs` 时才调用
`armDeadline()`。实现之后把那一行改回：

```ts
this.timer = this.armDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
```

缺省 deadline 是 30 秒，包含工具耗时。

`watchSignal(signal)` 处理调用方的 `AbortSignal`：已经触发就立刻调用 `onAbort`，否则监听一次
`abort`。starter 里它直接抛错，所以在 Lab 16.3 完成前，带 signal 的执行会在构造时同步抛出
`Lab 16.3 abort signal 尚未实现`。`onAbort` 已经给出：用 signal 的 `reason` 作为
`kind: "aborted"` 的 message。

### 收口只有一处

超时、取消、脚本结束、worker 崩溃，最终都调用同一个 `finish()`，它在 starter 里已经写好：

```text
finished = true（之后的 finish 都是空操作）
清除计时器，移除 abort 监听
每个 pending 调用的 controller.abort()，清空 pending
Atomics.store(interrupt, 0, 1)      VM 的 interruptHandler 在下一次检查时停下
worker.terminate() → 完成后才 resolve 结果
```

中断标志和 `terminate()` 一起用。正在 wasm 里自旋的 VM 会在 QuickJS 下一次调用
`interruptHandler` 时停下，`terminate()` 随后结束整条线程。宿主等 `terminate()` 完成才交出结果，
调用方拿到结果时 worker 已经不在了。

### 两项测试观察什么

`for (;;) {}` 配 `timeoutMs: 200`：结果 `kind` 是 `timeout`，message 是
`Execution timed out after 200 ms`，总耗时在 3 秒以内。另一个工具 `wait` 一直等自己的 signal：
deadline 到期时，`finish()` 先 abort 它的 controller，再清空 `pending`；`wait` 随后 reject，
`handleCall()` 的 `delete` 返回 `false`，记录保持 `{ name: "wait", status: "cancelled" }`。

调用方 abort 的测试同时用到 Lab 16.2 的桥：

```text
runCodemodeScript(…, { tools: bridge.tools, signal: controller.signal })
工具 wait 开始执行，拿到组合后的 signal（未触发）
controller.abort(new Error("user cancelled"))
→ Execution.onAbort → finish({ kind: "aborted", message: "user cancelled" })
→ wait 的 signal 触发 → executeToolCall 返回 isError → 桥记录 cancelled
result.calls          [{ name: "wait", status: "cancelled" }]
bridge.nestedCalls()  [cancelled]
```

一开始就已经 aborted 的 signal 让执行直接以 `aborted` 结束，`start()` 看到 `finished` 后不再
创建 worker。

:::lab title="实践 16.3 · 实现 deadline 与取消"
**目标：** 让宿主在 deadline 到期或调用方取消时终止 worker，并让未完成的调用收到 abort
信号、记为 `cancelled`。

**文件：** `packages/pi-course/src/codemode.ts`

**动作：**
1. 实现 `armDeadline()`；
2. 把构造函数改成总是 `this.armDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)`；
3. 实现 `watchSignal()`：已触发立刻 `onAbort()`，否则 `addEventListener("abort", this.onAbort,
   { once: true })`。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 16.3" packages/pi-course/dist/test/16-*.test.js`。

**预期：** `2/2`。两项分别证明：死循环在 deadline 后被中断并 terminate，等待中的工具记为
`cancelled`；调用方 abort 时 worker 结束，嵌套调用收到 abort 信号并在两层记录里都是
`cancelled`，预先 aborted 的 signal 直接得到 `aborted`。
:::

## Lab 16.4：codemode 工具接进 loop

最后把沙箱包成一个工具。`createCodemodeTool(registry, options)` 的名字、描述、schema 和
`exposure: "model-only"` 已经给出。描述在创建时列出 `registry.callable()` 中每个工具的
`tools.<name>(args)` 和描述首行；`codemode` 自己是 `model-only`，不在可调用集合里，所以描述
不会列出 `tools.codemode`，脚本也不能递归调用它。

`execute()` 把前三个 Lab 串起来：

```ts
async execute({ code }, context) {
  const bridge = createNestedToolBridge(registry, context.callId, {
    signal: context.signal,
    limits: options.limits,
    executeToolCall: options.executeToolCall,
  });
  const result = await runCodemodeScript(code, {
    tools: bridge.tools,
    timeoutMs: options.timeoutMs,
    memoryLimitBytes: options.memoryLimitBytes,
    signal: context.signal,
  });
  const nestedCalls = bridge.nestedCalls();
  // 成功：content 是返回值的 JSON（undefined 写成 "undefined"），
  //       details = { ok: true, output, nestedCalls }
  // 失败：content 是 "Script failed: <stack 或 message>"（script）
  //       或 "Script <kind>: <message>"（timeout / aborted / sandbox），
  //       details = { ok: false, error: { kind, message }, output, nestedCalls }，isError: true
}
```

`context.callId` 是模型发出的 call id，嵌套调用因此编号为 `c1/1`、`c1/2`。`context.signal`
就是 loop 的 signal：loop 被 abort 时，脚本以 `aborted` 结束。

### 直接调用这个工具

```text
c1  console.log("start"); const r = await tools.read({ value: "x" }); return { text: r.text };
    → isError false，content '{"text":"read:x"}'
      details { ok: true, output: ["start"],
                nestedCalls: { calls: [{ id: "c1/1", name: "read", status: "ok", arguments: { value: "x" } }],
                               count: 1, complete: true } }
c2  return await tools.read_file({ value: "x" });
    → isError true，content 以 "Script failed: TypeError: tools.read_file does not exist. Did you mean tools.read?" 开头
      details.error.kind = "script"，nestedCalls.calls = []
c3  以 "script" 作用域调用 codemode 本身
    → Tool codemode failed: 工具不在脚本的可调用集合里
```

### 回到开篇的那次运行

loop 第一次请求前，注册表用上了非 direct 的 exposure，第 15 章的补丁声明 `read, codemode`。
模型发出 `c1`，loop 以 `"model"` 作用域执行 `codemode`；脚本里的两个调用以 `"script"` 作用域
执行 `read` 和 `mcp_github_issues`。第二次请求前，声明集合没有变化，loop 不追加补丁。嵌套
调用只出现在 `c1` 结果的 `details.nestedCalls` 里，transcript 仍是五条消息。

超时和取消也都落在这条路径上。`timeoutMs: 150` 的 `codemode` 遇到 `for (;;) {}`，工具结果
`isError`，`details.error.kind` 是 `timeout`；loop 照常发出下一次请求，模型回答
`recovered`，运行以 `stop` 结束。另一次运行里，脚本正在等工具 `wait` 时 loop 被 abort：
`codemode` 的结果 `details.error.kind` 是 `aborted`，嵌套记录是 `cancelled`，loop 以
`aborted` 收口。

:::lab title="实践 16.4 · 实现 codemode 工具并接入 loop"
**目标：** 让模型通过一个 `model-only` 工具运行脚本，成功时拿到返回值，失败时拿到带错误
种类的错误结果，嵌套调用只留在父结果的记录里。

**文件：** `packages/pi-course/src/codemode.ts`

**动作：**
1. 在 `execute()` 里以 `context.callId` 为父 id 建桥，传入 `context.signal`、`limits` 与
   `executeToolCall`；
2. 用桥的工具表、`timeoutMs`、`memoryLimitBytes` 和 `context.signal` 运行脚本；
3. 按成功与失败两种形状组装 `content`、`details` 与 `isError`。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 16.4" packages/pi-course/dist/test/16-*.test.js`。

**预期：** `3/3`。三项分别证明：`codemode` 是 `model-only`，成功内容是返回值 JSON 且
`details` 带 `nestedCalls`，失败时 `isError` 并给出错误种类与近似名建议；经 loop 时脚本调用
`deferred` 工具不需要先声明，嵌套调用不进入 transcript；超时以 `details` 报告后 loop 继续，
loop 的 abort 让脚本以 `aborted` 结束。
:::

## 十二项测试固定了哪些边界

| Lab | 数量 | 可观察事实 |
|---|---:|---|
| 16.1 | 4 | 消息桥往返、失败变成结果、每次新 VM 与内存上限、stalled 立即失败 |
| 16.2 | 3 | `<parent>/<n>` 与 script 作用域、失败互不影响、有界记录 |
| 16.3 | 2 | deadline 中断与 terminate、调用方 abort 与 cancelled |
| 16.4 | 3 | `model-only` 工具形状、经 loop 不声明 deferred、超时与 abort 收口 |

全章运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/16-*.test.js
```

再运行全部课程测试：

```bash
node --test packages/pi-course/dist/test/*.test.js
```

## 课程 codemode 与真实 Pi 的关系

:::pi title="与上游 Pi v1.0.0 对照"
**沙箱结构。** 上游 `packages/codemode` 同样依赖 `quickjs-wasi` 3.6.2
（`packages/codemode/package.json:58`），也为每次执行新建 worker 与 VM
（`packages/codemode/src/runtime/host.ts:81-85`）。worker 用同样的选项创建 VM：`memoryLimit`、
`maxStackSize` 与轮询中断标志的 `interruptHandler`（`packages/codemode/src/runtime/worker.ts:52-62`）。
宿主收口时先写中断标志，再 `terminate()`，完成后才交出结果（`host.ts:268-272`）。这个
`SharedArrayBuffer` 标志的来由写在 `packages/codemode/src/runtime/protocol.ts:20-24`：Bun 的
`worker.terminate()` 停不下在 wasm 里自旋的线程。课程在 Node 上运行，保留了同一个标志和
`terminate()`。

**协议与 prelude。** 上游的 `call` 消息多一个 `target: "tool" | "global"`，`output` 携带文本或
图片，成功的 `done` 还带 `store()` 的写入（`protocol.ts:30-41`）。prelude 的签名是
`(bridge, toolsJson, globalsJson, storeJson)`（`packages/codemode/src/runtime/prelude-source.ts:34`），
另外提供 `text()`、`image()`、`exit()`、`store()` / `load()`、`searchTools()` 与 `models.*`。
不存在的成员同样由 Proxy 立即报错并给出近似名（`:116-141`），`stalled()` 在 `:370`。课程简化：
只保留 `tools`、`ALL_TOOLS` 与 `console.*`，不做输出截断（上游见
`packages/coding-agent/src/extensions/codemode/execute.ts:423`）。

**deadline。** 上游 `CodemodeSandbox` 的缺省 deadline 是 300 秒（`host.ts:22`），codemode 工具
不指定时传入 `Infinity`（`execute.ts:385`），脚本可以在第一行的 `// @options:` 里设置。课程
缺省 30 秒，便于测试与练习。

**嵌套调用。** 上游脚本调用工具走 `ctx.executeTool()`（`execute.ts:363`），由
`NestedToolCallRunner` 编号为 `<callerId>/<n>`（`packages/coding-agent/src/core/nested-tool-calls.ts:188`），
嵌套更深时继续加一段。记录上限 `NESTED_CALL_LIMITS`（`:26-31`）与课程数值相同。
`AgentSession._executeNestedToolCall()`（`packages/coding-agent/src/core/agent-session.ts:698-736`）
让每次嵌套调用对可调用集合运行完整工具管线，包括 `_beforeToolCall` / `_afterToolCall` 钩子
（`:724`），并发出带 `parentToolCallId` 的执行事件。课程简化：缺省直接调用核心
`executeToolCall(…, "script")`，不经过第 12 章的 hook；需要时通过 `executeToolCall` 选项注入。

**记录放在哪里。** 上游把记录写在 `ToolResultMessage.nestedCalls` 字段
（`packages/ai/src/types.ts:603-604`，注释写明只用于会话记录、不发给模型），由
`agent-session.ts:1075-1080` 在结果消息开始时附上。课程放在 `details.nestedCalls`，不改消息
类型。

**脚本拿到的值。** 上游对声明了 `outputSchema` 的工具返回 `structuredContent`，其他工具返回
文本字符串（`packages/coding-agent/src/extensions/codemode/tool.ts:11-15`）。课程统一返回
`{ text, details? }`。

**描述里列哪些工具。** 上游 `codemode` 同样是 `model-only`（`tool.ts:377`）。它的描述按 exposure
列出工具，由 `prepareCodemodeLoadout()`（`tool.ts:319-329`）维护，`tool_search` 激活工具时
描述不变，也就不会触发重新声明。课程在创建时把可调用集合全部列进描述，之后不再更新。
:::

## 本章验收

本章验收不只是一行 `pass`。用开篇那次运行复述：

1. 为什么脚本必须在 worker 里运行，而且每次都用新的 worker 与 VM；
2. 一次 `tools.read(...)` 经过哪几条消息往返，worker 为什么只搬运字符串；
3. `handleCall()` 为什么先把记录写成 `cancelled`，`pending.delete(id)` 返回 `false` 意味着
   什么；
4. `settle()` 之后为什么还要 `executePendingJobs()` 与 `stalled()`；
5. `c1/1`、`c1/2` 这两个 id 从哪里来，嵌套调用为什么不出现在 transcript 里；
6. 脚本为什么能调用 `deferred` 的 `mcp_github_issues`，却不能调用 `codemode` 自己；
7. deadline 到期时，中断标志、`terminate()`、pending controller 各自起什么作用；
8. loop 被 abort 时，`codemode` 的结果、嵌套记录和 loop 的停止原因分别是什么。

验收记录可写成：

```text
Lab 16.1: 4/4
Lab 16.2: 3/3
Lab 16.3: 2/2
Lab 16.4: 3/3
fault injection: script scope removed → Lab 16.2 red
fault restored: Lab 16.2 green
chapter total: 12/12
```

:::checkpoint title="Checkpoint 16 · 脚本在沙箱里调用工具，只有返回值回到模型"
**完成状态：** `runCodemodeScript()` 为每次执行新建 worker 与 QuickJS VM，设内存上限与中断
回调；`tools.<name>(args)` 经 `call` / `result` 消息往返，参数与结果都是 JSON 字符串；脚本
抛错、语法错误、内存耗尽与 stalled 都返回 `{ ok: false }`。

**嵌套调用：** `createNestedToolBridge()` 只暴露可调用集合，每次调用是一个 `<parent>/<n>` 的
ToolCall，以 `script` 作用域走 `executeToolCall`；失败只影响自己。记录有条数、参数字节与错误
长度上限，结果从不记录。

**收口：** 宿主持有 deadline 与 signal；到期或取消时 abort 未完成的调用、置中断标志、
`terminate()` worker，未完成的调用记为 `cancelled`。

**接入：** `codemode` 是 `model-only` 工具。成功时内容是返回值 JSON，失败时 `isError` 并在
`details.error.kind` 给出 `script` / `timeout` / `aborted` / `sandbox`。嵌套调用只出现在
`details.nestedCalls`，声明集合不因脚本调用而改变。

**公开证据：** `4/4 → 3/3 → 2/2 → 3/3`，共 `12/12`。

**恢复：** 回到 parent `6a8eff4e26ed662861fe0199ddca582dcc4ea4ca` 后，第 15 章的两个集合与
`tool_search` 仍然可用，只是没有以 `script` 作用域调用工具的入口。
:::

:::transfer title="迁移练习 · 让脚本看到工具的调用次数"
完成 `12/12` 后，在独立练习文件里写一个 `createCountingExecutor(registry)`：它返回一个
`ToolExecutor`，内部仍调用 `executeToolCall(call, registry, context, "script")`，同时按工具名
统计调用次数。

把它作为 `createCodemodeTool(registry, { executeToolCall })` 的选项传入，用 ScriptedModel 跑一次
loop：脚本调用 `read` 两次、`mcp_github_issues` 一次。检查统计结果、`details.nestedCalls` 的三个
id，以及 transcript 仍是五条消息。`codemode.ts` 不需要任何修改。
:::

## 小结

开篇那次运行里，模型只发出一个 `codemode` call。脚本在新建的 worker 和 VM 中运行，两个
`tools.*` 调用变成 `call` 消息回到宿主，以 `c1/1`、`c1/2` 的身份走第 06 章的校验与执行，
再以 `result` 消息回到 VM。只有拼好的字符串作为工具结果写进 transcript，嵌套调用留在
`details.nestedCalls` 的有界记录里。

`mcp_github_issues` 没有被声明，也没有经过 `tool_search`。第 15 章把“模型能看见”和“脚本能
调用”分成两个集合，本章给第二个集合找到了调用者。宿主持有 deadline 与取消，脚本无论怎样
失败，模型拿到的都是一条与 call 配对的错误结果。

第 17 章接入 MCP 服务器。服务器的工具默认注册为 `deferred`：模型可以用 `tool_search` 把它们
带进声明集合，也可以直接在 `codemode` 脚本里调用。
