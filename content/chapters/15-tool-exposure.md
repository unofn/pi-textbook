---
id: "15"
slug: tool-exposure
part: advanced
partTitle: 第五部 · Pi 1.0 进阶
chapter: "15"
title: 工具暴露：谁能看见、谁能调用
summary: 用同一张注册表推导声明集合与可调用集合，把工具变化写成 transcript 里的 toolsAdded / toolsRemoved 补丁，再让 tool_search 在运行中按需激活工具。
minutes: 130
difficulty: 进阶
artifact: packages/pi-course/src/tool-search.ts
prerequisites: 03,06,07,13
terms: tool exposure, declared set, callable set, toolsAdded, toolsRemoved, tool_search
upstream: packages/agent/src/agent-loop.ts, packages/ai/src/utils/transcript.ts, packages/coding-agent/src/core/agent-session.ts, packages/coding-agent/src/core/extensions/types.ts, packages/coding-agent/src/extensions/tool-search/tool.ts
---

## 第 14 章的 Runtime 把整张注册表交给了模型

第 14 章结束时，`createRuntime()` 接收一个 `ToolRegistry`，Agent loop 在每次请求前调用
`options.tools.definitions()`，把注册表里的每个工具都放进请求的 `tools` 字段。第 07 章
起这条规则没有变过：注册了什么，模型就看见什么；模型看见什么，就能调用什么。

工具只有 `read`、`write`、`edit`、`bash` 四个时，这条规则很合适。现在设想注册表里多了
一个来自 GitHub 服务器的工具 `mcp_github_issues`。第 17 章接入 MCP 后，一台服务器就可能
带来几十个这样的工具。把它们全部写进每次请求，会占掉上下文，也让模型在一长串名字里挑选。
更好的做法是：先让模型只看见少数几个工具，需要时再按关键词把相关工具找出来。

这一章给每个工具加一个 `exposure` 字段，并固定一次运行作为全章的地图。注册表里有三个
工具：

```text
read                 direct        read tool
mcp_github_issues    deferred      List issues of a GitHub repository
tool_search          model-only    按关键词激活尚未声明的工具
```

用户说 “list my issues”。模型第一次就同时调用了 `mcp_github_issues` 和 `tool_search`，
第二次才真正拿到 issue。loop 结束后的 transcript 是：

```text
0  user        list my issues
1  system      toolsAdded: read, tool_search             第一次请求前的声明补丁
2  assistant   c1 mcp_github_issues { value: "early" }
               c2 tool_search { query: "github issues" }
3  toolResult  c1 isError  Tool mcp_github_issues failed: 工具未声明给模型
4  toolResult  c2 Loaded 1 tool. … details.loaded = ["mcp_github_issues"]
5  system      toolsAdded: mcp_github_issues             第二次请求前的声明补丁
6  assistant   c3 mcp_github_issues { value: "late" }
7  toolResult  c3 mcp_github_issues:late
8  assistant   done
```

三次请求的 `tools` 字段分别是：

```text
request 0   read, tool_search
request 1   read, mcp_github_issues, tool_search
request 2   read, mcp_github_issues, tool_search
```

这条 trace 里有本章要建立的四件事：

1. 注册表知道 `mcp_github_issues`，但第一次请求没有声明它，所以 `c1` 被拒绝，结果仍与
   `c1` 配对；
2. 两条 system message 记下了“模型从这里开始能看见哪些工具”，重放它们就得到每次请求的
   `tools`；
3. loop 在请求前比较“transcript 已经声明的工具”和“这次要声明的工具”，只在不同时追加补丁；
4. `tool_search` 激活 `mcp_github_issues` 后，下一次请求自动声明它，模型随后才能调用。

第 03 章定义 `SystemMessage` 时只用了 `content` 和 `sections`，把上游的 `toolsAdded` /
`toolsRemoved` 留了下来。本章补上这两个字段。

## 五种 exposure 与两个集合

`exposure` 回答的问题是“谁能接触这个工具”。接触的一方有两种：模型直接发出 tool call，
或者一段脚本在工具内部调用别的工具。第 16 章的 `codemode` 工具就是第二种调用者；本章先把
脚本视角的集合算出来，暂时还没有人用它。

两个集合都从同一张注册表推导：

- **声明集合**：本次请求交给模型的工具，`definitions()` 返回的就是它；
- **可调用集合**：脚本能执行的工具，由 `callable()` 返回。

五个级别与上游 Pi 1.0 同名：

| exposure | 注册时激活 | 进入声明集合 | 进入可调用集合 | 例子 |
|---|---|---|---|---|
| `direct` | 是 | 是 | 是 | `read` |
| `model-only` | 是 | 是 | 否 | `tool_search`、第 16 章的 `codemode` |
| `codemode` | 否 | 激活后 | 是 | 只给脚本用的辅助工具 |
| `deferred` | 否 | 激活后 | 是 | `mcp_github_issues` |
| `hidden` | 永不 | 否 | 否 | 注册了但暂时封住的工具 |

