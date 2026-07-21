---
id: "06"
slug: tool-contract
part: core
partTitle: 第二部 · 闭合 Agent 核心
chapter: "06"
title: 工具调用：一条 echo 请求怎样变成配对结果
summary: 跟随一次 echo 调用，观察参数怎样经过 schema、Registry 和 executor，最后形成同 id 的工具结果。
minutes: 150
difficulty: 核心
artifact: packages/pi-course/src/tool.ts
prerequisites: 03,05
terms: tool contract, runtime validation, registry, tool result, call id
upstream: packages/agent/src/types.ts, packages/agent/src/agent-loop.ts
---

## 你将得到什么

第 05 章结束时，模型已经能提出一条完整的 `ToolCall`。现在固定其中一条：

```ts
const echoCall: ToolCall = {
  type: "toolCall",
  id: "call-1",
  name: "echo",
  arguments: {
    value: "Pi",
    ignored: "drop me",
  },
};
```

这条对象记录了模型的请求：调用 `echo`，把 `"Pi"` 交给它。`id: "call-1"` 会一路
进入执行结果，让下一轮模型知道结果回答的是哪次调用。

完成这一章后，下面的调用会正常返回：

```ts
const result = await executeToolCall(echoCall, tools);
```

忽略每次运行都会变化的 `timestamp`，`result` 是：

```ts
{
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "echo",
  content: [{ type: "text", text: "Pi" }],
  details: { source: "echo" },
  isError: false,
}
```

模型传来的 `ignored` 没有进入工具参数，也没有进入结果。`echo` 只收到 schema 声明的
字段 `{ value: "Pi" }`。

这条成功路径经过三个对象：schema 检查参数，`ToolRegistry` 找到本次运行允许使用的
工具，`executeToolCall()` 按顺序调用它们并生成 `ToolResultMessage`。

```text
echoCall
  id=call-1, name=echo
  arguments={ value: "Pi", ignored: "drop me" }
        │
        ▼
tools.get("echo")
        │
        ▼
echo.schema.parse(arguments)
  → { value: "Pi" }
        │
        ▼
echo.execute({ value: "Pi" })
  → content=[text("Pi")], details={ source: "echo" }
        │
        ▼
ToolResultMessage
  toolCallId=call-1, toolName=echo, isError=false
```

随后我们会改变这条调用的参数或查找结果，观察参数错误、未知工具和工具异常怎样得到
同一种配对结果。先把正常路径中的三个部件建立起来。

实现只修改：

```text
packages/pi-course/src/tool.ts
```

## echo 同时带着描述和可执行函数

先写出刚才使用的 `echo`。它有名称、给模型看的说明、参数 schema 和本地执行函数：

```ts
const echoSchema = objectSchema({
  value: stringValue,
});

const echo: Tool<{ value: string }> = {
  name: "echo",
  description: "Echo one value",
  schema: echoSchema,
  async execute({ value }) {
    return {
      content: [text(value)],
      details: { source: "echo" },
    };
  },
};

const tools = new ToolRegistry([echo]);
```

模型无法直接调用 `execute`。Provider 只会收到 `name`、`description` 和参数的 JSON
Schema。真正执行时，程序从同一个 Registry 中找到 `echo`，调用
`echo.schema.parse()`，再把解析后的值交给 `echo.execute()`。

`Tool` 接口把这两面放在同一个对象里：

```ts
export interface Tool<P, D = unknown> {
  name: string;
  description: string;
  schema: Schema<P>;
  execute(
    parameters: P,
    context: ToolContext,
  ): Promise<ToolOutput<D>>;
}
```

`P` 是工具真正接收的参数类型。模型生成的 `ToolCall.arguments` 仍是 `unknown`；只有
`schema.parse()` 成功后，executor 才得到 `P`。

这条调用要保持一个配对规则：executor 收到 `call-1/echo`，无论成功还是失败，返回的
消息都继续使用 `toolCallId: "call-1"` 和 `toolName: "echo"`。结果可以报告错误，但
不能让原调用从 transcript 中悬空。

:::rebuild title="Checkpoint 06 · 让一条 echo 调用经过三道边界"
**模式：** 重建

**起终点：** `parent` 是第 05 章完成后的起点；`target` 是 4 项聚焦测试通过的终点。

**教学文件：** `packages/pi-course/src/tool.ts`

**学习脚手架：** 练习目录已经声明 `Schema`、`Tool`、`ToolRegistry` 和 executor 的
公共签名，但不包含 target 实现。三个 Lab 的运行时入口仍会抛出带编号的临时错误。

