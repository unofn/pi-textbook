---
id: "17"
slug: mcp
part: advanced
partTitle: 第五部 · Pi 1.0 进阶
chapter: "17"
title: MCP：把外部服务器的工具接进来
summary: 用一个最小 MCP 客户端完成 JSON-RPC 握手、翻页、调用、超时与取消，再把外部服务器的工具按 deferred 暴露注册进同一张注册表，并把服务器清单作为只在变化时打补丁的 system 段落。
minutes: 150
difficulty: 进阶
artifact: packages/pi-course/src/mcp.ts
prerequisites: 10,13,15,16
terms: MCP, JSON-RPC 2.0, initialize, protocol version, tools/list, nextCursor, notifications/cancelled, stdio transport, mcp_servers
upstream: packages/mcp/src/client.ts, packages/mcp/src/transports/stdio.ts, packages/coding-agent/src/extensions/mcp/index.ts
---

## 一个工具从另一个进程来

第 15 章结束时，注册表已经能区分“模型看得见”和“谁能调用”：`deferred` 工具不进入
`definitions()`，模型要先调用 `tool_search` 把它激活；第 16 章的脚本则用
`executeToolCall(call, registry, {}, "script")` 直接调用可调用集合里的工具。这些工具有一个
共同点：它们都是进程内的对象，`execute()` 就在同一个 Node 进程里运行。

现在有一个文档服务器在另一个进程里，它提供 `search_docs` 和 `fail` 两个工具。本章结束时，
同一张注册表里会多出两项，调用路径与第 15、16 章完全相同：

```text
createMcpRuntime(registry, { servers: [{ name: "docs", createTransport }] })
  后台：initialize → notifications/initialized → tools/list
  注册：mcp__docs__search_docs   exposure = deferred
        mcp__docs__fail          exposure = deferred

registry.definitions()                        → [tool_search]
模型直接调用 mcp__docs__search_docs            → isError：尚未声明；服务器收不到 tools/call
脚本调用（scope "script"）                     → tools/call → found {"q":"mcp"}
模型调用 tool_search("documentation search")  → details.loaded = [mcp__docs__search_docs]
模型再次调用 mcp__docs__search_docs            → tools/call → 成功
```

这段轨迹来自 Lab 17.5 的第二项测试。服务器那一侧只说三件事：我支持哪个协议版本、我有哪些
工具、调用某个工具的结果。把这三件事变成注册表里的 `Tool`，中间要经过四层：

```text
JSON-RPC 消息        unknown → request / notification / response
McpClient            握手、在途请求表、tools/list 翻页、tools/call、超时与取消
McpTransport         内存成对传输（测试用）或 stdio 子进程（换行分帧）
MCP runtime          命名、注册、服务器清单段落、首个 prompt 的有界等待
```

前三层组成一个与 Agent 无关的 MCP 客户端，写在 `mcp.ts`；第四层写在 `mcp-runtime.ts`，
它只依赖第 15 章的注册表和第 13 章 Runtime 新开的一个段落接口。工具执行仍走第 06 章的
`executeToolCall`，服务器返回的 `isError` 结果仍是与 call 配对的错误结果。

## 建立练习起点

在教学历史仓库中生成隔离练习：

```bash
cd <你的工作区>/pi-course
npm run checkpoint -w @pi/course -- 17
npm run practice -w @pi/course -- 17 <新目录>
cd <新目录>
npm install
```

本章修改三个文件：

```text
packages/pi-course/src/mcp.ts           JSON-RPC、传输、McpClient（Lab 17.1–17.4）
packages/pi-course/src/mcp-runtime.ts   命名与 createMcpRuntime（Lab 17.5）
packages/pi-course/src/composition.ts   合并段落提供者（Lab 17.5）
```

`mcp.ts` 的脚手架已经给出类型、错误类、传输的监听器簿记、内存传输、stdio 的 spawn 与
send，以及 client 的请求登记 `requestInternal()` 和响应分发 `handleMessage()`。留空的是
判定消息形状、握手、翻页、取消、分帧与关闭这几处决定协议语义的代码。

:::rebuild title="Checkpoint 17 · 从红测试接入一个 MCP 服务器"
**模式：** 重建。从第 16 章 target 开始，增加一个最小 MCP 客户端和它与 Runtime 的接线。

**起终点：** `parent` `ff14a103b53fe07b304e73d82364d69bdcb60cf8` 是起点；`target` `f83287a6d3c97dc187ec2d7a1fde1172018ff3f5` 是终点。

**教学文件：** `packages/pi-course/src/mcp.ts`、
`packages/pi-course/src/mcp-runtime.ts`、`packages/pi-course/src/composition.ts`

**学习脚手架：** `starters/17-mcp.ts`、`starters/17-mcp-runtime.ts` 与
`starters/17-composition.ts` 分别覆盖三个教学文件。工具适配 `createMcpTool()` 与段落渲染
`renderMcpServersSection()` 已经给出；`composition.ts` 只多了 `SystemSectionProvider` 类型和
`RuntimeDeps.sectionProviders` 字段，没有提供者时行为与第 13 章相同。

**动手前只需知道：** JSON-RPC 2.0 只有三种消息：带 `id` 和 `method` 的 request、只带
`method` 的 notification、带 `id` 和 `result` 或 `error` 的 response。握手是一次
`initialize` request 加一条 `notifications/initialized`。每个发出的 request 都在 client 的
`pending` 表里登记，等响应、超时、abort 或连接关闭中的一个把它取走。