`exposure` 缺省时按 `direct` 处理，所以第 06–14 章注册的工具行为不变。`codemode` 与
`deferred` 在课程里只有一个区别：谁会去激活它们。两者都要等 `activate()` 之后才进入声明
集合，但注册后马上就能被脚本调用。

`model-only` 工具只对模型开放。`tool_search` 改变的是模型下一次能看见什么，脚本调用它没有
意义；`codemode` 本身若能被脚本调用，脚本就能无限嵌套。

## 建立练习起点

在教学历史仓库中生成隔离练习：

```bash
cd <你的工作区>/pi-course
npm run checkpoint -w @pi/course -- 15
npm run practice -w @pi/course -- 15 <新目录>
cd <新目录>
npm install
```

本章修改五个文件：

```text
packages/pi-course/src/tool.ts          exposure、两个集合、调用作用域
packages/pi-course/src/types.ts         toolsAdded / toolsRemoved、currentTools、toolStateChanges
packages/pi-course/src/session.ts       严格 parser 接受两个新字段
packages/pi-course/src/agent-loop.ts    请求前的声明补丁
packages/pi-course/src/tool-search.ts   排序与 tool_search
```

practice 用四份 starter 覆盖 `tool.ts`、`types.ts`、`agent-loop.ts` 与 `tool-search.ts`：
它们保留第 03、06、09 章已有的实现，只把本章的接缝换成明确的 `Lab 15.x … 尚未实现`。
`session.ts` 没有 starter，保持第 14 章的原样；Lab 15.2 的 parser 测试会直接告诉你它还拒绝
新字段。

:::rebuild title="Checkpoint 15 · 从一张注册表推导声明与调用，并把声明写进 transcript"
**模式：** 重建。从第 14 章的完整 Runtime 开始，只增加“声明集合与可调用集合分开”这一种复杂性。

**起终点：** `parent` `9c5c0228dfcb7411c46e0658083844f0e57c6684` 是起点；`target` `6a8eff4e26ed662861fe0199ddca582dcc4ea4ca` 是终点。

**教学文件：** `packages/pi-course/src/tool.ts`、
`packages/pi-course/src/types.ts`、`packages/pi-course/src/session.ts`、
`packages/pi-course/src/agent-loop.ts`、`packages/pi-course/src/tool-search.ts`

**学习脚手架：** `starters/15-tool.ts`、`starters/15-types.ts`、`starters/15-agent-loop.ts`
与 `starters/15-tool-search.ts` 已固定 `ToolExposure`、`ToolCallScope`、`ToolReference`、
`ToolStateChanges` 和 `tool_search` 的公共表面；分词 `tokenize()`、检索文本
`toolSearchDocument()`、`toToolDeclaration()` 与 `declarationsEqual()` 已经给出。

**动手前只需知道：** `direct` 与 `model-only` 注册即激活，`codemode` 与 `deferred` 等
`activate()`，`hidden` 永不激活。声明集合是“已激活且非 hidden”，可调用集合是“全部
`codemode` / `deferred`，加上已激活的 `direct`”。模型调用只认声明集合，脚本调用只认可调用
集合；拒绝时返回与 call 配对的错误结果。

**第一步：** 在 `ToolRegistry.register()` 里按 exposure 维护 `active` 集合，再实现
`exposureOf()`、`usesExposure()`、`activate()`、`isActive()`、`declared()`、`callable()`、
`canCall()` 与 `executeToolCall` 的作用域把门。

**第一次红灯：** fresh starter 可以 build；只运行 Lab 15.1 时，三项都应显示
`Lab 15.1 ToolRegistry.register exposure 尚未实现`。注册表在构造时就调用 `register()`，所以
在 15.1 完成前，其他章节使用注册表的测试也会报同一个错误。

**聚焦测试：** `packages/pi-course/test/15-tool-exposure.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 15`

**练习目录：** `npm run practice -w @pi/course -- 15`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/15-*.test.js`。

**施工顺序：** 两个集合与作用域 `3/3` → transcript 的工具重放与严格 parser `3/3` → loop
的声明补丁 `3/3` → `tool_search` `3/3`。

**通过证据：** 四个 Lab 依次变绿，最后本章 `12/12`；全量课程测试仍然通过，第 07–14 章的
transcript 一条也没有多出来。

第一次尝试先不看 target diff。卡住时只对照当前 Lab 的测试名和第一个不同的值。
:::

验证起点：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 15.1" \
  packages/pi-course/dist/test/15-*.test.js
```