**动手前只需知道：** schema 同时提供给模型看的 `jsonSchema` 和运行时使用的
`parse()`；Registry 保存本次允许使用的工具；executor 按
`lookup → parse → execute → result` 前进。

**第一次红灯：** starter 可以通过 build。只运行 validator 测试时，第一条运行时错误
是 `Lab 6.1 objectSchema 尚未实现`。

**第一步：** 先不看 target diff。运行 build 和 validator 测试，确认起点；随后只完成
schema 与 validator，不提前实现 Registry 或 executor。

**聚焦测试：** `packages/pi-course/test/06-tool-contract.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 06`

**练习目录：** `npm run practice -w @pi/course -- 06`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/06-*.test.js`

**通过证据：** 4 项测试分别观察 validator、Registry、成功结果、三类失败，以及
callId、signal、progress、content、details 和 `isError`。
:::

## 同一个 schema 做两件不同的事

把 `echoSchema` 展开，可以看到两种能力：

```ts
export interface Schema<T> {
  parse(value: unknown): T;
  jsonSchema?: Record<string, unknown>;
}
```

`jsonSchema` 会进入第 05 章的 Provider 请求。`parse()` 留在本地，executor 每次执行
前都会调用它。前者告诉模型应该生成什么，后者检查模型实际生成了什么。

对于只接收 `value: string` 的 echo，模型看到的定义是：

```ts
{
  type: "object",
  properties: {
    value: { type: "string" },
  },
  required: ["value"],
  additionalProperties: false,
}
```

这份描述能引导模型生成 `{ "value": "Pi" }`。模型输出仍来自进程外，程序不能因为
请求里已经带过 schema 就跳过运行时检查。

同一个 `echoSchema` 收到开头的 arguments：

```ts
echoSchema.parse({
  value: "Pi",
  ignored: "drop me",
});
```

输出是一个新对象：

```ts
{ value: "Pi" }
```

`parse()` 只遍历 schema 声明的字段，因此 `ignored` 被过滤。原始 arguments 没有被
修改。`echo.execute()` 只会看到返回的新对象。

### validator 是一个带元数据的函数

最小的 `stringValue` 既能调用，也保存自己的 JSON Schema：

```ts
export const stringValue: Validator<string> = Object.assign(
  (value: unknown) => {
    if (typeof value !== "string") {
      throw new Error("必须是 string");
    }
    return value;
  },
  { jsonSchema: { type: "string" } },
);
```

`Object.assign()` 把函数和元数据放到同一个值上。`objectSchema()` 可以调用这个函数
检查字段，也可以读取 `stringValue.jsonSchema` 生成 Provider 定义。

课程还提供两个可选字段 validator：

```ts
const requestSchema = objectSchema({
  value: stringValue,
  label: optionalString,
  limit: optionalPositiveInteger,
});
```

`optionalString` 接受字符串或 `undefined`。`optionalPositiveInteger` 接受大于等于 1 的
整数或 `undefined`。它们带有 `optional: true`，所以 `label` 和 `limit` 不进入 JSON
Schema 的 `required` 数组。

用测试中的完整值调用 `parse()`：

```ts
requestSchema.parse({
  value: "Pi",
  label: "answer",
  limit: 2,
  ignored: "drop me",
});
```

得到：

```ts
{
  value: "Pi",
  label: "answer",
  limit: 2,
}
```

省略可选字段时，返回对象保留字段名，值为 `undefined`。`null`、数组、`value: 1` 和
`limit: 0` 分别在对象检查或字段 validator 中被拒绝。

`objectSchema()` 的泛型会根据每个 validator 的返回类型推导结果字段。实现部分只需
完成运行时遍历和 JSON Schema 生成，不用重写这段映射类型。

:::predict title="模型已经看过 schema，parse 还能省略吗"
Provider 请求带有 `additionalProperties: false`，模型仍返回
`{ value: "Pi", ignored: "drop me" }`。executor 能否把原对象直接交给 echo？
---answer
不能。JSON Schema 描述模型应该怎样生成参数，不会替本地程序检查实际 JSON。
`parse()` 重新验证 `value`，并只把声明过的字段放进新对象；`ignored` 不会到达工具。
:::

:::lab title="实践 6.1 · 生成模型描述，并解析运行时参数"
**目标：** 让同一组 validator 写出 JSON Schema，也把 `unknown` 收窄成新对象。

**文件：** `packages/pi-course/src/tool.ts`

**动作：**
1. 实现 `stringValue`、`optionalString` 和 `optionalPositiveInteger`。
2. 让 `objectSchema()` 生成 `properties`、`required` 和
   `additionalProperties: false`。
3. `parse()` 拒绝非对象输入，只遍历 shape 中声明的字段，并返回新对象。
4. 删除 Lab 6.1 的临时错误，只运行 validator 测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="validator" \
  packages/pi-course/dist/test/06-*.test.js
```

