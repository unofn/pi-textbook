---
id: "12"
slug: resources-extensions
part: product
partTitle: 第四部 · 从核心到产品
chapter: "12"
title: 知识按需进入上下文，代码先过信任门
summary: 把项目说明、Skill 和模板接入同一个上下文入口，再用信任检查、原子注册与故障隔离控制可执行扩展。
minutes: 150
difficulty: 核心
artifact: packages/pi-course/src/resources.ts
prerequisites: 06,11
terms: resource catalog, skill activation, prompt template, extension host, trust gate, hook
upstream: packages/coding-agent/src/core/resource-loader.ts
---

## 同一个工作区里四种会影响运行的对象

假设用户在项目里发出一句话：

> 用 review 方法检查 `src/parser.ts`，并把结论记到 review note。

这个任务看起来只有一句话，运行时却会用到四种不同对象。前三种由 roots 发现，
ExtensionSource 则由组成层明确传入。先固定本章一直使用的目录，不再为每个概念换例子：

```text
projectRoot/
  AGENTS.md                         # 项目规则
  skills/review/SKILL.md            # review 的说明和正文
  skills/review/references/checklist.md
  templates/review.md               # Review {{target}} for {{owner}}
  extensions/review-extension.ts    # 示例路径，不由 discoverResources 扫描

userRoot/
  skills/review/SKILL.md            # 同名的用户级 Skill
  templates/review.md               # 同名的用户级模板
```

调用者把 roots 明确写成 `[projectRoot, userRoot]`。因此同名资源由 project 版本胜出。一次
正常运行依次发生这些事：

```text
[projectRoot, userRoot]
  → discoverResources：得到三类文本资源的稳定 catalog，project 的 review 胜出
  → activateSkill("review")：重新读取 canonical source，返回正文和 checklist
  → renderTemplate({ target, owner })：得到一条 UserMessage
  → formatResourceContext：得到一份 systemPrompt
  → Chapter 11 buildContext：把 systemPrompt 与活动历史一起计入预算

composition
  → ExtensionSource(review-extension)
  → isTrusted → import → factory 暂存 review_note 与 hooks → commit
  → before allow → core tool 执行一次 → after 观察 → 返回结果
```

这条 trace 是本章的地图。后面五个 Lab 只是逐段把它变成代码。

四种对象不能装进一个含糊的“插件”概念里：

| 对象 | 发现后 catalog 中有什么 | 何时真正使用 | 结果去向 |
|---|---|---|---|
| `AGENTS.md` | 正文 | 格式化资源上下文时 | `systemPrompt` |
| Template | metadata 和正文 | 用户给出模板参数时 | 一条 `UserMessage` |
| Skill | metadata，不含正文 | 显式 `activateSkill()` 时 | `systemPrompt` |
| Extension | 不进入资源 catalog | trust 通过并 import 后 | Tool Registry 与 hook 链 |

前三种是数据。它们改变模型能看到什么，但不会仅因“被发现”就执行 Node 代码。
Extension 是代码；模块顶层在 import 时就可能运行，所以信任判断必须发生在 import 之前。

课程里的 `discoverResources(roots)` 只扫描前三种文本资源。组成层把
`{ id: "review-extension", path: ... }` 单独交给 `loadExtension()`；真实 Pi 才由更完整的
ResourceLoader 同时汇总资源路径与 Extension 路径。分开这两个入口，是为了让“发现数据”
和“准许代码执行”的先后关系可以独立观察。

本章最终得到六个公开函数：

```ts
discoverResources(roots)
activateSkill(catalog, name, options)
renderTemplate(template, args)
formatResourceContext(catalog, activatedSkills)
createExtensionHost(registry, options)
loadExtension(source, options)
```

先看对象怎样流动，再记术语：catalog 是“已经发现的目录”；activation 是“本轮确定要
读取的知识”；template render 是“输入参数变成用户消息”；extension host 是“获准代码
能注册什么、何时介入工具执行”的边界。

## 它接在第 11 章的哪个位置

