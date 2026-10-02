<p align="center">
  简体中文 · <a href="README_EN.md">English</a>
</p>

<p align="center">
  <img src="docs/assets/logo.png" alt="动手学 Pi Logo" width="132" />
</p>

<h1 align="center">动手学 Pi</h1>

<p align="center">
  沿 15 个 checkpoint，从一条离线轨迹开始，亲手实现一个 Pi-style coding agent。
</p>

<p align="center">
  <a href="https://build-your-own-pi-cn.enochzhang.chatgpt.site">在线阅读</a>
  · <a href="https://github.com/unofn/pi/tree/course/build-your-own-pi/packages/pi-course">课程代码</a>
</p>

<p align="center">
  <a href="https://build-your-own-pi-cn.enochzhang.chatgpt.site">
    <img src="docs/assets/homepage.jpg" alt="动手学 Pi 在线教材首页" width="1200" />
  </a>
</p>

## 这是什么

沿 15 个可运行 checkpoint，从一条离线 Agent 轨迹出发，逐步实现：

`TypeScript 协议 → 流式模型 → Provider → 工具 → Agent Loop → 会话树 → Context Compaction → 扩展 → Eval`

每章由四部分闭环：**教材正文 + 真实 commit + 聚焦测试 + 故障实验**。课程代码不是伪代码演示，而是一条可以 checkout、运行和验证的 Git 历史。

## 内容速览（Checkpoint 00–14）

15 个 checkpoint 沿同一条 Agent 执行链逐层推进：先建立消息与模型协议，再接入工具和循环，随后保存状态与历史，最后组合 Runtime 并用独立评测验收。

| 部分 | Checkpoint | 章节 | 这一章完成什么 | 阅读 |
| --- | :---: | --- | --- | :---: |
| 序章 | `00` | **一次 README 读取请求怎样走完 Agent 闭环** | 跟随一次 README 请求，把用户消息、两次模型调用、工具调用与结果、最终回答连成完整闭环。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/prologue) |
| I · 模型与协议 | `01` | **TypeScript 生存集：四个 DemoEvent 怎样进入测试** | 用四个 DemoEvent 串起联合类型、运行时校验、Promise 与 ESM 测试。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/typescript-survival) |
| I · 模型与协议 | `02` | **EventStream：同一个对象怎样交付下一项和最终结果** | 实现 EventStream，让事件先到与消费者先等两种时序都能交付过程项和最终结果。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/event-stream) |
| I · 模型与协议 | `03` | **保存一次完整的工具往返** | 把文本、工具调用和配对结果保存为统一消息，并从模型事件收束出完整 assistant message。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/message-ir) |
| I · 模型与协议 | `04` | **ScriptedModel：同一个实例怎样依次播放两个回合** | 实现可重复播放预设回合的 ScriptedModel，保存请求快照并投影稳定事件流。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/scripted-model) |
| I · 模型与协议 | `05` | **模型调用：在课程协议和 Provider API 之间转换** | 把课程消息写成 Provider 请求，再将 SSE 响应还原为统一模型事件。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/provider-adapter) |
| II · 工具与循环 | `06` | **工具调用：一条 echo 请求怎样变成配对结果** | 让 echo 调用经过 schema、Registry 和 executor，返回沿用原 call id 的工具结果。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/tool-contract) |
| II · 工具与循环 | `07` | **Agent Loop：一次 README 往返怎样调用模型两次** | 实现两轮 Agent Loop：模型提出 read，工具结果写回后再生成最终回答。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/agent-loop) |
| II · 工具与循环 | `08` | **四个工具怎样在同一个 workspace 里完成文件任务** | 让 read、write、edit、bash 在同一 workspace 内完成受控的文件与进程操作。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/coding-tools) |
| III · 状态与历史 | `09` | **从单次循环到有状态 Agent** | 让同一个 Agent 保存跨运行消息，并管理订阅、取消、运行中指令、follow-up 与重入。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/stateful-agent) |
| III · 状态与历史 | `10` | **从一棵会话树恢复当前对话** | 把完成消息追加为带父指针的 JSONL 记录，再从指定叶子恢复当前对话路径。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/session-tree) |
| III · 状态与历史 | `11` | **历史不动，上下文按预算重建** | 按完整工具交互切分历史，在 token 预算内保留后缀，并用结构化摘要补回早期事实。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/context-compaction) |
| IV · 扩展与验证 | `12` | **知识按需进入上下文，代码先过信任门** | 发现项目规则、Skill 与模板，按需送入上下文，并让可信扩展原子注册工具与 hooks。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/resources-extensions) |
| IV · 扩展与验证 | `13` | **把已有能力接成一个能提交历史的 Runtime** | 把 Agent、Session Store、上下文、资源与扩展接成 Runtime，让 prompt 在新消息被接受后完成。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/composition-root) |
| IV · 扩展与验证 | `14` | **给完整的 Pi 建一套独立评测** | 用全新 fixture 运行 Runtime，核对活动路径与文件结果，再输出稳定的分类和计数。 | [打开](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/eval-capstone) |

## 开始阅读

直接打开[在线教材](https://build-your-own-pi-cn.enochzhang.chatgpt.site)，或在本地运行：

```bash
git clone https://github.com/unofn/pi-textbook.git
cd pi-textbook
npm install
npm run dev
```

## 教材与课程代码

| 仓库 | 作用 |
| --- | --- |
| [`pi-textbook`](https://github.com/unofn/pi-textbook) | 你正在看的 HTML 教材与网站 |
| [`pi` 的课程分支](https://github.com/unofn/pi/tree/course/build-your-own-pi) | 15 个 checkpoint 的可运行代码；课程源码位于仓库内的 `packages/pi-course/` |

课程分支从上游 Pi v1.0.0（`a13d35a7`）出发，以 `course(00)` 到 `course(14)` 组织完整历史，并按 Pi 1.0 的 system message 模型重写（设计说明见 `docs/plans/2026-10-02-pi-1-0-system-messages.md`）。第一版课程基于上游 `8479bd84`，由 `pi-course-v1` 与 `course-v1/00` 到 `course-v1/14` tags 固定。

## 和 Agent 一起练习

```bash
git clone --branch course/build-your-own-pi https://github.com/unofn/pi.git
cd pi
npm install
npm run checkpoint -w @pi/course -- 05
npm run practice -w @pi/course -- 05 ../pi-practice-05
```

`checkpoint` 定位本章的 parent、target 与聚焦测试；`practice` 创建一个不含答案和 Git 历史的练习目录。把本章网页、命令输出与练习目录中的 `LEARNING.md` 一起交给陪学 Agent 即可。

## 项目说明

这是社区原创的非官方课程，不隶属于或代表 Pi / Earendil Works。应用与原创代码采用 MIT License；教材正文与原创媒体采用 CC BY 4.0；Pi 上游代码沿用其原许可证和作者归属。详见 [`LICENSE`](LICENSE) 与 [`LICENSE-CONTENT`](LICENSE-CONTENT)。

构建、测试和跨仓库历史校验见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

感谢 [LINUX DO](https://linux.do/) 提供中文技术交流空间。