**领域输出：** 带额外字段的合法输入变成
`{ value: "Pi", label: "answer", limit: 2 }`；错误类型停在 parse 内。

**测试证据：** 局部测试应为 `1/1`，并比较完整 JSON Schema、字段过滤、可选字段和
三种非法输入。
:::

## Registry 保存这一次允许使用的工具

创建 `new ToolRegistry([echo])` 后，这个 Registry 只包含一项允许动作：`echo`。
它使用自己的 `Map<string, Tool>` 保存对象，不写入模块级全局变量。

```text
tools
  "echo" → echo Tool
```

调用者可以为另一个产品入口创建不同的 Registry，例如只注册 `read`，或者同时注册
`echo` 和 `upper`。两个实例不会共享工具。Registry 因而明确了交给这次运行的动作
空间。

四个方法分别提供不同视角：

| 方法 | 返回或动作 | 使用者 |
|---|---|---|
| `register(tool)` | 检查重名后保存工具 | 组合代码 |
| `get(name)` | 返回可执行 Tool 或 `undefined` | executor |
| `list()` | 按注册顺序返回 Tool 数组 | 本地检查 |
| `definitions()` | 返回 name、description、parameters | Provider 请求 |

`tools.definitions()` 不包含 `execute`。函数不能进入网络请求，模型也不需要看到本地
实现。对开头的 echo，它返回：

```ts
[
  {
    name: "echo",
    description: "Echo one value",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
]
```

Registry 不会自己接入模型。组合代码要显式把这些定义放进本轮 context：

```ts
const stream = model.stream({
  systemPrompt: options.context.systemPrompt,
  messages,
  tools: options.tools.definitions(),
});
```

到了第 05 章的 Provider adapter，`context.tools` 才由
`toProviderTools(context.tools)` 翻译进请求。这段连接代码不在本章的 4 项聚焦测试里；
它只是说明 Registry 的输出怎样抵达上一章已经写好的边界。

`tools.get("echo")` 则返回完整的 echo 对象，包括同一份 schema 和 `execute()`。模型
可见的定义与 executor 能找到的实现由同一张表产生。

重复注册 `echo` 会抛出 `Tool 已存在：echo`。静默覆盖会让 Provider 已经看到的定义与
真正执行的函数在运行中发生变化，所以 Registry 在写入前检查名称。

工具没有提供 `jsonSchema` 时，`definitions()` 使用 `{ type: "object" }` 作为最小
参数描述。`objectSchema()` 会提供前面看到的精确版本。

:::lab title="实践 6.2 · 固定本次运行的工具表"
**目标：** 让 Provider 定义与本地执行器从同一个 Registry 取得 echo。

**文件：** `packages/pi-course/src/tool.ts`

**动作：**
1. 为每个 Registry 实例创建私有 Map。
2. 构造器逐个注册初始工具；`register()` 在写入前拒绝重名。
3. 实现 `get()` 和保持注册顺序的 `list()`。
4. `definitions()` 只交出 name、description 和参数 schema。
5. 删除 Lab 6.2 的临时错误，只运行 Registry 测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Registry" \
  packages/pi-course/dist/test/06-*.test.js
