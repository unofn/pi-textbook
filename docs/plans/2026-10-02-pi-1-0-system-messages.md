# 课程对齐 Pi 1.0：system 消息模型

日期：2026-10-02
上游参考：`earendil-works/pi` v1.0.0（`a13d35a742c6ef8462812a28fbe1d8c8b7431c32`）
课程分支：`course/build-your-own-pi-1.0`（由 `course/build-your-own-pi` 变基到 v1.0.0 后重写）

## 为什么改

固定提交 `8479bd8` 时，上游把 system prompt 当成每次请求附带的一个字符串：
`AgentContext = { systemPrompt, messages, tools }`。课程沿用了这个形状。

Pi 1.0 改成了“system prompt 是 transcript 的一部分”：

- `Message` 多了 `SystemMessage`（`packages/ai/src/types.ts:522, 610`）。
- 开头那条 system message 是基础 prompt；之后的 system message 只做增量：
  `content` 追加说明，`sections` 按名字替换段落，`null` 删除段落
  （`packages/ai/src/types.ts:512-538`）。
- 按顺序重放所有 system message，就得到当前 prompt
  （`packages/ai/src/utils/transcript.ts:73-105` 的 `getCurrentSystemMessage`、`getCurrentSystemPrompt`）。
- 不支持对话中途 system message 的 provider，由 adapter 把重放结果折叠成一条开头的 system message，
  并丢掉其余 system message（`transcript.ts:108-123` 的 `collapseSystemMessages`、`resolveTranscript`）。
- `AgentContext` 只剩 `messages` 和 `tools`；`AgentState.systemPrompt` 是只读的重放结果
  （`packages/agent/src/types.ts:389`）。`Agent` 的初始 `systemPrompt` 会变成开头的 system message，
  除非 `messages` 已经以 system message 开头（`packages/agent/src/agent.ts:77-90`）。
- 产品层改 prompt 时不重写历史：coding-agent 算出段落差异，把补丁作为新的 system message
  插在本轮用户消息之前（`packages/coding-agent/src/core/agent-session.ts:1689-1706, 2060`，
  `core/system-prompt.ts:198-213`）。前缀不变，provider 的 prompt cache 一直能命中。
- 会话文件没有新的 entry 类型：system message 就是普通 `message` entry
  （`packages/coding-agent/src/core/session-manager.ts:183-194`）。
- 压缩时 system message 不进入摘要（`packages/coding-agent/src/core/compaction/compaction.ts:101`），
  compaction entry 另存一份边界处的完整 system 状态（`session-manager.ts:103`）。

课程的目标是让学习者建立和 1.0 一致的心智模型，同时保持每章只增加一种复杂性。

## 课程版契约

### 类型（第 03 章，`src/types.ts`）

```ts
export interface SystemMessage {
  role: "system";
  /** 开头一条：基础 prompt；之后：追加的说明。可以为空字符串。 */
  content: string;
  /** 具名段落。之后的 system message 按名字替换，null 表示删除。 */
  sections?: Record<string, string | null>;
  timestamp: number;
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface AgentContext {
  messages: AgentMessage[];
  tools?: ToolDefinition[];
}
```

同一文件里提供三个纯函数，名字与上游对应：

- `currentSystemMessage(messages): SystemMessage | undefined` —— 按顺序重放：
  非空 `content` 依次追加（`\n\n` 连接），`sections` 按名字覆盖，`null` 删除；
  没有任何 system message 时返回 `undefined`。时间戳取第一条 system message。
- `systemMessageText(message): string` —— `content` 后接各段落正文，空串跳过，`\n\n` 连接。
- `currentSystemPrompt(messages): string | undefined` —— 前两者的组合；没有 system message 时为 `undefined`。

`StopReason` 保持五个值。上游 1.0 的 `pending`、`deferred` 属于延迟请求，课程不涉及，
只在 `:::pi` 中说明。