正确结果是 `0/3`，错误文字都是 `Lab 15.1 ToolRegistry.register exposure 尚未实现`。

## Lab 15.1：同一张注册表推导两个集合

先用一张五行注册表把规则固定下来：

```ts
const registry = new ToolRegistry([
  probe("read"),                      // direct
  probe("tool_search", "model-only"),
  probe("script_only", "codemode"),
  probe("mcp_issue", "deferred"),
  probe("secret", "hidden"),
]);
```

注册表多了一个私有的 `active` 集合。`register()` 在原有的重名检查之后，按 exposure 决定
是否立刻激活：

```ts
this.tools.set(tool.name, tool as Tool<unknown, unknown>);
const exposure = tool.exposure ?? "direct";
if (exposure === "direct" || exposure === "model-only") {
  this.active.add(tool.name);
}
```

两个集合都按注册顺序从 `list()` 过滤出来，不另存一份副本：

```ts
declared(): Tool<unknown, unknown>[] {
  return this.list().filter(
    (tool) => this.active.has(tool.name) && tool.exposure !== "hidden",
  );
}

callable(): Tool<unknown, unknown>[] {
  return this.list().filter((tool) => {
    const exposure = tool.exposure ?? "direct";
    return (
      exposure === "codemode" ||
      exposure === "deferred" ||
      (exposure === "direct" && this.active.has(tool.name))
    );
  });
}
```

对上面的注册表，两个集合是：

```text
declared()    read, tool_search
callable()    read, script_only, mcp_issue
```

`definitions()` 原本把 `list()` 全部映射成 `ToolDefinition`，starter 已把它改成只映射 `declared()`。
loop 仍然在请求前调用 `definitions()`，所以第 07 章的 loop 不用改一行，模型就只看见声明
集合了。全部是 `direct` 的注册表里，`declared()` 和 `list()` 相同，`usesExposure()` 返回
`false`，第 06–14 章的行为原样保留。

`activate(names)` 只做一件事：把未激活的 `codemode` / `deferred` 名字加进 `active`，返回
这一次真正新激活的名字。未知名字和 `hidden` 被跳过，已经激活的名字不再出现在返回值里：

```text
activate(["mcp_issue", "secret", "missing", "read"])  → ["mcp_issue"]
activate(["mcp_issue"])                               → []
activate(["script_only"])                             → ["script_only"]
definitions()                                         → read, script_only, mcp_issue
```

最后一行仍按注册顺序排列，与激活顺序无关。

### 调用方作用域

`executeToolCall` 多了第四个参数 `scope`，缺省是 `"model"`。loop 不传这个参数，所以模型
发出的每个 call 都按声明集合检查；第 16 章的脚本桥会显式传 `"script"`。检查发生在找到
工具之后、解析参数之前：

```ts
const tool = registry.get(call.name);
if (!tool) return failedResult(call, new Error("未知工具"));
if (!registry.canCall(call.name, scope)) {
  return failedResult(
    call,
    new Error(
      scope === "model"
        ? "工具未声明给模型"
        : "工具不在脚本的可调用集合里",
    ),
  );
}
```

`canCall(name, scope)` 在 `"model"` 时查 `declared()`，在 `"script"` 时查 `callable()`。被拒绝
的调用和未知工具走同一个 `failedResult()`：`toolCallId` 与 `toolName` 来自原 call，`isError`
为 `true`，工具的 `execute()` 一次也没有运行。transcript 里每个 call 仍有配对结果，第 06 章
的契约没有被打破。

同一个 `deferred` 工具，从两个方向调用会得到不同结果：

```text
model  → mcp_issue    Tool mcp_issue failed: 工具未声明给模型       runs = 0
script → mcp_issue    mcp_issue:x                                runs = 1
script → tool_search  Tool tool_search failed: 工具不在脚本的可调用集合里
model / script → secret  两边都拒绝
activate(["mcp_issue"]) 之后，model → mcp_issue 成功
```

:::lab title="实践 15.1 · 实现 exposure 与两个集合"
**目标：** 让同一张注册表给出声明集合与可调用集合，并让 `executeToolCall` 按调用方作用域
把门。

**文件：** `packages/pi-course/src/tool.ts`

**动作：**
1. 在 `register()` 里按 exposure 维护 `active`；
2. 实现 `exposureOf()`（未知名字返回 `undefined`）、`usesExposure()`、`activate()`、
   `isActive()`；
3. 按注册顺序实现 `declared()`、`callable()` 与 `canCall()`；
4. 实现 starter 里的 `scopeDenial()`，让 `executeToolCall` 在未知工具检查之后、参数解析之前
   返回配对的错误结果。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 15.1" packages/pi-course/dist/test/15-*.test.js`。

