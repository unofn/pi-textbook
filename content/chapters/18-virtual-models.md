---
id: "18"
slug: virtual-models
part: advanced
partTitle: 第五部 · Pi 1.0 进阶
chapter: "18"
title: 虚拟模型：选择与派发分离
summary: 在 loop 的每次请求前加一个 prepareRequest 钩子，让用户选中的虚拟模型在这一刻换成目录里的物理模型；选择和路由状态写在会话分支上，派发记录在每条 assistant 消息自己的 model 字段上。
minutes: 120
difficulty: 进阶
artifact: packages/pi-course/src/virtual-models.ts
prerequisites: 10,13,15,17
terms: virtual model, physical model, model catalog, prepareRequest, request reason, router state, model_change, dispatch
upstream: packages/coding-agent/src/core/virtual-models.ts, packages/coding-agent/src/core/model-runtime.ts, packages/agent/src/agent-loop.ts
---

## 同一个 Runtime，每次请求换一个模型

第 17 章最后一个测试用 `createRuntime(CONFIG, deps)` 跑了三次 prompt。三个 MCP 服务器先后
连上，system 段落跟着变化，可三次请求都发给了同一个对象：`deps.model`。从第 07 章起，
loop 的每次请求都是 `options.model.stream(…)`，模型在创建 Agent 时就定死了。

现在用户在会话里选了一个叫 `auto` 的模型。`auto` 背后没有任何 provider，它只是一个规则：
奇数次请求交给便宜的 `fast-v1`，偶数次交给 `smart-v1`。Lab 18.3 的第三项测试从空会话开始，
跑完两次 prompt，关掉 Runtime，再从 `e7` 重新打开跑第三次。Session Store 里的 entry 是：

```text
e1   metadata  model_change         { modelId: "auto" }                       selectModel()
e2   message   user                 "first"
e3   message   assistant            model = "fast-v1"
e4   metadata  virtual_model_state  { modelId: "auto", state: { count: 1 } }
e5   message   user                 "second"
e6   message   assistant            model = "smart-v1"
e7   metadata  virtual_model_state  { modelId: "auto", state: { count: 2 } }
──── 关闭 Runtime，从 activeLeafId = "e7" 重新打开 ────
e8   message   user                 "third"
e9   message   assistant            model = "fast-v1"
e10  metadata  virtual_model_state  { modelId: "auto", state: { count: 3 } }
```

这条分支上有两类不同的事实。`e1` 记的是用户选了什么，它可以是虚拟模型；`e3`、`e6`、`e9`
的 `model` 字段记的是这一次请求实际发给了谁，它永远是物理模型。前一类叫选择，后一类叫
派发：

| | 选择 | 派发 |
|---|---|---|
| 回答的问题 | 用户想用哪个模型 | 这次请求实际发给谁 |
| 可以是虚拟模型吗 | 可以 | 不可以 |
| 写在哪里 | 分支上的 `model_change` metadata entry | assistant 消息自己的 `model` 字段 |
| 什么时候变 | 用户调用 `selectModel()` | 每次请求前，由路由决定 |

`e4`、`e7`、`e10` 是第三种事实：路由器的状态。`auto` 要知道自己已经路由过几次，才能决定
下一次给谁。这个计数写在分支上，所以重新打开会话后，第三次路由从 `count = 2` 继续，结果
回到 `fast-v1`。

把选择换成派发的时机只有一个：loop 发出请求之前。本章在那里加一个钩子：

```text
loop 第 N 次请求
  declareToolChanges          第 15 章的声明补丁
  prepareRequest(request)     读选择 → 物理模型直接用；虚拟模型问 route() → 换成物理模型
  model.stream(context, { signal, thinkingLevel })
```

provider 只会收到钩子返回的物理模型。钩子改不了 transcript，它只决定“这一次用哪个模型、
什么推理强度”。

## 建立练习起点

在教学历史仓库中生成隔离练习：

```bash
cd <你的工作区>/pi-course
npm run checkpoint -w @pi/course -- 18
npm run practice -w @pi/course -- 18 <新目录>
cd <新目录>
npm install
```

practice 会覆盖五个文件，其中两个没有施工位：

```text
packages/pi-course/src/types.ts            ThinkingLevel、ModelStreamOptions（无施工位）
packages/pi-course/src/agent.ts            AgentOptions.prepareRequest 原样交给 loop（无施工位）
packages/pi-course/src/virtual-models.ts   previous 与路由解析（Lab 18.1）；分支读取与路由器（Lab 18.3）
packages/pi-course/src/agent-loop.ts       请求原因与钩子调用（Lab 18.2）
packages/pi-course/src/composition.ts      钩子的分支视角、metadata 落盘、appendMetadata（Lab 18.3）
```