第 11 章已经确立唯一的上下文构造器 `buildContext()`。本章不会再发明一套 resource
messages 或另一套 token 裁剪器，只负责准备两个输入：

```text
renderTemplate(...)        ──→ UserMessage ──→ session 活动历史
formatResourceContext(...) ──→ systemPrompt ─→ buildContext(...)
```

模板生成的消息走既有消息与 session 协议；项目规则和 Skill 知识走同一个
`systemPrompt` 字段。于是第 11 章仍能看到一次模型请求的完整预算。

Extension 接在另一边。它复用第 06 章的 `ToolRegistry` 与 `ToolExecutor`，而不是直接
侵入 Agent loop：

```text
ToolCall → extension before hooks → ToolExecutor → extension after hooks → ToolResultMessage
```

第 13 章会把 catalog 的静态资源上下文、扩展后的执行器、session 和 loop 组装成一个
Runtime。本章只把“发现”和“执行前后”各自做成可独立验证的部件。

## 建立练习起点

在教学历史仓库中生成隔离练习。不要修改教材目录，也不要在原始 `pi` 仓库施工：

```bash
cd <你的工作区>/pi-course
npm run checkpoint -w @pi/course -- 12
npm run practice -w @pi/course -- 12 <新目录>
cd <新目录>
npm install
```

练习保留 Chapter 11 的实现，并用无答案 starter 覆盖唯一教学文件：

```text
packages/pi-course/src/resources.ts
```

:::rebuild title="Checkpoint 12 · 沿一条发现链重建资源与扩展"
**模式：** 重建。从第 11 章 target 开始，只增加 `resources.ts`。

**起终点：** `parent` `5fb517c2012d8e6227c0e17ee65e530e18ac13e6` 是起点；`target` `03541892bcd533444af599d1813401f79807de3c` 是终点。

**教学文件：** `packages/pi-course/src/resources.ts`

**学习脚手架：** `starters/12-resources.ts` 已固定 Resource、Extension、hook 的公共类型和
六个导出函数；函数体只有按 Lab 命名的施工位，没有本章答案。

**动手前只需知道：** catalog 先回答“工作区里有什么”，activation 再回答“本轮读取哪份
Skill”；Extension 只有通过 trust gate 后才有机会执行并注册 tool/hook。

**第一步：** 只实现 `discoverResources()`，让 `[projectRoot, userRoot]` 中 project 的
同名资源胜出，并让输出只按逻辑身份稳定排序。

**第一次红灯：** starter 可以 build；只运行 Lab 12.1 时应得到 `0/2`，错误都是
`Lab 12.1 resource catalog 尚未实现`。

**聚焦测试：** `packages/pi-course/test/12-resources-extensions.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 12`

**练习目录：** `npm run practice -w @pi/course -- 12`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/12-*.test.js`。

**施工顺序：** catalog precedence `2/2` → Skill activation `3/3` → template 与 context
`2/2` → trust 与 staging `2/2` → hook 执行语义 `3/3`。

**通过证据：** fresh build 为绿，首红准确，五个 Lab 分别通过，失败注入能被现有测试
杀死并恢复，最后本章 `12/12`。

第一次尝试先不看 target diff。禁止让陪练粘贴完整答案；只比较当前 Lab 的输入、输出和
第一处偏差。
:::

先验证起点：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 12.1" \
  packages/pi-course/dist/test/12-*.test.js
```

看到准确的 `0/2` 后再开始。Build 失败不是预期首红；先检查练习是否从正确 parent 生成。

## Lab 12.1：roots 顺序决定 catalog winner

现在只跟踪一个对象：`skill:review`。

```ts
const catalog = await discoverResources([projectRoot, userRoot]);
```

projectRoot 和 userRoot 都声明了 `skill:review`。逻辑身份由 `kind + name` 构成，因此
`skill:review` 与 `template:review` 可以共存，两个 `skill:review` 才发生冲突。输入数组
已经表达优先级：先出现的 root 获胜。

发现与排序是两个不同动作：