```

**领域输出：** `get("echo")` 返回可执行工具；`definitions()` 只返回 Provider 可见字段；
第二次注册 echo 得到明确错误。

**测试证据：** 局部测试应为 `1/1`。测试还注册 `upper`，检查定义、对象身份和顺序。
:::

## executor 按固定顺序完成 echoCall

schema 与 Registry 准备好后，`executeToolCall()` 负责一次完整调用：

```text
1. registry.get(call.name)
2. tool.schema.parse(call.arguments)
3. tool.execute(parsed, { ...context, callId: call.id })
4. 把 ToolOutput 写成 ToolResultMessage
```

第一步找到开头注册的 echo。第二步把
`{ value: "Pi", ignored: "drop me" }` 变成 `{ value: "Pi" }`。第三步才进入
`echo.execute()`，所以工具产生副作用之前已经拿到经过检查的参数。

`ToolContext` 还会把调用身份和运行控制交给工具：

```ts
{
  ...context,
  callId: call.id,
}
```

外部 context 可以携带 `signal` 和 `reportProgress`。executor 原样传递它们，并在最后
写入 `callId`，因此调用者不能用 context 覆盖模型的 call id。signal 到达工具只说明
取消请求已经传递；工具仍要主动观察 signal，才能及时停止自己的工作。

### content 给模型，details 给程序

echo 返回的 `ToolOutput` 是：

```ts
{
  content: [{ type: "text", text: "Pi" }],
  details: { source: "echo" },
}
```

executor 保留这两个字段。`content` 会作为 `ToolResultMessage` 的正文进入下一轮模型
上下文；`details` 保存 UI、日志或调用方需要的结构化信息。模型不需要读取 details
才能理解结果，程序也不必从正文 `"Pi"` 中反向解析来源。

工具可以显式返回 `isError: true` 表示领域失败，同时提供有用的 content 和 details。
这条路径没有抛异常。工具省略 `isError` 时，executor 写入 `false`。

测试中的 `inspect` 工具展示了完整 context。它收到 `callId: "ctx"`、同一个 signal 和
同一个 progress callback，先报告 `progress:Pi`，再返回：

```ts
{
  content: [text("done:Pi")],
  details: { phase: "domain-error" },
  isError: true,
}
```

这些值全部进入最终 ToolResultMessage；executor 不会因为 `isError: true` 丢掉 output。

## 三种失败仍然回答原调用

成功路径已经闭合。现在分别替换 `echoCall` 的一个条件，观察 executor 停在哪一步。

### 参数类型错误：parse 拦在 execute 前

把 arguments 改为：

```ts
{ value: 1 }
```

Registry 仍能找到 echo，`stringValue` 随后抛出 `必须是 string`。`echo.execute()` 没有
运行，executor 返回：

```ts
{
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "echo",
  content: [text("Tool echo failed: 必须是 string")],
  details: { error: "必须是 string" },
  isError: true,
}
```

### 未知工具：查找结束后不再解析

保留 id，把名称改成 `missing`：

```ts
{ ...echoCall, name: "missing", arguments: {} }
```

`tools.get("missing")` 返回 `undefined`。executor 不调用任何 schema 或 execute，直接
形成：

```ts
{
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "missing",
  content: [text("Tool missing failed: 未知工具")],
  details: { error: "未知工具" },
  isError: true,
}
```

结果保留请求中的 name。把它改写成某个已注册工具名，会掩盖模型实际请求了未知动作。

### 工具抛错：调用已经进入 execute

在独立 Registry 中注册一个会抛出 `new Error("exploded")` 的 echo，再执行原来的
`echoCall`。lookup 与 parse 都已经成功，异常发生在 execute 内。结果仍然配对：

```ts
{
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "echo",
  content: [text("Tool echo failed: exploded")],
  details: { error: "exploded" },
  isError: true,
}
```

聚焦测试使用名为 `boom` 的工具隔离这条分支，执行规则相同。executor 把 Error 的
`message` 写进 content 和 details，不附带 stack。普通错误文本仍可能由工具主动包含
路径或秘密；这一章没有实现通用脱敏。

三种失败都通过 Promise 正常返回 ToolResultMessage。第 07 章因此可以把每个结果按
call id 写回 transcript，不需要同时处理“返回消息”和“executor 向外抛错”两条通道。

:::lab title="实践 6.3 · 让成功与失败都形成配对结果"
**目标：** 按 `lookup → parse → execute → result` 完成一次调用，并保留 output 与
运行 context。

**文件：** `packages/pi-course/src/tool.ts`

**动作：**
1. 写 `failedResult()`，统一 role、原 id/name、错误正文、details、`isError` 和时间。
2. 未知名称在 lookup 后直接返回失败结果。
3. 用 try/catch 包住 parse 和 execute，把参数错误与工具异常转换成失败结果。
4. 成功路径保留 content、details 和显式 `isError`；缺省 `isError` 写成 false。
5. 把 signal、progress callback 和不可覆盖的 callId 交给工具。
6. 删除 Lab 6.3 的临时错误，先运行执行器测试，再运行全部聚焦测试。

**运行：**

```bash
npm run build -w @pi/course
node --test --test-name-pattern="执行器" \
  packages/pi-course/dist/test/06-*.test.js