`types.ts` 给 `Model.stream` 的第二个参数换成了 `ModelStreamOptions`，多一个可选的
`thinkingLevel`。课程的推理强度是一个精简集合：

```ts
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface ModelStreamOptions {
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
}
```

第 05 章的 provider adapter 不解释这个字段，它只随请求传给物理模型。

:::rebuild title="Checkpoint 18 · 从红测试把选择和派发分开"
**模式：** 重建。从第 17 章 target 开始，增加模型目录、请求前钩子和分支上的路由状态。

**起终点：** `parent` `476c3b12cff507850d6fe88cd3122306845bebf9` 是起点；`target` `842d35ec4e60943a94d8df5389e728c7b75823eb` 是终点。

**教学文件：** `packages/pi-course/src/virtual-models.ts`、
`packages/pi-course/src/agent-loop.ts`、`packages/pi-course/src/composition.ts`

**学习脚手架：** `starters/18-types.ts` 与 `starters/18-agent.ts` 只加类型与透传，没有施工位。
`starters/18-virtual-models.ts` 已经给出 `ModelCatalog`、所有公共类型和 `selectModel()`；
`starters/18-agent-loop.ts` 已经把钩子的类型和调用位置留好；`starters/18-composition.ts`
已经给出 `appendEntry()`、`metadataEntry()`、`createRuntime()` 里的钩子接线和本轮结束时清空
缓冲的 `finally`。

**动手前只需知道：** 选择是分支上的 `model_change` entry，派发是 assistant 消息的 `model`
字段。虚拟模型的 `route(request)` 返回 `{ model, thinkingLevel?, state? }`，其中 `model`
必须是目录里一个物理模型的 id。loop 的钩子返回 `{ model?, thinkingLevel? }`，只影响这一次
请求。

**第一步：** 实现 `findLatestResponse()`：从后往前找第一条不是 `error` 或 `aborted` 的
assistant 消息。

**第一次红灯：** fresh starter 可以 build；只运行 Lab 18.1 时是 `1/3`。目录测试已经通过，
因为 `ModelCatalog` 是给定的；另外两项分别显示 `Lab 18.1 findLatestResponse 尚未实现` 和
`Lab 18.1 resolveRoute 尚未实现`。

**聚焦测试：** `packages/pi-course/test/18-virtual-models.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 18`

**练习目录：** `npm run practice -w @pi/course -- 18`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/18-*.test.js`。

**施工顺序：** 目录与路由解析 `3/3` → loop 的 `prepareRequest` 钩子 `3/3` → 分支上的选择与
状态 `4/4`。

**通过证据：** 三个 Lab 可以按 name-pattern 单独运行，最后本章 `10/10`，并能指出开篇 entry
列表里哪些行是选择、哪些是派发、哪些是状态。

第一次尝试先不看 target diff。只比较当前 Lab 的路由输入、返回值和第一个可观察偏差。
:::

验证起点：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 18.1" \
  packages/pi-course/dist/test/18-*.test.js
```

正确结果是 `1/3`，失败的两项与上面的首红一致。

## Lab 18.1：目录、previous 与路由解析

### 一张目录登记两种模型

`ModelCatalog` 已经给出。物理模型用 `registerPhysical(id, model)` 登记，得到
`{ id, model }`；虚拟模型用 `registerVirtual(virtual)` 登记，它只有 `id` 和 `route()`。同一个
id 只能属于其中一种，空白 id 直接拒绝：

```text
registerPhysical("fast", fast)
registerVirtual({ id: "auto", route })
physical("fast")   → { id: "fast", model: fast }
physical("auto")   → undefined
registerVirtual({ id: "fast", … })   → 模型 fast 已经是物理模型
registerPhysical("auto", fast)       → 模型 auto 已经是虚拟模型
```

能拿到 `Model` 对象的只有 `physical()`。虚拟模型没有 `stream()`，路由代码就算想把它交给
loop，也找不到可以交的对象。

### previous 跳过失败的回复

路由器经常要参考上一次是谁回答的，例如“上次用 fast 答得不好，这次换 smart”。上一次回答
从 transcript 里找：从后往前，第一条 `stopReason` 既不是 `error` 也不是 `aborted` 的
assistant 消息。

```text
user "a"
assistant  model = fast-v1   stop          ← findLatestResponse 返回这条
user "b"
assistant  model = smart-v1  error         跳过
assistant  model = smart-v1  aborted       跳过
```