**第一步：** 实现 `isJsonRpcRequest`、`isJsonRpcNotification`、`isJsonRpcResponse` 三个类型
谓词，再实现 `McpClient.connect()` 的握手顺序。

**第一次红灯：** fresh starter 可以 build；只运行 Lab 17.1 时三项都失败，第一项显示
`Lab 17.1 isJsonRpcRequest 尚未实现`，另外两项显示 `Lab 17.1 McpClient.connect 尚未实现`。

**聚焦测试：** `packages/pi-course/test/17-mcp.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 17`

**练习目录：** `npm run practice -w @pi/course -- 17`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/17-*.test.js`。

**施工顺序：** JSON-RPC 收窄与握手 `3/3` → 翻页与调用 `3/3` → 超时与取消 `2/2` →
stdio 分帧与关闭 `2/2` → 命名与 Runtime 接入 `3/3`。

**通过证据：** 五个 Lab 可以按 name-pattern 单独运行，最后本章 `13/13`，并能说清
`pending` 表里一个请求有哪几种出口。

第一次尝试先不看 target diff。只比较当前 Lab 的消息顺序和第一个可观察偏差。
:::

验证起点：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 17.1" \
  packages/pi-course/dist/test/17-*.test.js
```

正确结果是 `0/3`，错误信息与上面的首红一致。

## Lab 17.1：从 unknown 收窄出三种消息，再完成握手

传输层交上来的值来自另一个进程，类型只能是 `unknown`。三种 JSON-RPC 消息靠字段区分：

| 消息 | `jsonrpc` | `id` | `method` | `result` / `error` |
|---|---|---|---|---|
| request | `"2.0"` | string 或有限 number | string | 无 |
| notification | `"2.0"` | 没有这个字段 | string | 无 |
| response | `"2.0"` | string 或有限 number | 无要求 | 恰好一个；`error` 要有 number `code` 和 string `message` |

`isJsonRpcId()` 已经给出，`NaN` 和 `Infinity` 都会被它拒绝。三个谓词要互斥：测试里的
`{ jsonrpc: "2.0", id: 1, method: "ping" }` 只能是 request，没有 `id` 的
`notifications/initialized` 只能是 notification。response 的判定先看 `result`：有 `result`
就要求没有 `error`；没有 `result` 时才去检查 `error` 对象：

```ts
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isObject(value) || value.jsonrpc !== "2.0" || !isJsonRpcId(value.id)) {
    return false;
  }
  if ("result" in value) return !("error" in value);
  if (!("error" in value) || !isObject(value.error)) return false;
  return (
    typeof value.error.code === "number" &&
    typeof value.error.message === "string"
  );
}
```

已经给出的 `parseJsonRpcMessage()` 依次调用三个谓词，都不匹配就抛 `McpError`，`code` 是
`-32600`（invalidRequest）。测试用七个反例检查它：`null`、字符串、`jsonrpc: "1.0"`、
`id` 为 `NaN`、`result` 与 `error` 同时出现、`code` 是字符串、只有 `id` 没有其他字段。

### 握手只有四步

三个谓词就位后，`handleMessage()` 就能把服务器的回复交给登记它的请求。`connect()` 负责
把连接从 `idle` 推进到 `connected`：

```text
idle
  → connecting      注册 onMessage / onError / onClose，transport.start()
  → request         initialize { protocolVersion: "2025-11-25", capabilities: {}, clientInfo }
  ← response        { protocolVersion, capabilities, serverInfo, instructions? }
     校验结果形状；protocolVersion 必须在 SUPPORTED_PROTOCOL_VERSIONS 里
  → notification    notifications/initialized
  → connected
```

`initialize` 发出时连接还处在 `connecting`。普通的 `request()` 会被 `requireTransport(false)`
拒绝，所以握手要走内部的 `requestInternal(…, allowConnecting = true)`，
`notifications/initialized` 同样走 `notifyInternal(…, true)`。

版本协商只有一个来回。客户端提出自己最想用的 `LATEST_PROTOCOL_VERSION`，也就是
`"2025-11-25"`；服务器回一个它选定的版本。这个版本可以比客户端提出的旧，只要还在
`SUPPORTED_PROTOCOL_VERSIONS` 这四个版本里：

```text
服务器选 "2025-11-25"   → connected，protocolVersion = "2025-11-25"
服务器选 "2024-11-05"   → connected，protocolVersion = "2024-11-05"
服务器选 "1999-01-01"   → 抛 unsupported protocol version 1999-01-01
                          连接关闭，服务器只收到 initialize，没有 initialized
```

任何一步失败，`connect()` 都先 `close()` 再把原错误抛出。`close()` 已经给出：它解除传输
监听、调用 `markClosed()` 把状态翻成 `closed` 并拒绝所有在途请求，再关闭传输。之后
`client.request("ping")` 会立即以 `McpConnectionClosedError` 失败。

握手成功后，client 记下 `serverInfo`、`protocolVersion` 和可选的 `instructions`。第二次
调用 `connect()` 会因为状态已经是 `connected` 而被拒绝；连续两次 `close()` 只通知 close
监听器一次。

:::lab title="实践 17.1 · 收窄消息并完成握手"
**目标：** 三个类型谓词互斥地判定 request、notification 与 response；`connect()` 按
`initialize → 校验版本 → notifications/initialized` 的顺序进入 `connected`。

**文件：** `packages/pi-course/src/mcp.ts`

**动作：**
1. 按上表实现 `isJsonRpcRequest`、`isJsonRpcNotification`、`isJsonRpcResponse`。
2. 在 `connect()` 中拒绝非 `idle` 状态，置为 `connecting`，保存传输并把三个监听器的解除
   函数放进 `this.disposers`。