```text
发现阶段：按 roots 输入顺序扫描，第一次见到 kind:name 时记为 winner
排序阶段：winner 已经确定，再按 instructions → skill → template、name 输出
```

不能先按绝对路径排序再选 winner。那会让临时目录名或机器路径替调用者决定优先级。

对固定示例，catalog 的核心结果应类似：

```ts
{
  resources: [
    { kind: "instructions", name: "AGENTS", body: "PROJECT RULES", ... },
    { kind: "skill", name: "review", description: "project review", ... },
    { kind: "template", name: "review", body: "Review {{target}} for {{owner}}", ... },
  ],
  instructions: [/* 上面的 instructions */],
  skills: [/* 上面的 skill */],
  templates: [/* 上面的 template */],
}
```

注意 `skill:review` 没有 `body`。Discovery 会读取 `SKILL.md` 的文件前缀来解析
frontmatter；短文件的正文可能进入临时 buffer，但公开 catalog 只保留 `name` 和
`description`，不会让正文进入本轮 context。目录可以告诉运行时“有 review 能力”，
却没有替本轮请求公开全部方法文本。

同一 root 内若出现两个相同 `kind:name`，roots 顺序无法裁决，直接报错。缺少
`AGENTS.md`、`skills/` 或 `templates/` 只表示该类资源不存在；其他 I/O 或解析错误不能
悄悄吞成空目录。

:::lab title="实践 12.1 · 实现 discoverResources"
只实现 `discoverResources()` 及它直接需要的目录、frontmatter、逻辑身份和排序 helper。
不要碰后四个 Lab。

先写下三个预测：调换 roots 后 winner 是否调换；物理目录名与 frontmatter name 不同时
按哪个排序；`JSON.stringify(catalog)` 是否包含 inactive Skill 正文。

可按下面的控制流施工：

```text
for configuredRoot of roots
  canonicalRoot = realpath(configuredRoot)
  candidates = discoverRoot(canonicalRoot)
  拒绝当前 root 内重复 kind:name
  对每个 candidate：winners 中没有该 key 才写入

resources = winners 按 kind、logical name 排序
返回 resources 及三个分类视图的 structuredClone
```

运行独立聚焦测试：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 12.1" \
  packages/pi-course/dist/test/12-*.test.js
```

通过证据是 `2/2`：调换 roots 会调换 winner；重复运行结果一致；排序看 logical name；
inactive Skill 的 marker 不出现在序列化 catalog 中。

常见的第一处偏差是把 roots 自己排序、只用 name 作为 key，或把完整 Skill 解析结果直接
塞进 catalog。
:::

## Lab 12.2：activation 才把 Skill 正文交给本轮

Catalog 现在已经选定 project 的 `skill:review`，但对象里仍只有 metadata。本轮明确需要
review 时才激活：

```ts
const review = await activateSkill(catalog, "review", {
  resources: ["references/checklist.md"],
});
```

成功后，当前对象才扩展为：

```ts
{
  kind: "skill",
  name: "review",
  description: "project review",
  source: "/canonical/.../skills/review/SKILL.md",
  root: "/canonical/.../skills/review",
  body: "Read the diff first.",
  resources: [{
    request: "references/checklist.md",
    source: "/canonical/.../skills/review/references/checklist.md",
    content: "tests\nsecurity\n",
  }],
}
```

`request` 保留调用者写下的逻辑路径，`source` 记录文件系统解析后的 canonical 路径，
`content` 才是要进入后续上下文的文字。相同 request 出现两次时按 request 去重。

路径边界需要回答两个问题。第一，字符串解析后是否仍在 Skill root 内；第二，跟随
symlink 后的真实文件是否仍在 root 内：

```text
references/checklist.md
  → 拒绝空串和绝对路径
  → path.resolve(skillRoot, request)
  → lexical containment
  → realpath(candidate)
  → canonical containment
  → readFile
