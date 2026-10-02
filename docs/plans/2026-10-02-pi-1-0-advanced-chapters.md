# 第五部规划：把 Pi 1.0 的新机制做成动手章节

日期：2026-10-02
前置：`docs/plans/2026-10-02-pi-1-0-system-messages.md`（system message 模型已在 03–14 落地）
上游参考：Pi v1.0.0（`a13d35a742c6ef8462812a28fbe1d8c8b7431c32`）

## 目标

附录 `/pi-1-0` 里的四个机制（工具暴露、codemode、MCP、虚拟模型、pi-durable）目前只能读。
第五部把它们变成和前 15 章同样形式的章节：每章一个真实 checkpoint 提交、聚焦测试、
starter 脚手架、至少两个 lab、一个 `:::pi` 源码对照。

第 14 章仍是“核心课程”的验收终点；第五部是在完整 Runtime 之上的进阶，读者可以只学
00–14，也可以继续。

## 章节

新增部分 `advanced`：`第五部 · Pi 1.0 进阶`，五章，每章只增加一种主要复杂性。

### 15 · 工具暴露：谁能看见、谁能调用（`tool-exposure`）

- 建立：`ToolRegistry` 的每个工具带 `exposure: "direct" | "model-only" | "codemode" | "deferred" | "hidden"`（与上游同名）；
  区分**声明集合**（给模型看）与**可调用集合**（能执行），两者由同一张表推导。
- 用 system message 声明工具变化：给 `SystemMessage` 增加 `toolsAdded` / `toolsRemoved`，
  `currentTools(messages)` 与 `currentSystemMessage` 一样按顺序重放；loop 在请求前对比
  “transcript 重放出的工具”与“当前声明集合”，只在有差异时追加一条工具声明补丁
  （上游 `declareToolChanges`）。这补上第 03 章刻意留下的 `toolsAdded/toolsRemoved`。
- `tool_search`：一个 `model-only` 工具，对未声明的 `codemode` / `deferred` 工具做关键词排序
  （课程用 token 重叠打分，上游是 BM25），把命中的工具激活，下一次请求自动声明。
- 不变量：声明变化只追加，从不改写已有前缀；被 `hidden` 的工具既不声明也不能调用。
- 上游对照：`coding-agent/src/core/agent-session.ts:1515-1531`（可调用 / 声明集合）、
  `agent/src/agent-loop.ts:333-363`（`declareToolChanges`）、`ai/src/utils/transcript.ts`（`getCurrentTools`）、
  `coding-agent/src/extensions/tool-search/tool.ts`。
- provider 的工具清单仍来自 `context.tools`（第 05 章 adapter 不变）；loop 的新职责只是对比
  `currentTools(messages)` 与本次声明集合，并在请求前追加声明补丁。
- 受影响文件：`types.ts`（`SystemMessage.toolsAdded/toolsRemoved`、`currentTools`）、`session.ts`（严格 parser 接受新字段）、
  `agent-loop.ts`（声明补丁）、`tool.ts`（exposure）、新增 `tool-search.ts`；`context.ts` 的重放若涉及工具同步处理。
- 课程简化：排序不用 BM25；`codemode` 暴露在本章只决定“可调用、可搜索、不声明”，脚本调用留到第 16 章。

### 16 · Codemode：让模型写脚本调用工具（`codemode`）

- 建立：一个 `model-only` 的 `codemode` 工具，参数是一段 JS。宿主为每次执行新建 worker 线程，
  worker 内创建一个全新的 QuickJS（WASM）虚拟机（依赖 `quickjs-wasi` 3.6.2，与上游 `packages/codemode` 相同版本），
  设内存上限与中断回调；脚本里的 `tools.<name>(args)` 通过消息桥
  （`call{id,name,args}` → `result{id,ok,payload}`）回到宿主。
- 宿主侧每个调用走第 06 章的校验与执行路径，记作嵌套调用，id 为 `<parent>/<n>`；
  codemode 结果携带有界的 `nestedCalls` 记录（次数、参数字节上限；结果不记录）。