3. `await transport.start()`，用 `requestInternal("initialize", …, {}, true)` 发起握手，
   结果交给 `validateInitializeResult()`。
4. 版本不在 `SUPPORTED_PROTOCOL_VERSIONS` 中就抛错；否则保存结果，发
   `notifications/initialized`，置为 `connected` 并返回结果。
5. 用一个 `try/catch` 包住第 3、4 步，失败时先 `await this.close()`（忽略它自己的错误）
   再抛出原错误。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 17.1" packages/pi-course/dist/test/17-*.test.js`。

**预期：** `3/3`。三项分别证明谓词互斥与七个反例被拒绝；握手顺序、`initialize` 参数、
`serverInfo` 与 close 监听器只触发一次；不支持的版本让 connect 失败、关闭连接且不发
`initialized`，`2024-11-05` 仍能连上。
:::

## Lab 17.2：翻页直到 cursor 结束

连接建立以后，第一件事是问服务器有哪些工具。`tools/list` 的结果可以分页：每页带一个
`nextCursor`，客户端把它原样放进下一次请求的 `params.cursor`。测试里的服务器有三页：

```text
request 1  params: undefined          ← tools: [alpha]          nextCursor: "1"
request 2  params: { cursor: "1" }    ← tools: [beta, gamma]    nextCursor: "2"
request 3  params: { cursor: "2" }    ← tools: [delta]          nextCursor: null
listTools() → [alpha, beta, gamma, delta]
```

第一页不带 `params`。每一页先交给已经给出的 `validateToolsPage()`：它检查每个工具都有
string `name` 和 object `inputSchema`，并把 `null` 与空串 cursor 统一成 `undefined`。所以
`listTools()` 自己只需要一条结束条件：`nextCursor === undefined`。

:::predict title="服务器返回 nextCursor: null 时该怎么办"
规范里 `nextCursor` 是可选的 string。有的服务器在最后一页写 `null`，有的写 `""`。客户端
应该继续请求下一页，还是认为列表已经结束？如果服务器连续两页返回同一个 cursor 呢？

---answer
`null` 和 `""` 都按“没有下一页”处理，测试里只有一页、cursor 为 `""` 的服务器只收到一次
`tools/list`。重复的 cursor 说明服务器会把客户端带回已经读过的位置，继续翻页就是死循环；
`listTools()` 记住见过的 cursor，第二次见到 `"1"` 时抛出
`MCP tools/list returned duplicate cursor: 1`，这时服务器恰好收到两次请求。即使 cursor 每次
都不同，翻到 `MAX_LIST_PAGES`（1000）页也会报错。
:::

工具调用是单次请求，参数形状固定为 `{ name, arguments? }`。调用方没给参数时，`params`
里就没有 `arguments` 字段：

```text
callTool("echo", { q: "hi" })   params: { name: "echo", arguments: { q: "hi" } }
callTool("structured")          params: { name: "structured" }
```

结果交给 `validateCallToolResult()`。规范要求结果有 `content` 数组，但只返回
`structuredContent` 的服务器会省略它；校验函数在这种情况下补一个空数组，所以
`callTool("structured")` 得到 `{ content: [], structuredContent: { ok: true } }`。服务器用
JSON-RPC error 回答时，`handleMessage()` 已经把它变成 `McpError`，`code` 保留服务器给的
`-32602`。这类错误属于协议层：它说明请求本身被拒绝。服务器正常回答但结果带
`isError: true` 时，那是工具执行失败，要到 Lab 17.5 的工具适配里处理。

:::lab title="实践 17.2 · 跟随 cursor 列出全部工具并调用一个工具"
**目标：** `listTools()` 跟随 `nextCursor` 读完所有页并拒绝重复 cursor；`callTool()` 发出
正确的参数并校验结果。

**文件：** `packages/pi-course/src/mcp.ts`

**动作：**
1. `listTools()` 用一个 `Set` 记录见过的 cursor，在 `MAX_LIST_PAGES` 次以内循环：第一页不带
   `params`，之后带 `{ cursor }`；每页经 `validateToolsPage()` 后追加工具。
2. `nextCursor` 为 `undefined` 时返回；已经见过就抛 `duplicate cursor`；循环用完就抛
   `exceeded … pages`。
3. `callTool()` 用 `request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }, options)`，
   结果交给 `validateCallToolResult()`。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 17.2" packages/pi-course/dist/test/17-*.test.js`。

**预期：** `3/3`。三项分别证明三页翻页的请求参数、`""` cursor 结束、缺 `inputSchema` 的
工具被拒绝；重复 cursor 在第二次请求后报错；`arguments` 字段按需出现、缺 `content` 补空
数组、服务器 error 变成带 `code` 的 `McpError`。
:::

## Lab 17.3：一个在途请求的四种出口

`requestInternal()` 为每个请求分配递增的 `id`，在 `pending` 表里登记一项，再交给传输发送：

```ts
interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  signal: AbortSignal | undefined;
  onAbort(): void;
  /** 规范禁止取消 initialize。 */
  cancellable: boolean;
}
```

这一项登记以后只有四种离开方式，每种都先 `removePending()`：删掉表项、清掉计时器、
解除 abort 监听。

```text
          ┌── 响应到达         handleMessage → resolve(result) 或 reject(McpError)
登记 ─────┼── 计时器到期       cancelPending(id, McpTimeoutError, cancellable, "Request timed out")
          ├── signal abort     cancelPending(id, McpAbortError, cancellable, String(signal.reason))
          └── 连接关闭         markClosed → reject(McpConnectionClosedError)，全部一起
```