**预期：** `3/3`。三项分别证明：两个集合从同一张表推导、`hidden` 两边都不进；`activate`
只接受 `codemode` / `deferred` 并保持注册顺序；模型与脚本两种作用域的拒绝结果都与原 call
配对，工具没有运行。
:::

## Lab 15.2：让 transcript 记住模型看见了哪些工具

注册表知道“现在”声明了什么。会话恢复、上下文压缩、跨进程重放时，还需要知道“当时”模型
看见了什么。第 03 章已经用 system message 记录 prompt 的变化；工具声明用同样的办法，加在
同一种消息上：

```ts
export interface SystemMessage {
  role: "system";
  content: string;
  sections?: Record<string, string | null>;
  /** 从这一点开始对模型可见的工具的完整定义。 */
  toolsAdded?: ToolDefinition[];
  /** 从这一点开始不再对模型可见的工具。 */
  toolsRemoved?: ToolReference[];
  timestamp: number;
}

export interface ToolReference {
  name: string;
}
```

`toolsAdded` 写完整定义，因为模型要看到名字、描述和参数 schema；`toolsRemoved` 只需要名字。

### 按顺序重放

`currentTools(messages)` 与第 03 章的 `currentSystemMessage()` 是同一种重放：从头到尾读
system message，每条消息内部先删后加。

```ts
const tools = new Map<string, ToolDefinition>();
for (const message of messages) {
  if (message.role !== "system") continue;
  for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  for (const tool of message.toolsAdded ?? []) {
    tools.set(tool.name, toToolDeclaration(tool));
  }
}
return [...tools.values()];
```

测试用三条 system message 演示一次重新定义：

```text
system  BASE        toolsAdded: alpha, beta                 → alpha, beta
user    hi
system  ""          toolsRemoved: alpha; toolsAdded: gamma  → beta, gamma
assistant ok
system  ""          toolsRemoved: beta;  toolsAdded: beta v2 → gamma, beta v2
```

最后一条消息先删 `beta` 再加新的 `beta`，`Map` 把它放到末尾，所以结果是
`[gamma, betaV2]`。“删除再声明”就是 transcript 表达“定义变了”的方式。

`toToolDeclaration()` 只保留 `name`、`description`、`parameters` 三个字段，并对 `parameters`
做一次 JSON 往返。修改 `currentTools()` 的返回值，不会改到 transcript 里的原对象。

### 比较两个完整集合

loop 需要的是差异：transcript 重放出一个集合，注册表给出另一个集合，补丁要写什么？

```ts
export function toolStateChanges(
  previous: readonly ToolDefinition[],
  current: readonly ToolDefinition[],
): ToolStateChanges
```

规则只有两条：

- `current` 中新出现或定义变化的工具进 `toolsAdded`（按 `current` 的顺序）；
- `previous` 中消失或定义变化的工具进 `toolsRemoved`（按 `previous` 的顺序）。

```text
previous  alpha, beta
current   beta v2, gamma
→ toolsAdded   [beta v2, gamma]
  toolsRemoved [alpha, beta]
```

“定义相同”由 `declarationsEqual()` 判断：两边都经过 `toToolDeclaration()` 后比较 JSON 文本。
顶层字段顺序不同的同一个声明不算变化。两个集合相同时，两边都是空数组。

### 严格 parser

第 10 章的 `parseSessionEntry()` 对 system message 使用 `exactKeys()`，未知字段一律拒绝。
在 parent 上解析一条带 `toolsAdded` 的合法 entry，会得到 `… 包含未知字段 toolsAdded`。

`systemMessageAt()` 要把两个字段加进允许列表，再分别检查形状：

```text
toolsAdded     非空 array；每项恰好有 name / description / parameters
               name 是非空 string，description 是 string
               parameters 是 JSON object（null、array、string 都拒绝）
toolsRemoved   非空 array；每项恰好只有 name，且 name 是非空 string
```

空数组也拒绝。loop 生成补丁时会省略空的一边，所以合法 transcript 里不会出现
`toolsAdded: []`；出现了就说明文件被别的程序改过。

这项测试的七个非法样例在 parent 上已经会抛错（错误文字恰好提到字段名），真正的第一次偏差
是那条合法 entry 被拒绝。

:::lab title="实践 15.2 · 重放、比较与解析工具声明"
**目标：** 让 transcript 可以记录并重放工具集合，loop 有现成的差异函数可用，session 文件能
保存这些记录。

**文件：** `packages/pi-course/src/types.ts`、`packages/pi-course/src/session.ts`

**动作：**
1. 实现 `currentTools()`：按顺序重放，每条消息先删后加，返回值与 transcript 不共享引用；
2. 实现 `toolStateChanges()`：新增或变化进 `toolsAdded`，消失或变化进 `toolsRemoved`；
3. 在 `systemMessageAt()` 的允许字段里加入两个新字段，并为它们写形状检查。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 15.2" packages/pi-course/dist/test/15-*.test.js`。