### Provider 边界（第 05 章，`src/provider-adapter.ts`）

`toProviderMessages(context)`：

1. `currentSystemPrompt(context.messages)` 非空时，输出一条开头的 `{ role: "system", content }`；
2. 遍历时跳过所有 `role === "system"` 的消息。

这对应上游的 `collapseSystemMessages`。上游还能在模型支持时原位发送中途的 system message
（`supportsMidConvoSystemMessages`），课程不做，只在 `:::pi` 中说明。

### ScriptedModel（第 04 章）

`requests[]` 继续保存完整 `AgentContext` 的深副本。断言 system prompt 时，用
`currentSystemPrompt(request.messages)`，不再读 `request.systemPrompt`。

### Agent Loop（第 07 章，`src/agent-loop.ts`）

- 请求只由 `messages` 与 `tools` 组成；loop 不再单独传 system prompt。
- loop 自己**从不**写入 system message；它只追加 assistant 与 toolResult。
- 不变量：loop 维护的 transcript 只追加，它交给模型的 `AgentContext.messages` 以调用方给的
  messages（含其中的 system message）为前缀。第 05 章 adapter 的折叠只发生在请求出线那一刻，
  结果从不回写 transcript；system message 始终留在 transcript 里。

### Stateful Agent（第 09 章，`src/agent.ts`）

- 构造参数 `systemPrompt?: string` 保留。若初始 transcript 不以 system message 开头且
  `systemPrompt` 非空，Agent 在 transcript 开头放入 `{ role: "system", content: systemPrompt, timestamp: 0 }`。
- `get systemPrompt(): string | undefined` 返回 `currentSystemPrompt(transcript)`，只读。
- 要改 prompt，只能追加 system message。`prompt(value, options?)` 新增可选参数
  `options.system?: { content?: string; sections?: Record<string, string | null> }`：
  给出时，Agent 在本次运行开始、用户消息之前，把
  `{ role: "system", content: options.system.content ?? "", sections, timestamp }` 追加进 transcript；
  它与用户消息属于同一次运行的新增部分。运行中途不能插入 system message。

### Session（第 10 章，`src/session.ts`）

- 严格 parser 接受 `role: "system"` 的 message entry，校验 `content` 为字符串、
  `sections` 为 `string | null` 值的对象。
- 不新增 entry 类型。

### Context 投影（第 11 章，`src/context.ts`）

- `BuildContextOptions` 去掉 `systemPrompt`；`BuildContextResult` 去掉 `systemPrompt`。
- 从**整条** active path（包括 compaction 之前的部分）收集 system message，
  重放为一条 `currentSystemMessage`，作为固定成本放在最前面，计入 `tokens.system`。
- interaction 分组与摘要输入都排除 system message。
- 结果 `messages = [当前 system message?, compaction 摘要?, ...保留的后缀]`。
- 课程不给 compaction entry 增加 `systemMessage` 字段：重放整条 active path 已能得到同样结果；
  `:::pi` 说明上游为何另存一份（避免读取压缩前的 entry）。

### Resources（第 12 章，`src/resources.ts`）

- `formatResourceContext()` 仍返回文本；新增导出常量 `RESOURCE_SECTION = "pi-resources"`。
- 资源文本作为 `sections[RESOURCE_SECTION]` 进入 system message，不再与基础 prompt 拼接成一个字符串。

### Runtime（第 13 章，`src/composition.ts`）

- 期望状态：`base = config.systemPrompt`，`sections = { [RESOURCE_SECTION]: 资源文本 }`（资源为空则不含该段）。
- 每次 `prompt()` 前，用恢复出的 transcript 重放当前 system 状态：
  - 还没有任何 system message、且期望状态非空：在本轮输入前放一条开头的 system message；
  - 已有：比较段落，只为变化的段落生成补丁（删除的段落为 `null`）；无变化则不追加。
  - 基础 prompt 只在第一次写入。恢复会话后若 `config.systemPrompt` 与重放出的基础 prompt 不同，
    以 transcript 为准、忽略配置差异（transcript 是事实）。`:::pi` 说明上游可用追加 `content` 的方式补充说明。