响应和连接关闭两条路径已经给出。超时和 abort 都汇到 `cancelPending()`，它是本 Lab 唯一
要写的函数：

```text
cancelPending(id, error, notifyServer, reason?)
  表里已经没有 id      → 什么也不做（响应可能刚好先到）
  removePending(id)
  reject(error)
  notifyServer 且传输仍在 → 发送 notifications/cancelled { requestId: id, reason? }
```

通知发出后不等待结果：发送失败只交给 `onError` 监听器，不影响已经 reject 的调用方。
服务器收到 `notifications/cancelled` 后可以停止手上的工作；即使它稍后仍然发回响应，
`handleMessage()` 在 `pending` 表里找不到这个 `id`，只会报告一条 unknown request 错误。

一个请求超时只拒绝这一个请求。测试让服务器对 `tools/call` 保持沉默，30ms 后调用方收到
`McpTimeoutError`（`timeoutMs` 为 30），服务器收到一条 cancelled，`reason` 是
`"Request timed out"`，client 仍是 `connected`。

`initialize` 的规则不同。`cancellable` 在登记时就按 `method !== "initialize"` 算好，规范
不允许取消握手。`initialize` 超时会让 `connect()` 进入 catch 分支，client 关闭连接；服务器
那边一条 cancelled 也收不到。

abort 有两个入口。请求发出之前 signal 已经 aborted，`requestInternal()` 直接抛
`McpAbortError`，不登记也不发送；发出之后 abort，就走 `onAbort` 进入 `cancelPending()`。
`McpAbortError` 的 `name` 是 `"AbortError"`，与平台的取消错误同名，上层按名字识别取消时
不需要认识 MCP 的错误类。测试里 `controller.abort("user cancelled")` 让服务器收到
`reason: "user cancelled"`。

脚手架里还有一处临时限制要在本 Lab 拿掉。为了让前两个 Lab 不依赖 `cancelPending()`，
starter 只在调用方显式给出 `timeoutMs` 或 `requestTimeoutMs` 时才启动计时器：

```ts
// 脚手架只在显式给出超时时才计时；Lab 17.3 完成后改成总是按 timeoutMs 计时。
const explicitTimeout =
  options.timeoutMs !== undefined || this.options.requestTimeoutMs !== undefined;
if (explicitTimeout && Number.isFinite(timeoutMs) && timeoutMs > 0) {
```

target 去掉了 `explicitTimeout`，没有配置时使用 30 秒的 `DEFAULT_REQUEST_TIMEOUT_MS`。两项
测试都显式给了超时，删不删这一行它们都会通过；这一步要靠你自己核对。

:::lab title="实践 17.3 · 让超时与取消离开 pending 表"
**目标：** 超时与 abort 都从 `pending` 表移除请求、拒绝调用方，并在允许时通知服务器；
`initialize` 从不发送 cancelled。

**文件：** `packages/pi-course/src/mcp.ts`

**动作：**
1. 实现 `cancelPending()`：找不到表项就返回；否则 `removePending()`、`reject(error)`；
   `notifyServer` 为真且 `this.transport` 仍在时，发送 `notifications/cancelled`，
   `params` 为 `{ requestId: id, ...(reason ? { reason } : {}) }`，发送失败交给 `emitError()`。
2. 删除 `requestInternal()` 中的 `explicitTimeout` 条件，让每个请求都按 `timeoutMs` 计时。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 17.3" packages/pi-course/dist/test/17-*.test.js`。

**预期：** `2/2`。第一项证明超时以 `McpTimeoutError` 拒绝、发送一条 cancelled、连接保持
`connected`，以及 `initialize` 超时关闭连接且不发 cancelled；第二项证明 abort 前后两种
入口、cancelled 带调用方的 reason，传输关闭让两个在途请求都以
`McpConnectionClosedError` 结束且 close 监听器只触发一次。
:::

## Lab 17.4：stdio 用换行分帧

前三个 Lab 都用内存传输。`createInMemoryTransportPair()` 造出一对互为对端的传输，`send()`
先 `structuredClone()` 消息，再用 `queueMicrotask()` 交给对端。深复制让两边不共享对象，
微任务让发送方在 `await send()` 返回之前看不到回复，时序与真实的跨进程传输相近。

本地 MCP 服务器最常见的形态是子进程：客户端写它的 stdin，读它的 stdout，每条消息是一行
JSON。写的方向已经给出，`send()` 写入 `JSON.stringify(message) + "\n"`。读的方向要处理
管道的切分方式：stdout 的一次 `data` 事件可能只有半行，也可能一次带来好几行。

`splitJsonRpcLines(buffered, chunk)` 把上次剩下的半行和这次的数据拼起来，按 `\n` 切开：

```text
第一次  buffered = ""
        chunk    = '{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","id":1,"res'
        messages = [{ jsonrpc: "2.0", method: "a" }]
        rest     = '{"jsonrpc":"2.0","id":1,"res'

第二次  buffered = 上一次的 rest
        chunk    = 'ult":{}}\nnot json\n\n{"jsonrpc":"2.0","method":"b"}\n'
        messages = [{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", method: "b" }]
        errors   = 1 条（not json）
        rest     = ""
```

最后一个 `\n` 之后的内容一律留进 `rest`，不尝试解析。这和第 10 章 JSONL 的规则一样：只有
以换行结束的行才算提交。空行跳过；`JSON.parse` 失败或 `parseJsonRpcMessage()` 拒绝的行
进入 `errors`。已经给出的 `handleStdout()` 把 errors 交给 `onError`，把 messages 交给
`onMessage`，连接本身不断开。