node --test packages/pi-course/dist/test/06-*.test.js
```

**领域输出：** 合法 echo 返回 `content: [text("Pi")]`；参数错误和未知工具不进入
execute；工具抛错后仍返回同 id/name 的错误消息。

**测试证据：** 局部测试应为 `2/2`，完整聚焦测试应为 `4/4`。测试还比较 signal、
progress、details、显式领域错误和有限 timestamp。
:::

## 四种结果放在一起看

沿着同一条执行顺序，可以定位每种结果第一次分开的地方：

| 输入变化 | lookup | parse | execute | 结果 |
|---|---:|---:|---:|---|
| 合法 echo | 找到 | 成功并过滤字段 | 运行 | `isError=false` |
| `value: 1` | 找到 | 失败 | 不运行 | echo 的配对错误 |
| `name: missing` | 未找到 | 不运行 | 不运行 | missing 的配对错误 |
| echo 抛出 `exploded` | 找到 | 成功 | 进入后抛错 | echo 的配对错误 |

`failedResult()` 让后三行拥有相同消息外壳。失败阶段不同，原调用的 id 与 name 始终
保留。下一轮模型既能看到动作失败，也能知道失败属于哪次请求。

:::note title="四项测试覆盖到哪里"
聚焦测试覆盖 validator、Registry、成功执行、未知工具、参数错误、工具异常和显式
领域错误。它们证明 signal 与 progress callback 会传到工具，没有证明工具会及时响应
取消，也没有规定多个工具的并发顺序。测试没有覆盖 Registry 的跨运行生命周期、预取消
或完整脱敏策略。
:::

:::pi title="与当前上游 Pi 对照"
固定提交 `8479bd8` 中，`packages/agent/src/types.ts` 的 `AgentTool` 同样组合 schema、
execute、signal、进度回调、模型 content 和结构化 details。
`packages/agent/src/agent-loop.ts` 在执行前验证参数，并把工具异常转换成错误结果。上游
使用 `typebox`，还支持 UI label、增量更新、hooks 和更多执行模式。课程用小型 validator
展示同一条 `lookup → parse → execute → result` 路径。
:::

## 完成正常实现后再检查执行顺序

临时把 schema 验证移到 `execute()` 之后：

```text
错误顺序：lookup → execute(raw arguments) → parse
```

当 echo 收到 `{ value: 1 }` 时，工具已经开始运行，后面的 parse 无法撤销副作用。聚焦
测试中的 `executionCount` 会从 1 变成 2，第一处偏差出现在执行次数，而非错误文本。

:::failure title="诊断 · 非法参数先进入了工具"
只改变 parse 与 execute 的先后，不修改测试。运行名称含“执行器”的两项测试，记录
`executionCount` 的差异。恢复 `parse → execute` 后，非法参数不再进入工具，局部测试
回到 `2/2`。
:::

## 本章验收

:::checkpoint title="Checkpoint 06 · echo 调用得到完整配对结果"
运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/06-*.test.js
```

结果应为 `4/4`。测试之外，再用开头的 `echoCall` 说明六个值：

1. Provider 从 `definitions()` 看到了哪些字段；
2. `parse()` 收到什么，交给 `execute()` 的对象又是什么；
3. Registry 怎样限定这次运行可查找的工具名；
4. 参数错误为什么不会增加 execution count；
5. content 与 details 分别交给谁使用；
6. 成功、未知工具、参数错误与工具异常为什么都保留原 id/name。

`npm run checkpoint -w @pi/course -- 06` 可以重新定位 parent 与 target；
`npm run practice -w @pi/course -- 06 <新目录>` 会从同一 parent 创建隔离练习目录。
第 07 章会把这个单次 executor 接入 Agent Loop，闭合
`model → tool call → tool result → model`。
:::

## 可选迁移练习

:::transfer title="迁移 · 注册 uppercase 工具"
创建 `uppercase({ value: string })`，复用 `stringValue` 与 `objectSchema()`。合法调用
返回大写 content，并在 details 中记录 `{ source: "uppercase" }`；`value: 1` 在
execute 前形成同 id/name 的错误结果。只新增 Tool 和测试，不修改 Registry 或
executor。
:::

## 小结

一条 `echoCall` 先用 name 在 Registry 中找到工具。schema 的 `jsonSchema` 描述模型
应该生成的参数，`parse()` 检查实际 arguments，并过滤未声明字段。executor 只把解析
成功的新对象交给 `execute()`。

工具返回的 content 会进入下一轮模型上下文，details 留给程序使用。成功、参数错误、
未知工具和工具异常都变成 `ToolResultMessage`，并继续使用原调用的 id 与 name。下一章
会把这些配对结果按顺序写回完整反馈回路。