- 补丁通过第 09 章的 `agent.prompt(value, { system })` 与用户消息一起成为本轮新 suffix，按原有规则持久化。
- 恢复：`createRuntime` 把 active path 上的消息（含 system message）作为 `initialMessages` 交给 Agent，
  `persistedMessageCount` 从这个数量开始。Runtime **不**把 `config.systemPrompt` 传给 Agent 构造函数：
  构造期放入的 system message 不属于任何一轮 suffix，永远不会落盘。第一条 system message 由第一次
  `prompt(value, { system })` 写入，并随该轮 suffix 持久化；空会话构造后 `getState().messages` 仍为空。
  Agent 的“`initialMessages` 已以 system message 开头时不再放入”保护在第 13 章随 `initialMessages` 一起出现。
- 不变量：已经持久化的 transcript 前缀永不改写。

### Eval（第 14 章）

active path 校验接受 system message；system message 不参与 tool call / result 配对检查。

## 实现中确定的细节（2026-10-02 补充）

- 第 03 章的 `AgentContext` 只有 `messages`；`tools` 仍由第 05 章加入。
- 第 04 章没有断言 system prompt，代码不变。
- `textOf(systemMessage)` 返回 `systemMessageText(message)`。
- `AgentEvent.run_start` 增加可选 `system?: SystemMessage`，reducer 据此把补丁放在用户消息之前。
- 第 11 章 `tokens.system` 把重放出的 `SystemMessage` 当作一条消息估算；system entry 永不出现在
  `keptEntryIds`，由开头的重放消息代表。
- 第 14 章 `SafeEvidence.messages` 增加 `system` 计数。
- 课程 `currentSystemPrompt` 在没有 system message 时返回 `undefined`；上游返回 `""`。

## 明确不做（只在 `:::pi` 中说明）

- `toolsAdded` / `toolsRemoved`：上游用 system message 声明工具集合变化；03–14 仍用 `context.tools`。**已由第五部覆盖**（第 15 章）。
- 工具结果的 `isError`（作为不抛异常的失败）、`structuredContent`、`outputSchema`、`replay`。（`replay` 已由第 19 章的 durable harness 覆盖，声明在 `DurableToolRegistration` 上。）
- `StopReason` 的 `pending`、`deferred`。
- compaction entry 的 `systemMessage` 快照、`usage` / `context_edit` entry。
- codemode、工具暴露级别、MCP、虚拟模型、pi-durable：原计划只放进教材附录。**已由第五部覆盖**（第 15–19 章各有 checkpoint；附录改为“Pi 1.0 机制与章节对照”）。

## 受影响的 checkpoint

源码改动：03、05、07、09、10、11、12、13、14（04 只改测试断言写法）。
因为历史线性，03 之后的全部 checkpoint 哈希都会变化；变基到 v1.0.0 后 00–02 的哈希也已变化。
每个 checkpoint 必须：自身聚焦测试通过、全量测试通过、对应 `starters/` 能在 parent 上编译。

## 教材侧同步

- `content/checkpoints.json` 用 `npm run history:sync` 重新生成；测试标题改动要同步。
- `lib/course.ts` 的 `UPSTREAM_COMMIT`、`README*.md` 与 `tests/rendered-html.test.mjs` 中的固定提交改为 v1.0.0。
- 15 章 `:::pi` 全部改为对照 v1.0.0，附 `文件:行号`；原固定提交说法已失效的，写明“8479bd8 时 X，1.0 改为 Y”。
- `docs/authoring-guide.md` 的“当前上游”事实更新。
- 新增不计入 15 章的附录页：1.0 新机制（system 消息模型总览、codemode 与工具暴露、MCP、虚拟模型、pi-durable）。