失败的回复要跳过，因为它们不能代表一次成功的派发。下一节会看到，路由本身失败时 loop
也会写一条 `error` 回复，那条消息里根本没有物理模型发过请求。以 `toolUse` 结束的回复算
成功，它是正常回合的一部分。

### resolveRoute 只接受物理模型

`resolveRoute(catalog, virtualId, options)` 把一次虚拟选择换成物理模型：

```text
resolveRoute(catalog, "auto", { reason, messages, failed?, state?, signal? })
  virtual = catalog.virtual("auto")          没有 → Virtual model auto is not registered.
  latest  = findLatestResponse(messages)
  request = {
    model:    { id: "auto" },
    reason,
    previous: latest 的 model 是物理模型时 → { model: catalog.physical(latest.model) }
    failed:   options.failed 存在时 → { model?: 它的物理模型, message: options.failed }
    state:    options.state 存在时
    messages,
    signal:   存在时
  }
  route  = await virtual.route(request)      抛错 → 原样抛出
  target = catalog.physical(route.model)
    是另一个虚拟模型 → … routed to auto, which is another virtual model.
    不在目录里       → … routed to nope, which is not a physical model.
  返回 { model: target, thinkingLevel?, state? }
```

可选字段只在有值时出现。测试对第一次路由的请求做了 `deepEqual`：没有 `failed`、没有
`state`、没有 `signal` 时，请求对象里就没有这三个键。`failed` 的物理模型可能查不到（例如
那次失败本身就是路由失败），这时 `failed` 只带 `message`。

:::predict title="路由器把请求转给另一个虚拟模型时，应该递归路由吗"
`loop` 这个虚拟模型的 `route()` 返回 `{ model: "auto" }`，而 `auto` 也是一个虚拟模型。
`resolveRoute()` 可以接着问 `auto` 的路由器，也可以直接报错。哪一种更合适？

---answer
直接报错：`Virtual model loop routed to auto, which is another virtual model.` 允许递归就
要处理环（`a → b → a`），还要决定 `previous`、`state` 和 `reason` 在第二层怎样传递，第二层
的状态又该记在谁名下。只接受物理模型时，每次请求恰好经过一次路由，记录也只有一份。想组合
两个路由规则时，在一个 `route()` 函数里直接调用另一个函数即可。
:::

:::lab title="实践 18.1 · 找到上一次成功回复并解析路由"
**目标：** `findLatestResponse()` 跳过失败回复；`resolveRoute()` 组装路由请求，并只接受目录里
的物理模型。

**文件：** `packages/pi-course/src/virtual-models.ts`

**动作：**
1. 实现 `findLatestResponse()`：倒序遍历，返回第一条 `role === "assistant"` 且
   `stopReason` 不是 `error`、`aborted` 的消息。
2. 实现 `resolveRoute()`：未注册就抛错；按上面的规则组装 `ModelRouteRequest`，可选字段只在
   有值时加入；`await virtual.route()`；用 `catalog.physical()` 查结果，查不到时按
   `catalog.isVirtual()` 选择两种错误说明；返回 `{ model, thinkingLevel?, state? }`。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 18.1" packages/pi-course/dist/test/18-*.test.js`。

**预期：** `3/3`。三项分别证明目录区分两种模型；`previous` 跳过 `error` 与 `aborted` 回复、
`toolUse` 回复算成功；`resolveRoute()` 转达 `previous`、`failed`、`state`，并对路由到虚拟
模型、路由到未知 id、未注册、`route()` 抛错四种情况给出准确错误。
:::

## Lab 18.2：loop 在每次请求前问一次

### 钩子放在声明补丁之后

第 15 章的 loop 在每次请求前先算声明补丁，再用 `messages` 和 `definitions()` 组成请求。
钩子就放在这两步之后、`stream()` 之前，而且在 `try` 里面：

```ts
const context: AgentContext = {
  messages,
  tools: options.tools.definitions(),
};
const prepared = options.prepareRequest
  ? await options.prepareRequest(
      { context, model: options.model, ...requestReason(messages) },
      options.signal,
    )
  : undefined;
const model = prepared?.model ?? options.model;
const stream = model.stream(context, {
  signal: options.signal,
  ...(prepared?.thinkingLevel === undefined
    ? {}
    : { thinkingLevel: prepared.thinkingLevel }),
});
```

钩子拿到的 `AgentRequest` 有四个字段：本次的 `context`、配置的 `model`、请求原因 `reason`，
以及 retry 时那条失败回复 `failed`。它返回 `PreparedRequest`，两个字段都可选；返回
`undefined` 或省略 `model` 时，请求仍发给配置的模型。

