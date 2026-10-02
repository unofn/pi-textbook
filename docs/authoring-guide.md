# Pi 教材作者契约

本契约保证 15 章由不同作者撰写时仍然形成同一本书，而不是一组风格各异的博客。

## 章节文件

| ID | 文件 | 标题 | 部分 |
|---|---|---|---|
| 00 | `00-prologue.md` | 先观察一次完整的 Agent 运行 | 序章 |
| 01 | `01-typescript-survival.md` | TypeScript、测试与 ESM 生存集 | 第一部 |
| 02 | `02-event-stream.md` | EventStream、AsyncIterable 与取消 | 第一部 |
| 03 | `03-message-ir.md` | 为 Agent 建立统一消息语言 | 第一部 |
| 04 | `04-scripted-model.md` | ScriptedModel：把模型变成可执行规格 | 第一部 |
| 05 | `05-provider-adapter.md` | 把真实流式协议挡在边界外 | 第一部 |
| 06 | `06-tool-contract.md` | Tool 是类型化的环境动作 | 第二部 |
| 07 | `07-agent-loop.md` | Agent Loop 是可证明的状态机 | 第二部 |
| 08 | `08-coding-tools.md` | Read、Write、Edit 与 Bash | 第二部 |
| 09 | `09-stateful-agent.md` | 从纯循环到可中断的 Stateful Agent | 第三部 |
| 10 | `10-session-tree.md` | 会话是追加式事件树 | 第三部 |
| 11 | `11-context-compaction.md` | History 是事实，Context 是投影 | 第三部 |
| 12 | `12-resources-extensions.md` | Resources、Skills 与 Extensions | 第四部 |
| 13 | `13-composition-root.md` | 一个核心，多种产品入口 | 第四部 |
| 14 | `14-eval-capstone.md` | 用故障矩阵证明你造出了 Pi | 第四部 |

## Frontmatter

每章必须以以下字段开头：

```yaml
---
id: "07"
slug: agent-loop
part: core
partTitle: 第二部 · 闭合 Agent 核心
chapter: "07"
title: Agent Loop 是可证明的状态机
summary: 一句话说明本章建立的能力。
minutes: 100
difficulty: 核心
artifact: packages/pi-course/src/agent-loop.ts
prerequisites: 04,06
terms: agent loop, transcript, tool result, stop reason
upstream: packages/agent/src/agent-loop.ts
---
```

`id`、`chapter`、文件前缀必须一致。`prerequisites` 使用逗号分隔；序章写空值。
`part` 只能取：

- `orientation`：00；
- `foundations`：01–05；
- `core`：06–08；
- `state`：09–11；
- `product`：12–14。

## 正文结构

全书共享一个很小的外壳，章内叙事由当前对象决定，不使用固定故事模板。

1. 开篇小节从上一章留下的真实对象或行为接入当前主题；标题可以是“你将得到什么”、
   “你将看到什么”或更贴合当前内容的说法。
2. 正文使用章内对象命名标题，例如“从 ProviderChunk 读回模型回复”。只有确实需要
   总览时才使用“先建立全景”。
3. 一个 `:::rebuild` 放在读者已经看懂第一段具体输入输出之后、第一次实践之前。
4. 至少两个小节把解释、代码和可观察结果连在一起。
5. 一个标题以“验收”收尾的小节汇总 checkpoint 的运行入口与理解检查。
6. `## 小结` 回到开篇对象，继续接向下一章。

预测、诊断实验和迁移练习按内容选择。它们是练习形式，不是每章都要重复的叙事
环节。诊断实验只能出现在正常行为已经解释清楚之后，不能靠制造事故引出概念。

每章要明确：

- 进入本章时系统会什么；
- 本章只增加哪一种主要复杂性；
- 完成后修改哪些文件、能观察到什么；
- 一条不能被破坏的不变量；
- 课程实现与当前上游 Pi 的相同和不同；
- 如何恢复到本章起点。

## 教材指令

指令不可嵌套，以单独一行的 `:::` 结束：

```md
:::rebuild title="第 07 章 · 从红测试闭合一次工具往返"
**模式：** 重建

**起终点：** parent 是本章开始时的起点快照；target 是聚焦测试通过的终点快照。

**教学文件：** `packages/pi-course/src/agent-loop.ts`

**怎么使用这张卡：** 先把它当作路线图；读完前置的最小机制，再按实践步骤写。

**第一次红灯：** 首次 build 会报告……

**第一步：** 先读聚焦测试，只创建它首次引用且 parent 中不存在的符号。

**聚焦测试：** `packages/pi-course/test/07-agent-loop.test.ts`

**定位命令：** `npm run checkpoint -w @pi/course -- 07`

**练习目录：** `npm run practice -w @pi/course -- 07`

**聚焦运行：** `npm run build -w @pi/course`，然后运行
`node --test packages/pi-course/dist/test/07-*.test.js`

**通过证据：** 聚焦测试全绿，并能解释第一次偏差。

先自己预测并尝试；只有卡住时才让陪练按提示阶梯增加信息。
:::
```