**预期：** `3/3`。三项分别证明：重放先删后加且结果是独立副本；定义变化表示为先删后加，
无差异时两边为空；合法 entry 往返后深等但不共享数组，七种非法形状都被拒绝。
:::

## Lab 15.3：loop 在请求前写声明补丁

有了重放和比较，loop 只需要在每次请求前做一次对照：

```ts
function declareToolChanges(
  messages: readonly AgentMessage[],
  registry: ToolRegistry,
): SystemMessage | undefined {
  if (!registry.usesExposure() && !declaresTools(messages)) return undefined;
  const changes = toolStateChanges(
    currentTools(messages),
    registry.definitions(),
  );
  if (
    changes.toolsAdded.length === 0 &&
    changes.toolsRemoved.length === 0
  ) {
    return undefined;
  }
  return {
    role: "system",
    content: "",
    ...(changes.toolsAdded.length > 0
      ? { toolsAdded: changes.toolsAdded }
      : {}),
    ...(changes.toolsRemoved.length > 0
      ? { toolsRemoved: changes.toolsRemoved }
      : {}),
    timestamp: Date.now(),
  };
}
```

补丁的 `content` 是空串，所以重放出的 prompt 文本不变；空的一边直接省略字段，与 Lab 15.2
的严格 parser 对上。`declaresTools(messages)` 已经在 starter 里给出：transcript 中只要有一条
system message 带非空的 `toolsAdded` 或 `toolsRemoved`，它就返回 `true`。

调用点在循环每一步的开头，紧挨着请求：

```ts
const declaration = declareToolChanges(messages, options.tools);
if (declaration) messages.push(declaration);
const stream = options.model.stream(
  { messages, tools: options.tools.definitions() },
  { signal: options.signal },
);
```

请求的 `tools` 字段仍由 `definitions()` 给出，第 05 章的 provider adapter 照旧从这里读工具。
补丁写进 transcript 的，是同一个集合的记录。测试对每次请求都检查
`currentTools(request.messages)` 与 `request.tools` 一致：模型读到的 transcript 与它收到的工具
清单说的是同一件事。

### 第一行判断为什么存在

第一行让“全 direct 且 transcript 从未声明过工具”的运行完全跳过补丁。没有这一行，第 07 章
最简单的工具往返也会在用户消息之后多出一条 system message，第 07–14 章所有检查 transcript
形状的测试都要改写。课程选择保持那些 transcript 一字不变：

```text
全 direct，transcript 没有声明         → 不比较，不写补丁
注册表用上了非 direct 的 exposure      → 比较，有差异才写
恢复的 transcript 已经声明过工具       → 比较，有差异才写
```

一旦某个条件成立，比较就一直进行下去：transcript 里有了声明，之后每次请求都要和它对齐。

### 补丁放在哪里

loop 收到的 `context.messages` 已经包含本轮的用户消息，loop 只能在末尾追加。所以第一次
请求前，补丁排在用户消息之后；后续请求前，它排在上一批工具结果之后。无论哪种情况，
补丁都紧贴即将发出的请求，已有的消息一条也不移动。

### 三个场景

全 direct 的注册表跑一次工具往返，transcript 与第 07 章相同：

```text
user → assistant(call echo) → toolResult → assistant
request 0 tools: echo；currentTools(request 1 messages) = []
```

注册表里加入一个 `deferred` 和一个 `hidden` 工具后，第一次请求前多出一条补丁；第二次请求
时集合没有变化，就不再追加：

```text
user → system(toolsAdded: echo) → assistant(call echo) → toolResult → assistant
两次请求的 tools 都是 echo
```

恢复的 transcript 声明过注册表里已经没有的 `ghost`。注册表全是 `direct`，但第二个条件成立，
loop 仍然比较，补丁只写删除：

```text
system  BASE  toolsAdded: echo, ghost      恢复的前缀，原样保留
user    go
system  ""    toolsRemoved: ghost          新补丁，没有 toolsAdded 字段
assistant done
```

`result.messages[0]` 与恢复前的对象深等。工具集合的每次变化都是末尾新增的一条消息，与第 13 章
的 prompt 段落补丁是同一个规则。

:::lab title="实践 15.3 · 在请求前追加声明补丁"
**目标：** 让 transcript 重放出的工具集合在每次请求时都等于请求的 `tools`，同时不改变第 07–14
章的 transcript。

**文件：** `packages/pi-course/src/agent-loop.ts`

**动作：**
1. 实现 `declareToolChanges()`：先判断是否需要比较，再用 `currentTools()` 与
   `registry.definitions()` 求差异，无差异返回 `undefined`；