- 超时与取消：宿主持有 deadline 与 `AbortSignal`，到时 `worker.terminate()`；未完成的嵌套调用得到取消结果。
- 访问不存在的工具时抛错并给出近似名（上游 1.0 的 Proxy 行为）。
- 不变量：嵌套调用不写入 transcript，只出现在父结果的记录里；一个嵌套调用失败不会让同批其他调用丢失。
- 上游对照：`codemode/src/runtime/{host,worker,protocol,prelude-source}.ts`、
  `coding-agent/src/core/nested-tool-calls.ts:26-30`、`coding-agent/src/extensions/codemode/execute.ts`。
- 课程简化：不实现 `store()`、`image()`、`models`、`searchTools()` 等全局函数与输出截断；
  上游还为 Bun 准备了共享中断标志，课程只用 `worker.terminate()` 加 QuickJS 中断回调。

### 17 · MCP：把外部服务器的工具接进来（`mcp`）

- 建立：一个最小 MCP 客户端，JSON-RPC 2.0；内存传输（测试用）与换行分隔的 stdio 传输；
  `initialize` 版本协商、`notifications/initialized`、`tools/list` 分页（空 / `null` cursor 视为结束，重复 cursor 报错）、
  `tools/call`、请求超时与 `notifications/cancelled`（不取消 `initialize`）。
- 接入 Runtime：把服务器工具注册为 `mcp__<server>__<tool>`（非字母数字转 `_`，冲突或过长时加 hash 后缀），
  默认暴露为第 15 章的 `deferred`；服务器清单作为 `mcp_servers` 段落，复用第 13 章“只在变化时打补丁”。
- 不变量：首个 prompt 只等待有 `direct` 工具的服务器（有上限）；其余在后台连接，用到时再等。
- 上游对照：`mcp/src/client.ts`、`mcp/src/transports/*`、`coding-agent/src/extensions/mcp/{index,tools,runtime}.ts`。
- 课程简化：不实现 OAuth、Streamable HTTP、resources、progress；正文用 `:::pi` 指向上游。

### 18 · 虚拟模型：选择与派发分离（`virtual-models`）

- 建立：`VirtualModel { id; route(request): { model; thinkingLevel?; state? } }`；loop 在每次请求前调用
  `prepareRequest` 钩子，把虚拟选择换成本次的物理模型。
- `request.reason`：`user` / `continuation` / `retry` / `direct`；`previous` 跳过 error 与 aborted 回复；
  路由状态作为自定义 session entry 持久化，按分支查找最近一条。
- 记录：选择写 `model_change` entry，派发写在每条 assistant 消息上；恢复时还原虚拟选择。
- 错误：路由到另一个虚拟模型、未注册、`route()` 抛错，都以错误回复结束本次请求。
- 不变量：provider 永远只见到物理模型；路由不改写 transcript。
- 上游对照：`coding-agent/src/core/virtual-models.ts`、`core/model-runtime.ts:955-1030`、
  `core/agent-session.ts:759-815`、`agent/src/agent-loop.ts:219`。

### 19 · Durable：先提交，再可见（`durable`）

- 建立：一个最小 durable harness。
  - 单一变更线：所有提交排在一条 promise 链上；一次提交是对存储的一次原子批量写。
  - 存储：内存实现，可导出 / 导入快照以模拟进程重启。
  - 任务：`pending → running → completed | failed`，检查点整条替换；重新打开时 `running` 改回 `pending`。
  - 生成：流式部分输出节流提交；崩溃恢复时把已提交的部分输出转成 `aborted` assistant entry，
    并用同样的消息**从头重发**请求。
  - 工具：在 `execute()` 之前提交意图；恢复时只有存储的意图与当前注册都声明 `replay: "safe"` 才重跑，
    否则给模型 `interrupted` 错误结果。
- 范围上限：只实现四个机制——先提交再可见（单一变更线 + 原子提交）、重新打开时 `running` 改回 `pending`、
  `execute()` 前提交意图并按 `replay: "safe"` 决定重跑或 `interrupted`、部分输出转 `aborted` 后从头重发。
  JSONL 存储、poison、输出节流、文档与分叉只在 `:::pi` 中说明，课程只用内存存储（可序列化快照模拟重启）。
  本章新增代码与测试合计不超过第 14 章的规模（约 4,400 行）；超出时停下报告。