测试的子进程是一个写到临时目录的 node 脚本，完全离线。它对 `burst` 工具一次写出四行：
两条 notification、一行垃圾和响应。client 收到两条 `notifications/message`（`n` 为 1 和 2），
记一条 error，`callTool("burst")` 拿到 `burst done`，连接仍是 `connected`。

关闭子进程分三档，每档都给对方一段时间自己退出：

```text
close()
  closed = true
  子进程已经退出                → emitClose()，结束
  stdin.end()                   服务器读到 EOF，可以自行退出
  raced(exited, graceMs = 200)  已退出 → 结束
  kill("SIGTERM")
  raced(exited, closeTimeoutMs = 1000)  已退出 → 结束
  kill("SIGKILL")
  await exited
```

`exited` 是 `start()` 里登记的 Promise，在子进程的 `close` 事件里完成；同一个事件也调用
`emitClose()`，于是 client 的 `markClosed()` 会拒绝所有在途请求。测试在 `client.close()`
之后等 50ms，再用 `process.kill(pid, 0)` 确认进程已经不存在。

:::lab title="实践 17.4 · 换行分帧与分档关闭"
**目标：** stdout 的任意切分都能还原成完整消息，坏行不断开连接；`close()` 让子进程在有限
时间内退出。

**文件：** `packages/pi-course/src/mcp.ts`

**动作：**
1. 实现 `splitJsonRpcLines()`：拼接 → `split("\n")` → `pop()` 出 `rest` → 对其余每行
   `trim()`，空行跳过，`parseJsonRpcMessage(JSON.parse(line))` 成功进 `messages`，失败进
   `errors`。
2. 实现 `StdioTransport.close()`：已关闭就返回；置 `closed`；没有子进程或已退出时只
   `emitClose()`；否则 `stdin.end()`，再用已经给出的 `raced()` 依次等 `graceMs`、发
   `SIGTERM`、等 `closeTimeoutMs`、发 `SIGKILL`、`await exited`。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 17.4" packages/pi-course/dist/test/17-*.test.js`。

**预期：** `2/2`。第一项证明经子进程完成握手、列工具、调用，`close()` 后进程退出；第二项
证明半行留在 `rest`、多行一次交付、非 JSON 行只计一条 error，以及真实子进程的突发输出
被逐条交付且连接保持。
:::

## Lab 17.5：把服务器工具接进注册表与 system prompt

客户端已经能和服务器对话。剩下的工作是把服务器的工具变成注册表里的 `Tool`，并让模型
知道有哪些服务器。

### 名字要能同时给 provider 和脚本用

一个工具在注册表里的名字有三个约束：不能与其他工具冲突；provider 限制在 64 个
`[A-Za-z0-9_-]` 字符；第 16 章的脚本用 `tools.<name>` 调用它，名字还要是合法的
JavaScript 标识符。`createMcpToolName()` 先拼出 `mcp__<server>__<tool>`，把所有非
`[A-Za-z0-9_]` 字符换成 `_`：

```text
("docs", "search")                → mcp__docs__search
("my-server", "list.issues")      → mcp__my_server__list_issues
("server", "x" × 80)              → mcp__server__xxx…x_<8 位 hex>      共 64 字符
("a", "b-c")，mcp__a__b_c 已占用   → mcp__a__b_c_<8 位 hex>
```

清洗会让不同的原名撞到一起：`b-c` 和 `b.c` 都变成 `b_c`。名字超长或已被占用时，取
`sha256(server + "\0" + tool)` 的前 8 位，截断后接 `_` 和这个后缀。hash 输入用原名，所以
同一工具每次得到同一个名字，`b-c` 和 `b.c` 得到不同后缀。占用情况由调用方的 `isTaken`
回答，`createMcpRuntime()` 传入的是 `registry.get(candidate) !== undefined`。

### 服务器工具按 deferred 注册

已经给出的 `createMcpTool()` 把一个 `McpToolInfo` 包成课程的 `Tool`：

- `schema.jsonSchema` 是服务器的 `inputSchema`，缺 `type` 或 `properties` 时补齐；
  `parse()` 只确认参数是 object，详细校验留给服务器；
- `execute()` 调用 `client.callTool(tool.name, parameters, { signal, timeoutMs })`，Agent 的
  取消信号由此传到 Lab 17.3 的 abort 路径；
- 文本块原样进入 `content`，其他块写成 JSON 文本；结果带 `isError` 时返回错误结果，
  内容保留；
- `details` 是 `{ server, tool }`，`tool` 用服务器那边的原名。

`createMcpRuntime(registry, options)` 一创建就为每个服务器启动后台连接：

```text
connect(connection)
  new McpClient({ ...clientInfo, requestTimeoutMs })
  await client.connect(config.createTransport())
  await client.listTools()
  每个工具：name = createMcpToolName(server, tool.name, isTaken)
           registry.register(createMcpTool({ …, exposure: config.exposure ?? "deferred" }))
           connection.tools.push(name)
  state = "connected"
  client.onClose → 若未主动关闭，state = "failed"
失败：state = "failed"，error = 错误信息，关闭 client
```

缺省暴露级别是 `deferred`，回到第 15 章的规则：工具不进入 `definitions()`，模型用
`tool_search` 激活后才能调用；脚本以 `"script"` 作用域调用时，可调用集合里已经有它。开篇
那段轨迹就是这条规则的结果。服务器的工具可能很多，`deferred` 让它们不占用模型每次请求的
工具声明。