2. 生成 `content: ""` 的补丁，空的一边省略字段；
3. 确认调用点在每一步开头、`model.stream()` 之前。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 15.3" packages/pi-course/dist/test/15-*.test.js`。

**预期：** `3/3`。三项分别证明：全 direct 时 transcript 与第 07 章一致；用上 exposure 后第一次
请求前在用户消息之后追加补丁、无变化不再追加，且每次请求的 `tools` 都等于重放结果；恢复的
声明多出注册表没有的工具时只写 `toolsRemoved`，已有前缀不变。
:::

## Lab 15.4：tool_search 把 deferred 工具带进下一次请求

声明集合可以变化了，还缺一个改变它的入口。`tool_search` 是一个 `model-only` 工具：模型给出
关键词，它在尚未声明的 `codemode` / `deferred` 工具里排序，激活命中的工具。下一次请求前，
Lab 15.3 的补丁自动把它们声明出来。

### 词项与检索文本

starter 已经给出两个辅助函数。`tokenize()` 在 camelCase 边界和非字母数字处切分，转小写，
去掉停用词，再做朴素的单数化：

```text
tokenize("Search Jira issues for the repo")   → search, jira, issue, repo
tokenize("listPullRequests from GitHub")      → list, pull, request, git, hub
```

第二行里 `GitHub` 在大小写边界被切成 `git`、`hub`；工具名 `mcp_github_issues` 按下划线切分，
`github` 仍是一个词项。

`toolSearchDocument(tool)` 把工具名、把 `_` 换成空格的工具名、描述，以及 schema 里的描述和
属性名拼成一段检索文本。`mcp_github_issues` 的文本里因此有 `mcp github issues`。

### 排序只数重叠

`rankTools(query, documents, limit)` 的规则写在 starter 注释里：

```ts
const queryTerms = [...new Set(tokenize(query))];
if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) {
  return [];
}
const matches: ToolSearchMatch[] = [];
for (const document of documents) {
  const terms = new Set(tokenize(document.text));
  const score = queryTerms.filter((term) => terms.has(term)).length;
  if (score > 0) matches.push({ name: document.name, score });
}
return matches
  .sort((left, right) => right.score - left.score)
  .slice(0, limit);
```

`Array.prototype.sort` 是稳定排序，同分的文档保持原来的顺序。查询 `github issues` 得到两个
词项 `github`、`issue`：

```text
mcp_github_issues   github + issue   2
mcp_github_pulls    github           1
mcp_jira_issues     issue            1
weather             —                不入选
```

只由停用词组成的查询，比如 `the and of`，分词后为空，直接返回空数组。

### tool_search 的执行

`createToolSearchTool(registry, options)` 返回的工具已经固定了名字、描述、schema 和
`exposure: "model-only"`。描述里刻意不列出可搜索的工具；第 17 章的 MCP 服务器连上后注册
新工具，`tool_search` 自己的声明也不会变，就不会触发一次重新声明。

`execute()` 的顺序是：

```text
query.trim() 为空            → 抛错 "query 不能为空"（executeToolCall 把它变成配对错误结果）
候选 = list() 中 codemode / deferred 且尚未激活的工具
matches = rankTools(query, 候选的检索文本, limit ?? 默认 8)
loaded = registry.activate(matches 的名字)
返回 content: Loaded N tools. … / No matching tools found.
     details: { loaded }
```

已经声明的工具和 `hidden` 工具不在候选里。同一个查询第二次执行时，命中的工具都已激活，
`loaded` 为空，文本是 `No matching tools found.`。

### 回到开篇的那次运行

现在可以解释开篇 trace 的每一行。第一次请求前，注册表用上了 exposure，transcript 里还没有
声明，loop 追加 `toolsAdded: read, tool_search`。

:::predict title="同一条 assistant 里的两个 call"
模型第一次回复同时包含 `c1 mcp_github_issues` 和 `c2 tool_search`。`c2` 会激活
`mcp_github_issues`。那么 `c1` 会成功吗？`mcp_github_issues.runs` 最后是几？
---answer
`c1` 失败，`runs` 最后是 1。loop 按 call 顺序为每个 call 启动执行，`executeToolCall` 在第一个
`await` 之前就完成了作用域检查；`c1` 检查时 `c2` 还没开始执行，`mcp_github_issues` 仍未声明。
`c2` 随后激活它，但这一批工具结果已经确定。下一次请求前，loop 发现声明集合多了
`mcp_github_issues`，追加第二条补丁；模型在第三次回复里调用 `c3`，这才第一次真正运行它。
:::

第二次请求的 `tools` 按注册顺序是 `read, mcp_github_issues, tool_search`，与
`currentTools()` 重放出的集合名字相同。第三次请求前没有变化，loop 不再追加。

:::lab title="实践 15.4 · 实现排序与 tool_search"
**目标：** 让模型在运行中按关键词激活工具，并经 loop 的声明补丁在下一次请求拿到它们。