```md
:::predict title="运行前先判断"
先写下你的判断。
---answer
展开后看到解释。
:::
```

```md
:::lab title="实践 7.2 · 闭合一次工具往返"
**目标：** ...

**文件：** `packages/pi-course/src/agent-loop.ts`

**动作：**
1. ...

**运行：** `npm run build -w @pi/course`，然后只运行本段对应的 name-pattern。

**预期：** ...
:::
```

其他合法类型：

- `:::rebuild`：本章模式、起终点、教学文件、第一动作和可执行测试入口；
- `:::mechanism`：关键机制；
- `:::failure`：预期失败与首次偏差；
- `:::checkpoint`：验收、恢复和下一状态；
- `:::pi`：与固定上游 commit（Pi v1.0.0，`a13d35a7`）的源码对照；原固定提交 `8479bd8` 的说法已失效时，写明“8479bd8 时 X，1.0 改为 Y”；
- `:::transfer`：完成 commit 引导重建后，再减少脚手架的可选 sibling task；
- `:::note`：必要但非主线的说明。

每章必须且只能包含一个 `rebuild`，并至少包含两个 `lab`、一个 `checkpoint` 和一个
`pi`。`predict`、`failure`、`transfer`、`mechanism` 与 `note` 根据正文需要使用。

## 写作标准

- 技术密度不等于句子拧巴。先写清谁做什么、发生什么，再给机制命名；详细规则见
  `docs/usability/chinese-style.md`。
- 让当前对象、函数和值做句子的主语。少让“本章”“课程”“测试”和“你”连续充当
  主语。
- 段落沿上一段已经出现的对象继续推进，用“这个值”“上面的消息”“返回方向”等
  指代保持连续。不要每段重新宣布一个抽象结论。
- 不要求知识由失败、冲突或反例引出。观察、比较、定义、推导和正常运行都可以成为
  解释起点。
- 不把每一段收束成格言、二分句或边界声明。允许普通描述句承担连接工作。
- 普通动作和关系用中文。英文只保留正式代码标识与首次出现后确有必要的术语；
  `oracle` 写成“测试依据”，`fixture` 首次写成“样例数据（fixture）”。
- 一句话只承载一条主要因果链。若读出声时不像会直接对同事说的话，就重写。
- 具体对象先于术语和定义列表。若正文确实从一个待解决问题进入，平静说明即可，
  不渲染风险或失败。
- `rebuild` 是路线图，不是让读者跳过讲解直接开写。读者执行第一步之前，正文必须
  已经给出完成该步所需的最小数据形状、控制流和第一个可观察结果。
- 解释应落到数据流、所有权、顺序、资源或失败语义。
- 每个 lab 的中间状态都必须能通过 TypeScript 编译，并能运行自己的局部测试；
  尚未学习的公共分支用明确的临时异常封住，不能依赖下一段代码才能开始。
- 每个代码块只证明一个主张；紧随可观察输出和解释。
- 重建动作只写入该 checkpoint 的 `packages/pi-course/` 教学文件；`workshop/`
  是整本书的最终参考实现，不是学生逐章修改的目录。
- 代码必须和该 checkpoint 的课程接口一致，不发明无法运行的伪 API。
- 输出写成稳定模式，不依赖随机 ID、绝对路径、耗时或真实模型措辞。
- 不把第一次 “测试通过” 写成最终掌握，也不让无提示迁移堵住第一次学习；
  先完成 commit 引导重建，再在后续逐渐减少提示并迁移到新情境。
- 不照抄 D2L 或上游 Pi 的正文、注释和实现；只做原创解释和必要短片段。
- 不把课程主动强化伪装成上游行为。

## 始终成立的事实

- `StopReason` 包含 `error` 与 `aborted`；二者通过流的 `error` 终态携最终
  `AssistantMessage`，`EventStream.result()` resolve 该消息而不是向外 reject。
- tool arguments 可以增量到达，只在 call 完成后验证。
- `finish_reason = length` 可能截断 tool arguments，禁止执行。
- tool call 顺序、完成顺序和 transcript 写入顺序可能不同。
- tool 抛错仍要产生与 call 配对的结构化 `toolResult`。
- session 是 append-only tree log；context 是从 history 派生的视图。
- compaction 追加摘要并重建 context，不删除历史。
- Skill 是被读取的资源；Extension 是可执行代码和信任边界。
- 当前上游（v1.0.0）使用 `typebox`；课程可用更小的验证器讲清机制。
- 当前上游 coding tools 没有内建 cwd jail；课程若做 containment，必须标为主动强化。
- system prompt 是 transcript 的一部分：开头的 system message 是基础 prompt，之后的
  system message 只做增量（追加说明、按名字替换或删除段落）；重放全部 system message
  得到当前 prompt。改 prompt 只追加，不改写已有前缀。设计说明见
  `docs/plans/2026-10-02-pi-1-0-system-messages.md`。
- 上游 1.0 的 `StopReason` 有七个值（另含 `pending`、`deferred`），工具结果另有
  `isError`、`structuredContent`；课程只保留五个停止原因和抛错转错误结果的路径。