几个细节都由测试固定：

- 没有钩子时不多一个 `await`。第 09 章的事件顺序依赖这里不多等一个 microtask，所以这里用
  条件表达式，不写 `await options.prepareRequest?.(…)`。
- `thinkingLevel` 只在钩子给出时才放进 options，测试断言物理模型收到的 options 恰好是
  `{ signal, thinkingLevel: "high" }`，`signal` 与 loop 的 signal 是同一个对象。
- 钩子看到的 `context` 就是这次请求的对象。loop 稍后还会往 `messages` 里追加回复，钩子要
  保留快照就得自己 `structuredClone()`。`PreparedRequest` 里没有 `context` 字段，钩子无法
  换掉消息，transcript 只会按 loop 的规则向后增长。

钩子在 `try` 里，所以它抛错或 reject 时走的是第 07 章已有的 catch：`failedModelTurn()` 生成
一条 `error` 回复，`errorMessage` 是钩子的错误信息，loop 以 `error` 结束。测试里配置的模型
一次请求都没收到，transcript 是原来的 user 加这条 error 回复。

### 请求原因从 transcript 尾部读出

路由器常常要区分“用户刚说了话”和“工具刚返回结果”。`requestReason(messages)` 只看最后
一条 assistant 之后的部分：

```text
找到最后一条 assistant 的位置，tail = 它之后的消息
  tail 里有 user                                         → user
  tail 为空，且这条 assistant 是 error 或 aborted          → retry，failed = 这条 assistant
  其他                                                    → continuation
```

测试里的四个例子：

```text
[user "go"]                                  → { reason: "user" }
[user "go", error 回复]                       → { reason: "retry", failed: error 回复 }
[user "go", error 回复, user "again"]          → { reason: "user" }
[user "go", assistant "ok"]                   → { reason: "continuation" }
```

正常的工具往返里，第一次请求前 tail 有 user，是 `user`；工具结果之后 tail 只有
`toolResult`，是 `continuation`。steering 和 follow-up 也是 user 消息，它们之后的请求同样是
`user`。

`retry` 只在一种情况下出现：调用方直接拿一段以失败回复结尾的 transcript 去调用
`runAgentLoop`。`Agent.prompt()` 总会先追加一条 user 消息，所以经过 Agent 和 Runtime 的请求
不会是 `retry`；loop 自己也从不重试。测试用直接调用验证这一点：transcript 以
`rate limited` 错误结尾，钩子看到 `retry:rate limited`，随后请求成功。

`direct` 是第四种原因，留给 loop 之外的请求（例如压缩摘要），由 Lab 18.3 的
`routeDirect()` 使用。`ModelRouteReason` 因此是 `RequestReason | "direct"`。

:::lab title="实践 18.2 · 在每次请求前调用钩子"
**目标：** loop 在每次请求前以正确的原因调用 `prepareRequest`，用它换入的模型和推理强度
发请求；钩子失败变成一条 error 回复。

**文件：** `packages/pi-course/src/agent-loop.ts`

**动作：**
1. 实现 `requestReason()`：倒序找最后一条 assistant，按上面三条规则返回。
2. 把 starter 里的 `prepareRequestHole()` 换成真正的调用：有钩子时
   `await options.prepareRequest({ context, model: options.model, ...requestReason(messages) }, options.signal)`，
   没有钩子时直接得到 `undefined`。保留后面已经写好的模型选择与 `thinkingLevel` 传递。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 18.2" packages/pi-course/dist/test/18-*.test.js`。

**预期：** `3/3`。三项分别证明一次工具往返里原因依次是 `user`、`continuation`，配置的模型
请求次数为 0、两条回复的 `model` 都是 `fast-v1`；直接重跑失败 transcript 时原因是 `retry`
并带 `failed`，钩子抛错让配置的模型一次也不被请求；`thinkingLevel` 与同一个 signal 传到
物理模型，钩子看到的 context 就是本次请求。
:::

## Lab 18.3：选择和状态留在分支上

### 从分支读出选择与状态

选择与状态都是第 10 章的 metadata entry，值是一个 JSON object：

```text
model_change          { modelId }
virtual_model_state   { modelId, state }
```

读取规则都是“沿当前分支从后往前，找最近的一条”。测试的分支有六条 metadata：