**文件：** `packages/pi-course/src/tool-search.ts`

**动作：**
1. 实现 `rankTools()`：查询词项去重，数重叠个数，0 分不入选，按分数降序、同分保持文档
   顺序，最后截断到 `limit`；
2. 实现 `tool_search` 的 `execute()`：空查询抛错，只搜索未激活的 `codemode` / `deferred`
   工具，用 `registry.activate()` 激活命中者，返回文字摘要和 `details.loaded`。

**运行：** `npm run build -w @pi/course`，然后运行
`node --test --test-name-pattern="Lab 15.4" packages/pi-course/dist/test/15-*.test.js`。

**预期：** `3/3`。三项分别证明：排序忽略停用词与大小写、同分保持顺序、无重叠不入选；
`tool_search` 激活命中的 `codemode` / `deferred` 工具，忽略已声明与 `hidden`，遵守 `limit`，
空查询返回错误结果；经 loop 时搜索前的调用被拒绝，搜索后的下一次请求声明它，模型随后调用
成功。
:::

## 十二项测试固定了哪些边界

| Lab | 数量 | 可观察事实 |
|---|---:|---|
| 15.1 | 3 | 两个集合、`activate` 的过滤与顺序、按作用域拒绝且结果配对 |
| 15.2 | 3 | 先删后加的重放、定义变化的差异、严格 parser |
| 15.3 | 3 | 全 direct 不写补丁、补丁位置与去重、恢复后只写删除 |
| 15.4 | 3 | 词项重叠排序、`tool_search` 激活、经 loop 的完整往返 |