- 测试用“在第 N 步之后丢弃进程状态、用存储快照重新打开”模拟崩溃。
- 不变量：没有任何可见进展不先落盘；副作用不在提交内部执行。
- 上游对照：`durable/src/session/session.ts:404-549`、`durable/src/harness/{scheduler,generation,tool}.ts`、
  `durable/src/storage/{memory,jsonl}`。
- 说明：主力 coding-agent 1.0 仍未使用 pi-durable；本章讲的是 1.0 新确立的方向。

## 基础设施改动

### 课程仓库（`unofn/pi`，`course/build-your-own-pi`）

- 新增提交 `course(15)` … `course(19)`，接在 `course(14)` 之后。
- 现有分支末尾的 `docs(course): rename textbook to Hands-on Pi` 不是 checkpoint；
  为保持 `course(15)` 的 parent 是 `course(14)`，把它移到 `course(19)` 之后。
  00–14 的提交哈希不变；远端分支需要一次 force push（只改动末尾）。
- 每章：`src/<artifact>.ts`、`test/NN-<slug>.test.ts`、`starters/NN-*.ts`、`AGENT_GUIDE.md` 分段计数。
- `scripts/checkpoint.mjs` / `practice.mjs` 的用法提示从 `<00..14>` 改为 `<00..19>`。
- `course(16)` 给 `@pi/course` 加入第一个运行时依赖 `quickjs-wasi`（3.6.2，monorepo 根目录已因 `packages/codemode` 安装），
  该提交同时更新根 `package-lock.json` 中的 workspace 条目。

### 教材仓库（`unofn/pi-textbook`）

- 章节数从写死的 15 改为由清单驱动：
  `scripts/build-content.mjs`（`expected`、`parts`）、`scripts/validate-learning-contract.mjs:54`、
  `scripts/sync-checkpoint-history.mjs:13`、`tests/checkpoint-manifest.test.mjs:28-31`、
  `tests/learning-contract.test.mjs:67`、`components/site-header.tsx:8`。
- 第 14 章的特殊分支（artifact 指向 `test-support/eval.ts`）保持不变。
- 站点文案：首页、`/map`、`/about`、`app/layout.tsx` 元数据、README 的 “15 个 checkpoint” 改为 20，
  并说明“00–14 核心课程，15–19 进阶”；`tests/rendered-html.test.mjs:43` 同步。
- `docs/authoring-guide.md`：章节表与 `part` 枚举加入 `advanced`。
- workshop/：增加 `tool-exposure.ts`、`codemode.ts`、`mcp.ts`、`virtual-models.ts`、`durable.ts` 及测试，
  `run-workshop-tests.mjs` 增加章节别名。
- 附录 `/pi-1-0`：改为“1.0 机制与章节对照”，每节指向对应章节；保留只读的补充内容
  （OAuth、Streamable HTTP、QuickJS 隔离、pi-durable 的文档与分叉等）。

## 已有章节的联动修改

- 第 03、07、13 章的 `:::pi` 目前写“课程不实现 `toolsAdded/toolsRemoved`”，改为“第 15 章补上”。
- 第 12 章 `:::pi` 指向附录的 Extension API 部分，改为指向第 15–18 章。
- 第 14 章小结增加一句：核心课程到此结束，第五部是进阶。
- `docs/plans/2026-10-02-pi-1-0-system-messages.md` 的“明确不做”列表中，`toolsAdded/toolsRemoved`、codemode、MCP、
  虚拟模型、pi-durable 标注为已由第五部覆盖。

## 执行顺序

1. 课程仓库：逐章实现 15→19（顺序依赖，单个 agent），每章全量测试通过、starter 能在 parent 上编译。
2. 教材基础设施：章节数改为清单驱动，加入第五部（与 1 并行）。
3. workshop：按同样设计独立实现（与 1 并行）。
4. 同步 `checkpoints.json`，写五章正文（等 1 完成；可两到三个 agent 分章并行）。
5. 附录改版、站点文案、README。
6. 全量校验：`content:build`、`learning:verify`、`typecheck`、`workshop:verify`、`history:verify`、
   `build`、`rendered-html`、`lint`；课程仓库 `npm test -w @pi/course`。
7. 课程分支 force push；教材开 PR，CI 通过后合并；重新部署 `pi.unofn.com`。