```text
m1  model_change         { modelId: "auto" }
m2  virtual_model_state  { modelId: "auto",  state: { turns: 1 } }
m3  virtual_model_state  { modelId: "other", state: { turns: 9 } }
m4  unrelated            { modelId: "nope" }
m5  model_change         { modelId: "fast-v1" }
m6  virtual_model_state  { modelId: "auto",  state: { turns: 2 } }
```

`branchSelection(branch)` 返回 `fast-v1`（`m5`），只看前四条时返回 `auto`。
`virtualModelState(branch, "auto")` 返回 `{ turns: 2 }`，`"other"` 返回 `{ turns: 9 }`。
key 不对的 `m4` 被忽略；值不是 object 的 `model_change`（例如直接写字符串 `"auto"`）也不算
选择。已经给出的 `metadataValue()` 负责这两项过滤。

两者都按分支读取，所以在会话树上切到另一条分支时，选择和状态会跟着那条分支走。第 10 章的
`pathTo()` 已经保证 active path 只包含所选 leaf 的祖先。

### 路由器把读和写放在一起

`createVirtualModelRouting(catalog, { defaultModelId })` 返回两个函数。它们共用一个内部
`resolve()`：

```text
resolve(session, reason, messages, failed, signal)
  branch   = session.branch()
  selected = branchSelection(branch) ?? defaultModelId
  selected 是物理模型 → { route: { model: 它 }, state: undefined }，不问路由器
  state    = reason === "direct" ? undefined : virtualModelState(branch, selected)
  route    = await resolveRoute(catalog, selected, { reason, messages, failed, state, signal })
```

`prepareRequest(request, session, signal)` 在 `resolve()` 之后决定要不要记录新状态：只有
`route.state` 有值、并且与读到的旧状态按 JSON 比较不同时，才调用
`session.record("virtual_model_state", { modelId: selected, state: route.state })`。它返回
`{ model: route.model.model, thinkingLevel? }`，也就是 `PhysicalModel` 里的 `Model` 对象。

`routeDirect(session, messages, signal)` 以 `direct` 原因调用 `resolve()`，不读状态，也不调用
`record()`，返回整个 `ResolvedRoute`。测试里的路由器在 `turns >= 1` 时选 `smart-v1`，所以
一次 direct 请求回到了第一跳 `fast-v1`。

状态只在变化时记录。测试的路由器把 `turns` 封顶在 1：第一次返回 `{ turns: 1 }`，写一条；
第二次读到 `{ turns: 1 }`，又返回 `{ turns: 1 }`，不写。分支上的 metadata 数量随状态变化
增长，与请求次数无关。

### Runtime 给钩子一个分支视角

loop 的钩子签名是 `(request, signal)`，它不知道 session。第 13 章的 Runtime 知道，于是
`RuntimeDeps.prepareRequest` 多一个参数：

```ts
export interface RuntimeRequestSession {
  branch(): readonly SessionEntry[];
  record(key: string, value: JsonValue): void;
}
```

`createRuntime()` 已经把 `deps.prepareRequest` 接到 Agent 上，每次调用都传入一个新的
`requestSession()`。这个视角有两条规则：

- `record()` 只把 `{ key, value }` 深复制后放进 `pendingMetadata`，不碰 Session Store；
- `branch()` 返回 `activePath` 的深副本，后面接上 `pendingMetadata` 生成的临时 entry，id 是
  `__runtime_pending_0`、`__runtime_pending_1`……

第二条规则让同一轮里的下一次请求看得到刚记录的状态。一次 prompt 里如果有工具往返，第二次
请求的 `continuation` 路由会从第一次请求记下的 `count` 继续，即使它还没有落盘。

缓冲的 metadata 在 `persist()` 里写入：先逐条追加本轮的消息 suffix，再逐条追加 metadata。
两者都用已经给出的 `appendEntry()`，它在 Store 接受之后推进 leaf，失败时 poison Runtime。
无论 persist 成功与否，`prompt()` 的 `finally` 都会清空缓冲。

为什么等消息写完再写状态？状态描述的是“到这一轮为止路由器做过的决定”，放在本轮回复之后，
恢复时读到的状态就和这条分支上最后一条回复对应。开篇 entry 列表里 `e4` 跟在 `e3` 之后、
`e7` 跟在 `e6` 之后，测试按顺序断言了全部 entry 和 parent 链 `null, e1, …, e6`。

选择的写入走另一条路。`selectModel(runtime, catalog, modelId)` 已经给出：未注册的 id 直接
拒绝，否则调用 `runtime.appendMetadata("model_change", { modelId })`。`appendMetadata` 要和
`prompt()` 排在同一条 `operationTail` 上：