```

只检查 `..` 会漏过 symlink；只检查字符串前缀也会把 `/work/review-old` 错认成
`/work/review` 的子路径。用 `path.relative(root, candidate)` 判断 containment：结果不能
是绝对路径，也不能以 `..` 开始。

激活还会重新读取完整 `SKILL.md`。若 frontmatter name 已经不等于 catalog 中的 name，
就拒绝这次激活。成功结果必须是副本；修改 `review.body` 不能反向改变 catalog。

:::lab title="实践 12.2 · 实现 activateSkill"
只实现 `activateSkill()`、`resolveInsideSkill()` 和 containment helper，保留 Lab 12.1 的
结果。

核心顺序是：按 name 找 catalog Skill → `realpath()` 并确认 SKILL.md 位于 canonical
root 内 → 解析完整正文并复核 name → 对去重后的 resource requests 做 lexical 与
canonical 两次 containment → 返回深副本。

运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 12.2" \
  packages/pi-course/dist/test/12-*.test.js
```

`3/3` 证明三组事实：正文只在激活结果中出现且 catalog 不变；安全附加文件返回自己的
canonical source；traversal、绝对路径和指向 root 外的 symlink 都被拒绝。

这层 containment 只约束 Resource loader 读取哪些 Skill 文件，不是操作系统沙箱，也
不能限制后面获准执行的 Extension 自己访问文件。
:::

## Lab 12.3：模板与 Skill 从两个入口汇入一次模型请求

固定模板正文是：

```text
Review {{target}}; then test {{target}} for {{owner}}.
```

唯一占位协议是 `{{name}}`：name 以字母或下划线开头，后面可跟字母、数字或下划线。
同一变量出现两次就替换两次；缺少参数立即报错；多余参数不参与输出。只有符合这个
外形的片段参与替换；`{{ name }}`、`{{1x}}` 等花括号文本按字面保留。

```ts
const message = renderTemplate(template, {
  target: "src/parser.ts",
  owner: "runtime",
  ignored: "extra",
});
```

结果不是裸字符串，而是第 03 章定义的 canonical `UserMessage`：

```ts
{
  role: "user",
  content: [{ type: "text", text: "Review src/parser.ts; then test src/parser.ts for runtime." }],
  timestamp: /* 当前时间 */,
}
```

模板到这里就结束。它不直接调用模型，也不自行写 session。

另一条输入来自已经发现和激活的资源：

```ts
const systemPrompt = formatResourceContext(catalog, [review]);
```

这份字符串包含 instructions 正文、所有 Skill 的 name/description、已激活 Skill 的正文
与显式附加文件。未激活 Skill 的 description 可见，正文不可见。函数还要拒绝重复激活
同名 Skill，以及不属于当前 catalog 的 ActivatedSkill。

现在把两条路径接回第 11 章：先把 `message` 追加为 session 事实，再把
`systemPrompt` 作为已有入口交给 `buildContext()`。

```ts
const projection = buildContext(activePath, {
  maxTokens: 20,
  systemPrompt,
  reservedOutput: 2,
  safetyMargin: 1,
  estimateTokens: () => 1,
});
```

`formatResourceContext()` 不裁剪 token，也不调用 `buildContext()`。它只返回一个字符串；
预算与历史投影仍只有一个负责人。

:::lab title="实践 12.3 · 实现 renderTemplate 与 formatResourceContext"
实现两个函数和必要的字符串 helper。先用固定模板手算完整输出，再写 replace 回调。

资源上下文按这个顺序构造：加入 instructions → 加入全部 Skill metadata → 验证 activated
集合 → 按 name 稳定排列 active Skills → 加入 active body 和 resource files →
`lines.join("\n\n")`。

运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 12.3" \
  packages/pi-course/dist/test/12-*.test.js