全章运行：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/15-*.test.js
```

再运行全部课程测试，确认第 07–14 章没有多出 system message：

```bash
node --test packages/pi-course/dist/test/*.test.js
```

## 课程工具暴露与真实 Pi 的关系

:::pi title="与上游 Pi v1.0.0 对照"
**五个级别与两个集合。** 上游的 `ToolExposure`（`packages/coding-agent/src/core/extensions/types.ts:509`）
同样是五个值，`:494-508` 的注释与本章的表格一致：`direct` 与 `model-only` 注册即激活，其余
不激活；激活集合就是声明给模型的集合。`AgentSession._getCallableTools()`
（`packages/coding-agent/src/core/agent-session.ts:1515-1520`）的过滤条件与课程 `callable()`
相同，`_applyToolLoadout()`（`:1528`）从激活名单里去掉 `hidden` 得到声明集合。上游还有
`defaultActive`（`types.ts:603-608`）和 `setActiveTools()`，可以停用一个 `direct` 工具；
课程没有停用操作，所以 `direct` 工具始终可调用。

**模型调用未声明的工具。** 上游 loop 只在 `currentContext.tools`（声明集合）里查找工具，
找不到就返回 `Tool … not found`（`packages/agent/src/agent-loop.ts:714-720`）。课程的注册表
仍然认得这个名字，`executeToolCall` 按作用域给出“工具未声明给模型”。两边都返回与 call
配对的错误结果。

**transcript 里的声明。** `SystemMessage.toolsAdded` / `toolsRemoved` 的定义见
`packages/ai/src/types.ts:522-538`，`ToolReference` 在 `:722`。重放函数
`getCurrentTools()`（`packages/ai/src/utils/transcript.ts:58-66`）先删后加，与课程
`currentTools()` 相同；上游直接保存原对象，课程多做一次 JSON 往返以免共享引用。
`toToolDeclaration()`（`:123`）、`declarationsEqual()`（`:140`）与 `getToolStateChanges()`
（`:150-167`）对应课程的同名函数，“定义变化 = 先删后加”的规则一致。

**声明补丁。** 上游 `declareToolChanges()`（`agent-loop.ts:333-363`）在 `:110`（初始 prompt）
和 `:211`（每轮待注入消息）调用，并且总是比较。课程简化：只有注册表用上非 direct 的
exposure，或 transcript 已经声明过工具时才比较，这是为了让第 07–14 章的 transcript 保持
不变。补丁位置也不同。上游先看待注入消息里有没有 system message：有就把工具变化并进
那一条（`:353-356`），所以 coding-agent 的段落补丁和工具变化可以是同一条消息；没有才新建
一条，插在第一条非 system 待注入消息之前（`:359-362`），也就是本轮用户消息之前。课程的
loop 拿到的上下文已经含有本轮用户消息，只能在已有消息之后、请求之前追加。上游
`withToolChanges()`（`:367-368`）同样省略空列表；课程 parser 进一步拒绝空列表，属于课程
主动强化。

**provider 从哪里读工具。** 上游 provider 从重放后的 transcript 取工具，例如
`packages/ai/src/api/anthropic-messages.ts:1230` 调用 `getCurrentTools()`；支持就地追加工具的
接口还会用 `resolveTranscriptTools()`（`transcript.ts:226`）把后加入的工具挂在对应的 system
message 上。课程简化：第 05 章的 adapter 不变，仍读请求的 `tools` 字段；测试逐次检查两者
相同。

**tool_search。** 上游实现在 `packages/coding-agent/src/extensions/tool-search/tool.ts`：
候选是“可搜索且未激活”的工具（`:192-214`），描述不列出可搜索工具（`:220`），工具本身是
`model-only`（`:232`），空查询报错（`:234`）。排序用 `Bm25Ranker`（`:119`，`k1 = 1.2`、
`b = 0.75`），同分保持文档顺序。课程简化：排序只数词项重叠，分词与检索文本的思路相同。
:::

## 本章验收

本章验收不只是一行 `pass`。用开篇那次运行复述：

1. 五种 exposure 各自进不进声明集合、进不进可调用集合；`codemode` 与 `deferred` 在课程里
   差在哪里；
2. 为什么 `definitions()` 改成只映射 `declared()` 后，第 07 章的 loop 不用改就只把声明集合
   交给模型；
3. `c1` 被拒绝时，transcript 里为什么仍有一条与它配对的 `toolResult`；
4. `currentTools()` 怎样从两条补丁重放出第二次请求的工具集合，“删除再声明”表达了什么；
5. `declareToolChanges()` 的第一行判断保护了什么，哪两种情况会让它开始比较；
6. 第一次补丁为什么排在用户消息之后，上游为什么能排在之前；
7. `tool_search` 的描述为什么不列出可搜索的工具。

验收记录可写成：

```text
Lab 15.1: 3/3
Lab 15.2: 3/3
Lab 15.3: 3/3
Lab 15.4: 3/3
chapter total: 12/12
full course: green, chapters 07–14 transcripts unchanged
```

:::checkpoint title="Checkpoint 15 · 模型看见什么，transcript 就记下什么"
**完成状态：** 每个工具带 `exposure`，缺省 `direct`。同一张注册表推导出声明集合
（`definitions()`）与可调用集合（`callable()`）；`executeToolCall` 按 `model` / `script`
作用域把门，拒绝时返回配对的错误结果。

**transcript 状态：** `SystemMessage` 有 `toolsAdded` / `toolsRemoved`，`currentTools()`
按顺序先删后加重放；严格 parser 只接受非空列表与规定字段。loop 在每次请求前比较重放结果
与声明集合，有差异才追加一条 `content: ""` 的补丁；全 direct 且从未声明时不比较。已有前缀
不改写。

**运行中激活：** `tool_search` 是 `model-only` 工具，用词项重叠排序未激活的 `codemode` /
`deferred` 工具，激活命中者；下一次请求的补丁声明它们。

**公开证据：** `3/3 → 3/3 → 3/3 → 3/3`，共 `12/12`；全量课程测试通过。

**恢复：** 回到 parent `9c5c0228dfcb7411c46e0658083844f0e57c6684` 后，注册表里的工具全部
声明给模型，transcript 不记录工具集合，Runtime 仍完整可用。
:::

:::transfer title="迁移练习 · 让一个工具从声明集合里退出"
完成 `12/12` 后，在独立练习文件里给注册表加一个 `deactivate(names)`：只接受已激活的
`codemode` / `deferred` 工具，返回真正被移出声明集合的名字。

用 ScriptedModel 写一个三次请求的例子：第一次 `tool_search` 激活 `mcp_github_issues`，
第二次模型调用它后由测试调用 `deactivate(["mcp_github_issues"])`，第三次请求前 loop 应追加
一条只含 `toolsRemoved` 的补丁，而且每次请求的 `tools` 仍等于 `currentTools()` 的重放结果。
`agent-loop.ts` 不需要为此增加任何分支。
:::

## 小结

开篇那次运行从一张三工具的注册表开始。`read` 与 `tool_search` 注册即声明，
`mcp_github_issues` 只在可调用集合里。模型第一次直接调用它，得到一条配对的错误结果；
`tool_search` 激活它之后，loop 在下一次请求前追加 `toolsAdded: mcp_github_issues`，模型这才
调用成功。

两个集合来自同一张注册表，工具集合的每次变化都作为 system message 追加在 transcript
末尾。重放这些消息，就能得到任何一次请求时模型看见的工具。这与第 13 章的 prompt 段落补丁
是同一条规则：改动只追加，不回头改写。

可调用集合在本章还没有真正的使用者。第 16 章的 `codemode` 工具让模型写一段脚本，脚本里的
`tools.<name>(args)` 以 `script` 作用域走 `executeToolCall`，`deferred` 工具不必先被搜索和
声明，就能在脚本里调用。