```text
appendMetadata(key, value)
  disposed → 拒绝；poisoned → 以 poisonCause 拒绝
  operation = operationTail.then(() => {
    assertHealthy()
    appendEntry(metadataEntry(key, value))
  })
  operationTail = operation 的结果被吞掉的版本
  return operation
```

排在同一条队列上，用户在一次 prompt 运行中途切换模型时，`model_change` 会等这一轮提交后
再写，parent 是这一轮的最后一个 entry。

### 重新打开与路由失败

开篇列表的后半段是恢复。新的 Runtime 从 `e7` 恢复 active path，`branchSelection` 读到 `e1`
的 `auto`，`virtualModelState` 读到 `e7` 的 `{ count: 2 }`。路由器算出 `count = 3`，奇数，
派发给 `fast-v1`；新状态落在 `e10`，`parentId` 是 `e9`，`timestamp` 是 110。恢复只依赖 active
path，Runtime 和路由器都没有额外的内存状态。

路由失败的测试让路由器第一次抛出 `router exploded`：

```text
prompt("first")
  钩子 reject → loop 写一条 error 回复，errorMessage 含 router exploded
  路由器没有返回，record() 没被调用
  Store：message(user)、message(assistant error)，没有 metadata
prompt("second")
  requestReason：error 回复之后有新的 user → user
  路由器第二次被调用，返回 fast-v1 与 { count: 2 }
  Store 多出 user、assistant 和一条 virtual_model_state
```

第二轮的原因是 `user`。Agent 先追加了 user 消息，loop 不把这次请求看成重试；`previous` 也
不会指向那条 error 回复。

反过来，路由成功而物理模型的请求失败时，钩子已经记下的状态照样会在本轮结束后落盘：路由器
已经为这次请求做了决定，模型失败并不撤销这个决定。

:::predict title="路由状态应该写进 transcript 还是 session"
`auto` 的计数可以作为一条消息放进 transcript，也可以作为 metadata entry 写进 session。两种
做法在恢复时都能读到。哪一种更合适？

---answer
写进 session。transcript 是模型每次都会读到的上下文，路由状态是给路由器看的，放进 transcript
会被投影进请求，还会让计数的每次变化都变成模型能看见的一条消息。metadata entry 留在分支上，
Runtime 恢复 Agent 时只取 message entry，`buildContext()` 也不把 metadata 投影进请求，模型
看不到它；它又和消息共享同一条 parent 链，切换分支、恢复会话时自然跟着走。
:::

:::lab title="实践 18.3 · 把选择与状态接到分支上"
**目标：** 从分支读出选择和状态；路由器只在状态变化时记录；Runtime 让钩子读到包含本轮缓冲
的分支，并在本轮消息之后落盘。

**文件：** `packages/pi-course/src/virtual-models.ts`、`packages/pi-course/src/composition.ts`

**动作：**
1. 实现 `branchSelection()` 与 `virtualModelState()`：倒序遍历，用 `metadataValue()` 过滤 key
   与值的形状。
2. 实现 `createVirtualModelRouting()`：内部 `resolve()`、`prepareRequest()`（按 JSON 比较后才
   `record()`）与 `routeDirect()`。
3. 在 `composition.ts` 中实现 `requestSession()` 的 `branch()` 与 `record()`。
4. 把 `persist()` 里的临时异常换成循环：`pendingMetadata.splice(0)` 的每一项都
   `appendEntry(this.metadataEntry(key, value))`。
5. 实现 `appendMetadata()`，与 `prompt()` 共用 `operationTail`。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 18.3" packages/pi-course/dist/test/18-*.test.js`。

**预期：** `4/4`。四项分别证明分支读取规则；状态只在变化时记录、选中物理模型时不问路由器、
direct 请求不读不写状态；经 Runtime 的 entry 顺序、parent 链和重新打开后的第三次路由；路由
失败时本轮只有两条消息、下一轮从分支上的选择重新路由。
:::

## 十项测试固定了哪些边界

| Lab | 数量 | 可观察事实 |
|---|---:|---|
| 18.1 | 3 | 目录 id 唯一、`previous` 跳过失败回复、路由只接受物理模型、四种路由错误 |
| 18.2 | 3 | 钩子在每次请求前调用、`user`/`continuation`/`retry` 三种原因、钩子失败变成 error 回复、`thinkingLevel` 与 signal 传递 |
| 18.3 | 4 | 分支读取、状态只在变化时记录、direct 不读写状态、entry 顺序与恢复、路由失败不写状态 |