```

`2/2` 要同时证明：重复占位符都被替换，缺少 `owner` 报错，结果 role 为 `user`；
systemPrompt 有 instructions、active/inactive metadata 和 active body，没有 inactive body，
并原样进入 `buildContext().systemPrompt`。

若你在这里创建第二套 resource messages 或第二个 token budget，说明职责边界已经偏离。
:::

## Lab 12.4：Extension 先获准，再一次性注册

现在模型已经看见 review 方法，但还没有 `review_note` 工具。固定 Extension 的 factory
只做三件事：注册一个 tool、注册一个 before hook、注册一个 after hook。

```ts
export default function reviewExtension(context: ExtensionContext) {
  context.registerTool(reviewNoteTool);
  context.on("beforeToolCall", () => ({ decision: "allow" }));
  context.on("afterToolResult", () => {
    observed += 1;
  });
}
```

`loadExtension()` 的正常顺序必须能从外部观察：

```text
source { id, path }
  → isTrusted(frozen source)        true
  → importModule(frozen source)     得到 default factory
  → factory(stagingContext)         暂存 review_note 和 hooks
  → commit                          三项一起变为可见
  → { id, status: "active" }
```

为什么不是 factory 一调用 `registerTool()` 就写真实 Registry？因为下一行仍可能抛错。
如果 tool 已写入而 hook 没写入，宿主会留下一个不存在于任何完整 Extension 状态中的半成品。

Staging context 的 `registerTool()` 和 `on()` 只写局部数组。Factory 正常返回后，
`commit()` 先检查 extension id、暂存区内部 tool 重名、与 Registry 现有 tool 重名；所有
检查通过后才写入真实 Registry、hook 列表和 committed extension ids。

公开 `ExtensionHost` 只有：

```ts
interface ExtensionHost {
  wrapExecutor(coreExecutor: ToolExecutor): ToolExecutor;
}
```

`stage()` 是 `loadExtension()` 与 host 实现之间的私有通道，不能为了少写一个 helper 就
暴露给 Extension 作者。课程 target 用私有 `ExtensionHostImpl` 和模块内类型收窄连接：

```ts
interface StagedRegistration {
  context: ExtensionContext;
  commit(): void;
}

class ExtensionHostImpl implements ExtensionHost {
  stage(extensionId: string): StagedRegistration { /* 只写局部暂存区 */ }
  wrapExecutor(core: ToolExecutor): ToolExecutor { /* 公共能力 */ }
}

function hostImplementation(host: ExtensionHost): ExtensionHostImpl {
  if (!(host instanceof ExtensionHostImpl)) throw new Error("host 类型不匹配");
  return host;
}
```

私有 `WeakMap` 也可以。黑盒测试不要求 helper 同名，只要求 Extension 拿不到 staging
权限，而 loader 能在 factory 成功后 commit。

:::lab title="实践 12.4 · 实现 trust gate 与 staging registration"
实现 `createExtensionHost()` 的暂存/提交部分、`loadExtension()` 和 default factory 的运行
时检查。Lab 12.5 尚未实现时，`wrapExecutor(core)` 至少要在无已提交 hook 时调用 core
一次并透传结果；第二项测试会用它确认失败 factory 没有泄漏 hook。

先保持这四条不变量：

```text
untrusted          ⇒ import count = 0
factory throws     ⇒ committed tools/hooks = 0
tool name conflict ⇒ committed tools/hooks = 0
active             ⇒ 全部注册项一次可见
```

运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 12.4" \
  packages/pi-course/dist/test/12-*.test.js
```

`2/2` 的正常证据是 `trust → import → factory → commit`，`review_note` 可从 Registry 取得。
边界证据是 untrusted 只留下 `trust`，以及 factory 抛错或工具重名时 Registry 不变、暂存
hook 调用数为零。

“原子”只指本章的注册可见性：全部 tool/hook 一起出现，或一个也不出现；它不是跨进程
事务，也没有实现 Extension 卸载协议。
:::

## Lab 12.5：一次工具调用怎样穿过 hooks

先只看正常结果，不讨论故障。`review-extension` 已经 commit，core 收到一条
`review_note` 调用：

```text
call { id: "note-1", name: "review_note", arguments: { text: "parser is stable" } }
  → before hook 返回 allow
  → coreExecutor 执行一次
  → result { toolCallId: "note-1", toolName: "review_note", isError: false }
  → after hook 观察一次
  → 调用者得到与 core result 等值的深副本
```