`status()` 返回每个服务器的快照：`name`、`state`（`connecting`、`connected`、`failed`、
`closed`）、可选的 `error` 和已注册的工具名。`close()` 把所有状态置为 `closed` 并关闭
各自的 client。

### 服务器清单是一个 system 段落

模型通过 `tool_search` 才能看到 deferred 工具，但它得先知道有哪些服务器值得搜索。服务器
清单因此要进入 system prompt。第 13 章已经有一套机制：Runtime 每次 prompt 前算出期望的
system 状态，交给 `systemPatch()` 与 transcript 重放出的状态比较，只为变化的段落追加补丁。
MCP 清单只需要成为期望状态里的一个段落：

```ts
export interface SystemSectionProvider {
  sections(): Promise<Record<string, string>> | Record<string, string>;
}
```

`RuntimeDeps.sectionProviders` 是一个提供者数组。`composition.ts` 在 Lab 17.5 唯一要写的是
`desiredSystemState()`：

```ts
private async desiredSystemState(): Promise<SystemState> {
  const sections = { ...this.desiredSystem.sections };
  for (const provider of this.deps.sectionProviders ?? []) {
    Object.assign(sections, await provider.sections());
  }
  return { content: this.desiredSystem.content, sections };
}
```

比较、补丁、持久化都沿用第 13 章的代码，段落有没有变化仍由 `systemPatch()` 判断。
`McpRuntime` 本身就是一个提供者，它的 `sections()` 返回 `{ mcp_servers: … }`，正文由已经
给出的 `renderMcpServersSection()` 生成：

```text
MCP servers:
- docs: connected, 1 tool (mcp__docs__search)
- slow: connecting, 0 tools
- never: connecting, 0 tools
```

每行只写服务器名、状态、可选的错误和已注册的工具名，不写工具描述。服务器更新一个工具的
描述时，这个段落保持不变，transcript 也就不会多出一条 system 补丁。

### 首个 prompt 只等有 direct 工具的服务器

`sections()` 在渲染之前先调用 `waitForDirectServers()`。连接在后台进行，第一次 prompt
到来时有的服务器可能还在握手。`deferred` 工具晚一点注册没有影响，模型本来就要先搜索；
`direct` 工具不同，它们应该出现在第一次请求的工具声明里。等待规则因此是：

```text
waitForDirectServers()
  direct = exposure 为 "direct" 的服务器
  没有 → 立即返回
  Promise.race([
    Promise.all(direct 的 connection.ready),
    startupTimeoutMs 后 resolve（缺省 5000，timer.unref()）
  ])
```

等待有上限：一个挂起的服务器最多让 prompt 晚 `startupTimeoutMs`，超时后照常运行，清单里
它仍显示为 `connecting`。

Lab 17.5 的第三项测试把这些规则放进同一个 Runtime。三个服务器：`docs` 是 deferred；`slow`
是 direct，握手被一个 gate 挡住；`never` 永远不回答 `initialize`。`startupTimeoutMs` 为
60ms，配置的基础 prompt 是 `BASE`：

| prompt | 等待 | 新增 system 消息 | 内容 |
|---|---|---|---|
| `first` | 约 60ms，测试要求 ≥50ms 且 <2000ms | 1 | `content = "BASE"`，`mcp_servers` 里 docs 已连上，slow、never 仍在连接 |
| `second` | slow 仍在连接，又等约 60ms | 0 | 清单没变，第二次请求里仍只有一条重放出的 system message |
| gate 打开，slow 连上 | | | |
| `third` | slow 已就绪 | 2 | 段落补丁：只含 `mcp_servers`，slow 显示 `connected, 1 tool (mcp__slow__run)`；声明补丁：`toolsAdded = [mcp__slow__run]` |

第三轮的两条 system 消息来自两个负责人。段落补丁由 Runtime 在 prompt 开始时放在 user
之前；`mcp__slow__run` 是 direct 工具，进入了 `definitions()`，第 15 章的 loop 在请求前发现
声明集合变化，于是在 user 之后追加一条声明补丁。测试分别计数：带 `sections` 的消息共 2 条，
带 `toolsAdded` 的消息 1 条，system 消息共 3 条。最后重放出的 prompt 仍以 `BASE` 开头，
`mcp_servers` 段落等于 `renderMcpServersSection(mcp.status())`。

`docs` 的工具在第一轮就已经注册，却始终不在 `definitions()` 里，也就不会产生声明补丁。

:::lab title="实践 17.5 · 命名、注册与服务器清单"
**目标：** 服务器工具以稳定、合法的名字按配置的暴露级别注册；服务器清单作为
`mcp_servers` 段落只在变化时进入 transcript；首个 prompt 只对 direct 服务器做有界等待。

**文件：** `packages/pi-course/src/mcp-runtime.ts`、`packages/pi-course/src/composition.ts`

**动作：**
1. 实现 `createMcpToolName()`：清洗；不超过 64 且未被占用就直接返回；否则截断到
   `64 - 8 - 1` 个字符，接 `_` 和 sha256 前 8 位。
2. 实现 `createMcpRuntime()`：为每个服务器创建 connection 并立即启动 `connect()`；实现
   `status()`、`waitForDirectServers()`、`sections()` 与 `close()`。
3. 在 `composition.ts` 的 `desiredSystemState()` 中，把每个提供者的段落并入第 13 章的
   基础段落。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 17.5" packages/pi-course/dist/test/17-*.test.js`。