全章运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/18-*.test.js
```

再运行当前练习目录全部课程测试。没有钩子的 loop 不多一个 `await`，第 09 章的事件顺序测试
应该保持通过：

```bash
node --test packages/pi-course/dist/test/*.test.js
```

## 课程路由与真实 Pi 的关系

:::pi title="与上游 Pi v1.0.0 对照"
上游 Pi 1.0 把同一套分工写在三层：`packages/agent` 的 loop 提供请求前钩子，
`packages/coding-agent/src/core/model-runtime.ts` 管目录和路由解析，
`packages/coding-agent/src/core/agent-session.ts` 把钩子接到会话分支上。

**上游对照 · 相同的骨架。** `packages/coding-agent/src/core/virtual-models.ts:1-11` 的文件说明与本章开篇
的分工一致：选择可以是虚拟模型，路由之后的一切只见到物理模型，“A virtual model never
reaches a provider”。四种请求原因在 `:43-50`，`findLatestResponse()` 在 `:110`，跳过 error 与
aborted 的规则与课程逐行相同。`resolveModel()`（`model-runtime.ts:994-1025`）同样先查未注册，
再用 `findLatestResponse()` 算 `previous`，调用 `route()` 后要求结果是物理模型。loop 的钩子在
`packages/agent/src/agent-loop.ts:219`，排在 `:211` 的工具声明补丁之后，顺序与课程相同；
契约写在 `packages/agent/src/types.ts:267-271`。

**课程简化 · 钩子能改什么。** 上游的钩子还收到当前 `thinkingLevel`，并且可以返回新的 `context`
（`agent-loop.ts:219-238`）；返回的模型和推理强度会替换本次运行余下请求的配置。
`AgentSession` 用这一点在钩子里重新投影会话、必要时先做自动压缩
（`agent-session.ts:759-815`）。课程的 `PreparedRequest` 没有 `context`，每次请求都重新调用
钩子，换入的模型只影响这一次。

**课程简化 · 模型身份。** 上游模型由 provider 和 id 共同确定。虚拟模型挂在某个 provider 名下
（`virtual-models.ts:84`），`registerVirtualModel()` 拒绝与该 provider 的物理模型同名
（`model-runtime.ts:955-960`），并把虚拟模型列进 provider 的目录供用户选择。`route()` 返回的是
`Model` 对象。路由到虚拟模型或未知模型都报同一句 “which is not a physical model”（`:1022`），
没有课程区分出的 “another virtual model”；之后还检查目标 provider 有没有凭据（`:1023`），并把
推理强度裁剪到目标模型支持的范围（`clampThinkingLevel`，`:1024`）。课程的目录只用一个 id，
`ThinkingLevel` 也只有五个值。

**课程简化 · retry 从哪里来。** 上游的 `retry` 来自真正的自动重试：`AgentSession` 判断错误可重试后把
失败回复存进 `_failedResponse`（`agent-session.ts:1819`，上下文溢出后的压缩重试在 `:2998`），
下一次钩子读取并清空它（`:762-763`），再按 `failed ? "retry" : userTurn ? "user" : "continuation"`
算原因（`:795`）。重试时 `messages` 已经不含那条失败回复（`virtual-models.ts:62`）。课程没有
自动重试，只从 transcript 的形状推出 `retry`，所以它只在直接调用 `runAgentLoop` 时出现。

**课程简化 · 状态与选择的记录。** 上游的路由状态是一条 custom entry，类型为 `pi.virtual-model-state`
（`virtual-models.ts:32`），数据带 `provider`、`modelId` 和 `state`。钩子在路由之后立即
`appendCustomEntry()`（`agent-session.ts:801-807`），用 `!==` 判断状态是否变化，路由器想保留
旧状态时要原样返回同一个对象。课程用 metadata entry，按 JSON 比较，并把状态缓冲到本轮消息
之后再写。选择在上游是专门的 `model_change` entry（`setModel()` 里的 `appendModelChange()`，
`agent-session.ts:2438`）；`getBranchSelection()`（`virtual-models.ts:128`）在最近一条
`model_change` 不是虚拟模型时，以更晚的物理回复为准，`_recordSelection()`（`:593-609`）在分支
隐含的选择与当前模型不同时补写一条。课程只读 `model_change`，没有时用 `defaultModelId`。

**上游对照 · direct 请求。** 上游的压缩摘要在请求前用 `reason: "direct"` 路由
（`agent-session.ts:555-561`），不读也不写状态，与课程的 `routeDirect()` 对应。

**上游对照 · 派发记录。** 上游同样不另写派发记录：assistant 消息自己的 `provider` 与 `model`
就是这次请求的物理模型。虚拟选择下，`_modelForMessage()`（`agent-session.ts:584-591`）按这两个
字段找回物理模型，用它的上下文窗口等限制。课程的 assistant 消息只有 `model` 字段，派发记录就是
它。
:::

## 分支上的三种事实与本章验收

本章验收要能用开篇的 entry 列表回答：

1. `e1`、`e3`、`e4` 分别属于选择、派发、状态中的哪一种，为什么只有 `e3` 永远是物理模型；
2. `loop` 路由到 `auto`、`ghost` 路由到 `nope` 时，`resolveRoute()` 各报什么错，为什么不递归；
3. 一次工具往返里两次请求的原因分别是什么，`retry` 为什么不会经过 `Agent.prompt()` 出现；
4. 钩子抛错时，配置的模型有没有收到请求，transcript 多了什么；
5. 同一轮 prompt 的第二次请求为什么能读到第一次请求刚记录、尚未落盘的状态；
6. `e4` 为什么排在 `e3` 之后，而不在 `e2` 之前；
7. 重新打开会话后，第三次路由的 `count` 从哪里来；
8. 路由失败的那一轮为什么没有 `virtual_model_state`，下一轮为什么是 `user` 而不是 `retry`。

验收记录可写成：

```text
Lab 18.1: 3/3
Lab 18.2: 3/3
Lab 18.3: 4/4
chapter total: 10/10
```

:::checkpoint title="Checkpoint 18 · provider 只见到物理模型"
**完成状态：** `ModelCatalog` 登记物理与虚拟模型，id 唯一；`resolveRoute()` 把一次虚拟选择
换成目录里的物理模型，路由到虚拟模型、未知 id、未注册与 `route()` 抛错都以异常结束。

**loop 状态：** 每次请求前、工具声明补丁之后调用 `prepareRequest`，原因是 `user`、
`continuation` 或 `retry`；钩子换入的模型与 `thinkingLevel` 只用于这一次请求；钩子失败以一条
error 回复结束运行；钩子改不了 transcript；没有钩子时不多一个 `await`。

**分支状态：** 选择是 `model_change`，状态是 `virtual_model_state`，都按当前分支取最近一条；
状态只在 JSON 变化时记录，并在本轮消息 suffix 之后落盘；`appendMetadata` 与 prompt 共用一条
队列；派发写在每条 assistant 消息自己的 `model` 字段上。

**公开证据：** `3/3 → 3/3 → 4/4`，共 `10/10`。

**恢复：** 回到 parent `476c3b12cff507850d6fe88cd3122306845bebf9` 后，Runtime 仍能接入 MCP
工具和段落，但每次请求都发给 `RuntimeDeps.model`，分支上没有选择与路由状态。
:::

:::transfer title="迁移练习 · 失败后换一个模型"
完成 `10/10` 后，在独立练习文件里写一个虚拟模型 `fallback`：`previous` 为空时选 `fast-v1`；
`reason` 是 `retry` 且 `failed.model` 是 `fast-v1` 时选 `smart-v1`；其他情况沿用 `previous`
的模型。

直接调用 `runAgentLoop`，用一段以 `fast-v1` 的 error 回复结尾的 transcript 验证它选了
`smart-v1`；再经 Runtime 跑一轮，确认同样的失败之后因为追加了 user，原因变成 `user`，
`failed` 为空，路由器不会因为这次失败切到 `smart-v1`。`virtual-models.ts` 与 `agent-loop.ts` 都不需要改。
:::

## 小结

开篇的 entry 列表里，`model_change` 记下用户选了 `auto`，三条 assistant 消息记下实际回答的
`fast-v1`、`smart-v1`、`fast-v1`，三条 `virtual_model_state` 记下路由器的计数。三种事实写在
不同的位置，各自有一个负责人：`selectModel()` 写选择，loop 写派发，路由器经 Runtime 写状态。

把它们连起来的是 loop 里的一个钩子。它排在工具声明补丁之后、`stream()` 之前，从 transcript
尾部读出请求原因，从分支读出选择和状态，最后交出一个物理模型。路由只决定这一次请求，不改
transcript；失败时写一条 error 回复，下一轮重新从分支上的选择开始。

到这里，Runtime 的每一次提交仍然发生在整轮运行结束之后：消息 suffix、段落补丁和路由状态都
等 `Agent.prompt()` 完成才逐条 append。第 19 章换一个问题：进程在运行中途崩溃时，哪些步骤
已经算数，重放时哪些可以跳过，并用“先提交，再可见”回答它。