`wrapExecutor()` 的主干因此很短：

```text
复制 sourceCall
  → before(call)
  → 若没有 blocked result，调用一次 core
  → 复制 core result
  → after(result)
  → 再返回一份副本
```

Hook 收到冻结的深副本。它不能修改 `call.arguments` 或 `result.details`，调用者修改返回
对象也不能反向改写 core 保存的原结果。

理解正常主干后，再给三个边界规定语义。

第一，`before` 是策略门。显式 deny 会阻止 core，并返回一条与原 call 的 id/name 配对的
`isError: true` 工具结果。策略抛错或超时表示 host 无法确认动作可继续，也 fail-closed：

```text
before deny          → core 0 次 → paired error result
before throw/timeout → diagnostic → core 0 次 → paired error result
```

Deny 是正常策略决定，reason 已写入 result details，不需要 diagnostic。Throw/timeout 是
Extension 故障，diagnostic 记录 `extensionId/hook/kind/message`。

多个 before 按注册顺序运行，并在第一条阻断结果处短路：

```text
before 1 allow → before 2 deny → 返回 paired blocked result
                  before 3 / core / after 都不再运行
```

Blocked result 是 host 产生的策略结果，不是 core result，因此不会触发 after。只有所有
before 都 allow，core 才执行一次；core 返回以后，after 再按注册顺序逐个观察。

第二，`after` 观察的是已经发生的 core 事实。一个 after 抛错或超时，只写 diagnostic，
然后继续后面的 after；它不能让 core 重跑，也不能替换结果：

```text
after throw/timeout → diagnostic → next after → original core fact
```

第三，timeout 只让 host 停止等待。`Promise.race()` 不能强制终止一个已经开始且不响应
取消的 Promise；不要把这层超时描述成代码沙箱。

:::lab title="实践 12.5 · 实现 wrapExecutor"
实现 timeout helper、paired blocked result、host 的 `before()`、`after()` 与
`wrapExecutor()`。不要修改 Agent loop，也不要让 hook 直接写 session。

逐行守住这些计数：

```text
before unsafe ⇒ coreCalls = 0
core 获准     ⇒ coreCalls = 1
每个 after    ⇒ 每个 core result 至多一次
after failure ⇒ 只增加 diagnostic
```

运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 12.5" \
  packages/pi-course/dist/test/12-*.test.js
```

`3/3` 要看到：deny 保留 call id/name 且 core 为零；before throw/timeout 都 fail-closed 并
产生对应 diagnostic；after success/error/timeout 的组合中 core 仍只执行一次，成功
observer 执行一次，返回值与 core fact 深度相等但不是同一引用。

常见错误是把 before throw 当成 allow、返回普通 `Error` 而丢失 call/result 配对、第一个
after 失败后停止后续 observer，或把 core 原对象直接交给 Extension。
:::

## 把正常链与边界链放在一起

现在可以完整解释开头那次请求：

```text
1. [projectRoot, userRoot] 让 project 的 skill:review、template:review 胜出
2. catalog 公开 review metadata，不公开 Skill 正文
3. activateSkill("review") 读取 project SKILL.md 与 checklist
4. renderTemplate 生成检查 src/parser.ts 的 UserMessage
5. formatResourceContext 生成 systemPrompt，Chapter 11 统一预算
6. review-extension 先 trust，后 import，factory 注册项一次 commit
7. review_note 调用通过 before，core 一次，after 一次，返回配对结果
```

只有在这条正常链已经清楚后，边界才容易定位：

| 输入变化 | 第一处拒绝或降级 | 不应发生的外部事实 |
|---|---|---|
| `../../outside.md`、绝对路径 | lexical containment | 读取 root 外文件 |
| root 内 symlink 指向外部 | canonical containment | 读取 symlink 目标 |
| `isTrusted()` 返回 false | trust gate | import 模块 |
| factory 抛错或 tool 重名 | staging/commit | 留下部分 tool/hook |
| before deny/throw/timeout | before policy | core 执行 |
| after throw/timeout | diagnostic 后继续 | 重跑 core 或替换结果 |

这里的信任策略属于调用者注入的 `isTrusted()`。`loadExtension()` 的测试只证明它返回
`false` 时 import 次数为零；测试没有证明策略本身判断正确、source path 已 canonicalize，
也没有排除 trust 判断之后文件内容又发生变化。

这张表把“安全”拆成可观察事实。测试不是证明系统绝对安全，而是证明每条边界上的顺序与
结果符合本章契约。

## 故意破坏 trust 与 import 的顺序

:::failure title="失败注入 · 让未信任模块发生 import"
五个 Lab 全绿后，在 `loadExtension()` 的 untrusted 分支临时加入：

```ts
if (!trusted) {
  await options.importModule(source); // 故意错误
  return { id: source.id, status: "skipped_untrusted" };
}
```

返回值仍写着 `skipped_untrusted`，但 import spy 已经观察到副作用。运行：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 12.4" \
  packages/pi-course/dist/test/12-*.test.js
```