**预期：** `3/3`。第一项证明命名、清洗、64 字符上限、稳定的 hash 与冲突后缀；第二项证明
deferred 注册、模型调用被拒而脚本调用成功、`tool_search` 激活后模型可调用、`isError`
结果保留内容、`close()` 后状态为 `closed`；第三项证明上表的三轮 prompt。
:::

## 十三项测试固定了哪些边界

| Lab | 数量 | 可观察事实 |
|---|---:|---|
| 17.1 | 3 | 三种消息互斥、七个反例、握手顺序、版本协商、失败即关闭 |
| 17.2 | 3 | cursor 翻页与结束条件、重复 cursor、`arguments` 字段、缺 `content`、协议错误 |
| 17.3 | 2 | 超时与 abort 的 cancelled 通知、`initialize` 不取消、连接关闭拒绝全部在途请求 |
| 17.4 | 2 | 子进程握手与退出、半行与多行分帧、坏行只报错 |
| 17.5 | 3 | 工具命名、deferred 注册与 `tool_search`、段落只在变化时打补丁、有界等待 |

全章运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/17-*.test.js
```

再运行当前练习目录全部课程测试，确认第 13 章的 Runtime 在没有段落提供者时行为不变：

```bash
node --test packages/pi-course/dist/test/*.test.js
```

这 `13/13` 的范围是：一个只发起请求的客户端，两种传输，以及只处理工具的接入。服务器
发起的请求（例如 `roots/list`）统一回 method not found；resources、prompts、progress、
OAuth 与 HTTP 传输都不在测试里。

## 课程 MCP 与真实 Pi 的关系

:::pi title="与上游 Pi v1.0.0 对照"
上游 Pi 1.0 把 MCP 拆成两部分：`packages/mcp` 是与 Agent 无关的客户端库，
`packages/coding-agent/src/extensions/mcp/` 是把它接进 coding agent 的内建扩展。课程的
`mcp.ts` 对应前者，`mcp-runtime.ts` 对应后者的一小部分。

**上游对照 · 相同的协议骨架。** 三个类型谓词与 `parseJsonRpcMessage()` 在
`packages/mcp/src/protocol/jsonrpc.ts:93-110`。`McpClient.connect()`
（`packages/mcp/src/client.ts:202`）的顺序与课程相同：`initialize`（`:219`）→ 检查
`SUPPORTED_PROTOCOL_VERSIONS`（`:233`）→ `notifications/initialized`（`:241`）→
`connected`，失败先 `close()` 再抛出。翻页在 `listAll()`（`:355-374`），`null` 与空串
cursor 的处理在 `validateListPage()`（`:104`），缺 `content` 补空数组在 `:150`。
`requestInternal()`（`:394`）在 `:421` 注明规范禁止取消 `initialize`；`cancelPending()`
（`:556`）与课程逐步相同。内存传输同样用 `structuredClone` 加 `queueMicrotask`
（`packages/mcp/src/transports/in-memory.ts:23-24`）。

**课程简化 · 上游客户端多做的事。** 上游 client 会服务服务器发起的请求：`handleRequest()`（`:487`）
按注册的处理器回答，并在 `incoming` 表里跟踪它们，以便处理服务器发来的
`notifications/cancelled`（`:521`、`:544`）；没有处理器时才回 method not found，课程一律
回 method not found。上游还支持 progress 通知，并能在收到进度时重新计时（`armTimeout()`，
`:548`），提供 resources 与 resource templates 的翻页，以及 Streamable HTTP 传输和 OAuth
（`transports/streamable-http.ts`、`oauth/`）。这些都属于课程简化，本章没有实现。

**课程简化 · stdio 的差异。** 上游 `StdioTransport` 用 Buffer 累积 stdout 并逐个找换行
（`packages/mcp/src/transports/stdio.ts:181-205`），去掉行尾 `\r`，并用 `maxMessageBytes`
限制单行大小。关闭同样是 stdin → `SIGTERM` → `SIGKILL` 三档（`:152-177`），缺省等待是
500ms 与 2000ms（`:8-10`）；它让服务器在自己的进程组里运行，用 `killProcessTree()`
（`:17`）连同服务器的子进程一起结束。课程只结束直接子进程。

**上游对照 · 命名与暴露。** `createMcpToolName()` 在
`packages/coding-agent/src/extensions/mcp/tools.ts:82-91`，规则与课程相同。上游的 MCP
暴露级别多一个 `codemode`，也是缺省值（`index.ts:128-129`、
`packages/coding-agent/src/core/mcp-servers.ts:17`）：工具只能从 codemode 脚本调用，脚本
用 `searchTools()` 找到它们。注册到工具表时，`toToolExposure()`（`tools.ts:39-41`）把
`codemode` 映射为 `deferred`。课程的缺省值直接是 `deferred`，模型经第 15 章的
`tool_search` 激活。上游还会在服务器的工具集合变化时把消失的工具重新注册为 `hidden`
（`index.ts:397-402`）；HTTP 服务器的连接遇到暂时性错误会按 `CONNECT_RETRY_DELAYS_MS`
（250ms、1000ms）重试（`packages/coding-agent/src/extensions/mcp/runtime.ts:50`、`:355-366`）。
课程简化：不处理重连、重试与工具变化，一次连接失败就停在 `failed`。

**上游对照 · `mcp_servers` 段落。** 上游在 `before_agent_start` 事件里写入
`systemPromptOptions.sections`（`index.ts:1018-1024`），再由第 13 章对照过的
`diffSystemPromptSections()` 生成补丁，所以“只在变化时打补丁”与课程是同一个机制。段落
内容不同：`renderServersSection()`（`index.ts:188`）只列出有 codemode 或 deferred 工具的
服务器，每行是命名空间、到达方式和一行服务器简介（来自配置的 description 或服务器的
instructions），整段限制在 4096 字符（`:156`）。课程列出全部服务器的状态和工具名，不写
任何描述。

**上游对照 · 有界等待。** 上游的 `waitForDirectServers()`（`index.ts:996-1014`）同样只等有 direct
工具的服务器，上限缺省 10 秒（`:90`），超时后提示用户；它在一个会话里只等一次
（`waitedForStartup`）。课程每次 `sections()` 都调用它，服务器已就绪时立即返回，仍在连接的
direct 服务器每次最多再等一个上限。上游的 codemode 脚本和 `tool_search` 在运行时还会等待
它们需要的服务器（`:1026` 起），课程没有这条路径。
:::

## 完整链路与本章验收

本章验收要能把开篇轨迹从下往上讲一遍：

1. `{ jsonrpc: "2.0", id: 1, result: {}, error: {…} }` 为什么被拒绝，三个谓词怎样保持互斥；
2. 服务器选了 `2024-11-05` 和 `1999-01-01` 时，client 分别处在什么状态，服务器收到了哪些消息；
3. `nextCursor` 为 `null`、`""`、重复的 `"1"` 时，`listTools()` 各自怎样结束；
4. 一个 `tools/call` 超时以后，`pending` 表、服务器和连接状态分别发生了什么；换成
   `initialize` 超时又有什么不同；
5. stdout 的一次 `data` 只带来半行时，这半行存在哪里，什么时候才被解析；
6. `b-c` 与 `b.c` 为什么得到不同的名字，同一个工具为什么每次得到同一个名字；
7. 模型直接调用 `mcp__docs__search_docs` 和脚本调用它，为什么结果不同；
8. 第三次 prompt 的两条 system 消息分别由谁追加，为什么一条在 user 之前，一条在 user 之后。

验收记录可写成：

```text
Lab 17.1: 3/3
Lab 17.2: 3/3
Lab 17.3: 2/2
Lab 17.4: 2/2
Lab 17.5: 3/3
chapter total: 13/13
```

:::checkpoint title="Checkpoint 17 · 外部服务器的工具走同一张注册表"
**完成状态：** `McpClient` 用三个互斥的谓词收窄 JSON-RPC 消息，经 `initialize` 与
`notifications/initialized` 完成握手，拒绝不支持的协议版本；`listTools()` 跟随
`nextCursor` 并拒绝重复 cursor；`callTool()` 补齐缺失的 `content`。

**请求状态：** 每个请求在 `pending` 表里登记，以响应、超时、abort 或连接关闭之一离开；
超时与 abort 发送 `notifications/cancelled`，`initialize` 除外；单个请求超时不关闭连接。

**传输状态：** 内存传输深复制并在微任务里交付；stdio 只解析以换行结束的行，坏行只报错，
关闭按 stdin、`SIGTERM`、`SIGKILL` 三档进行。

**接入状态：** 服务器工具以 `mcp__<server>__<tool>` 注册，必要时加 hash 后缀，缺省
`deferred`；服务器清单经 `RuntimeDeps.sectionProviders` 成为 `mcp_servers` 段落，由第 13 章的
`systemPatch()` 决定是否打补丁；首个 prompt 只对 direct 服务器做有界等待。

**公开证据：** `3/3 → 3/3 → 2/2 → 2/2 → 3/3`，共 `13/13`。

**恢复：** 回到 parent `ff14a103b53fe07b304e73d82364d69bdcb60cf8` 后，注册表、`tool_search`
与 codemode 仍然可用，但所有工具都来自进程内，Runtime 的期望 system 状态只有配置与资源。
:::

:::transfer title="迁移练习 · 给服务器清单加上失败原因的第一行"
完成 `13/13` 后，在独立练习文件里写一个只连接一次就失败的服务器（例如 `initialize` 返回
不支持的版本），观察 `status()` 里的 `error`。再写一个自己的 `SystemSectionProvider`，只在
服务器失败时输出一个 `mcp_failures` 段落，每行是服务器名和错误信息的第一行。

用同一个 Runtime 连续 prompt 两次，确认第二次没有新的段落补丁；再用一个开关让提供者
返回空对象，模拟服务器恢复，确认下一条补丁把 `mcp_failures` 写成 `null`。`composition.ts` 与 `mcp-runtime.ts` 都不需要改。
:::

## 小结

开篇的 `search_docs` 运行在另一个进程里。它先经过一次握手和一次翻页，才以
`mcp__docs__search_docs` 的名字进入注册表；之后模型看不见它、脚本能调用它、`tool_search`
激活它，这些都是第 15、16 章已有的规则，MCP 客户端没有为它们另开分支。

客户端本身围绕一张 `pending` 表展开：请求登记进去，响应、超时、abort 或连接关闭把它取
出来，超时和 abort 还要告诉服务器停下，`initialize` 例外。传输只负责把消息完整地送到对面：
内存传输深复制，stdio 只认完整的行。

服务器清单作为一个段落接到第 13 章的期望 system 状态上，变化与否仍由同一个
`systemPatch()` 判断。到这里，Runtime 能接入的工具已经不局限于自己的进程，但每次请求仍
发给 `RuntimeDeps.model` 这一个模型。第 18 章在 loop 的请求前加一个钩子，让用户选中的
模型和这次真正接收请求的模型分开。