第一项应失败，调用顺序从 `['trust']` 变成包含 `import`。删掉错误行，再运行 Lab 12.4
与本章全量：

```bash
npm run build -w @pi/course
node --test --test-name-pattern="Lab 12.4" \
  packages/pi-course/dist/test/12-*.test.js
node --test packages/pi-course/dist/test/12-*.test.js
```

恢复到 `2/2` 与 `12/12` 后，这个实验结束；最终 diff 中不包含演示用错误分支。
:::

## 测试证据与验收

本章 12 项测试按五个 Lab 分组：

| Lab | 数量 | 公开观察量 |
|---|---:|---|
| 12.1 | 2 | roots precedence、逻辑身份排序、inactive body 不在 catalog |
| 12.2 | 3 | activation 公开正文、附加文件来源、traversal/absolute/symlink escape |
| 12.3 | 2 | 唯一占位协议、canonical UserMessage、唯一 `buildContext` 接缝 |
| 12.4 | 2 | trust 先于 import、factory/重名失败零残留 |
| 12.5 | 3 | before fail-closed、paired result、after 失败保留 core 事实 |

这 12 项证据停在三个边界：

- Resource containment 在发现和激活时检查路径；它不是操作系统沙箱，检查完成后的文件
  变化仍由调用环境管理。
- `isTrusted()` 由调用者提供。Extension 测试固定的是 `trust → import` 顺序，以及 hook
  timeout 后 host 停止等待；它不判断策略质量，也不终止已经运行的模块代码。
- Staging 保证单次 factory 失败时零残留。卸载、reload 和多个 factory 并发提交需要另
  一套生命周期协议。

本章全量命令是：

```bash
npm run build -w @pi/course
node --test packages/pi-course/dist/test/12-*.test.js
```

再验证没有破坏前十二章：

```bash
node --test packages/pi-course/dist/test/{00,01,02,03,04,05,06,07,08,09,10,11,12}-*.test.js
```

验收记录至少包含：

```text
fresh build: pass
first red: Lab 12.1 0/2, exact scaffold error
Lab 12.1: 2/2
Lab 12.2: 3/3
Lab 12.3: 2/2
Lab 12.4: 2/2
Lab 12.5: 3/3
fault injected: Lab 12.4 detects trust/import order
fault restored: Lab 12.4 2/2
chapter total: 12/12
through Chapter 12: all pass
```

## 课程模型怎样迁移到真实 Pi

:::pi title="Pi 对照 · 课程压缩的是顺序，不是生产接口"
课程用 `discoverResources()`、`activateSkill()`、`formatResourceContext()` 和一个小型
Extension host，把最重要的输入输出压成 12 项黑盒测试。真实 Pi 的对象更丰富，不能按
函数名逐行映射。

在固定上游提交 `8479bd8` 中，`DefaultResourceLoader` 统一暴露
`getExtensions()`、`getSkills()`、`getPrompts()`、`getAgentsFiles()` 与 system prompt
相关读取，并在 `reload()` 中解析启用的资源路径。项目 trust 采用预加载流程：先把项目
设置视为未信任；此时排除 project-local extension，只加载 user/global 与临时 CLI 来源；
随后解析项目是否 trusted，并按最终 trust 状态重载设置与资源。这个实现比课程的单个
`isTrusted(source)` 更完整。

真实 Extension API 也远不止两个 hook：factory 可以 `registerTool()`，并用 `on()` 订阅
`tool_call`、`tool_result`、`resources_discover` 等事件。课程的
`beforeToolCall/afterToolResult` 只保留了最适合练习“策略先于动作、观察晚于事实”的一小
段执行语义。

迁移时保留三条不变量，不复制课程内部 helper：数据资源与可执行代码分开；项目代码在
信任决策前不能被意外加载；扩展故障的处理取决于它发生在动作之前还是事实之后。
:::

## 用固定示例做一次组合迁移

:::transfer title="迁移练习 · 让 review 请求走完整条链"
在 Chapter 12 的练习目录新增
`packages/pi-course/test/12-transfer.test.ts`，复用公开测试里的临时目录 helper，不修改
`resources.ts` API。

仍使用开头的 `[projectRoot, userRoot]`、同名 `skill:review`、`template:review`、
checklist 和 `review-extension`：

1. 断言 project 的 template 与 Skill metadata 胜出；
2. 激活 review，渲染 `src/parser.ts/runtime`，再断言 systemPrompt 只有 project 的
   active body；
3. 加载一个注册 `review_note` 的 trusted Extension，before 只拒绝 text 中含
   `SECRET` 的调用；
4. 执行普通 note 与 secret note，记录 `coreCalls`、结果 id/name 和 `isError`。

先写预期 trace：

```text
project winners
  → activate project review + checklist
  → render UserMessage + format systemPrompt
  → trust → import → factory → commit review_note
  → ordinary note: before allow → core → after
  → secret note: before deny → paired error result
```

验收条件是普通 note 让 `coreCalls === 1`，secret note 不再增加 coreCalls，并仍与自己的
call id/name 配对。失败时只找 trace 中第一处偏差，不给核心实现添加 transfer 专用分支。
:::

:::checkpoint title="Checkpoint 12 · 同一个工作区有一条可解释的发现链"
**完成状态：** Roots 输入顺序决定 `kind+name` winner；inactive Skill 只公开 metadata；
显式 activation 才返回正文与 root 内附加文件；template 生成 canonical UserMessage；资源
文字从唯一 `systemPrompt` 接口进入 Chapter 11 的预算。

**执行状态：** Trusted Extension 按 `trust → import → factory → commit` 生效；staging
失败零残留；before 决定 core 能否运行；after 故障只产生 diagnostic，不改写 core 事实。

**公开证据：** `2/2 → 3/3 → 2/2 → 2/2 → 3/3`，本章共 `12/12`。

**准确边界：** Realpath containment 不是 OS sandbox；hook timeout 不会杀死后台 Promise；
课程 API 不是生产 Pi 的逐行缩写。

**恢复：** 重新生成 Chapter 12 练习即可回到第 11 章 parent 加无答案 starter；只恢复
`packages/pi-course/src/resources.ts`，不要回退 session、context、tool 或 loop。
:::

## 小结

- Catalog 先回答“有什么”，activation 再回答“本轮读什么”。
- Roots 顺序选择 winner；最终排序只稳定输出，不能反过来决定权限。
- Template 生成 `UserMessage`，资源文字生成 `systemPrompt`，两者都回到既有上下文链。
- Extension 是代码：先 trust，再 import；factory 注册先 staging，检查完成后一次 commit。
- Before hook 位于动作之前，拒绝或故障时 fail-closed；after hook 位于事实之后，故障不能
  重写结果。
- 第 13 章会接入 catalog 的静态 metadata 与 ExtensionHost；Skill activation 和 template
  rendering 仍由调用者显式完成。
