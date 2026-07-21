# 全书正文重写设计

## 已确认的方向

第 05 章是样章。读者已经确认它的阅读感觉符合预期。其余章节沿用同一种作者声音，
不复制第 05 章的标题和段落模板。

全书保留 15 章、15 个 checkpoint、parent/target、课程代码、聚焦测试和部署结构。
重写对象是每章正文，以及过去会强迫正文长成同一种形状的 authoring contract。

## 共同写作约束

- 当前对象、函数和值是叙述主语。
- 一章选择一组稳定的名字、输入或样例数据，尽量连续使用。
- 代码出现后就解释刚才发生的事情；代码不充当抽象结论的装饰图。
- 术语紧邻具体对象出现，不集中预告。
- 不把失败当作概念的固定入口。需要 failure injection 时，把它放在正常行为之后。
- parent、target、命令和测试数量留在练习卡中，不穿插到首次解释。
- 保留技术边界与“测试覆盖到哪里”，但放在主链结束以后。
- 标题直接说明当前对象或动作，少用口号式的“把 X 变成 Y”。
- 不连续使用“本章”“必须”“不要”“先……再……”控制读者。
- 每章根据自身材料决定是否使用预测、诊断实验和迁移练习。

## 各章的叙述锚点

| 章 | 贯穿正文的对象或轨迹 |
|---|---|
| 00 | 用户要求读取 README 后，七个可见里程碑怎样出现 |
| 01 | 一组 `DemoEvent` 怎样被 TypeScript 区分、验证、导入和测试 |
| 02 | 同一个 `EventStream` 在 push、next 与 result 之间怎样变化 |
| 03 | user、assistant tool call、tool result 组成的一段完整 transcript |
| 04 | 一个 `ScriptedModel` 连续接收两次 context 并播放两个 turn |
| 05 | `AgentContext → HTTP → SSE → ProviderChunk → ModelEvent`，已完成 |
| 06 | 一次 `echo` tool call 经过 schema、Registry、executor 变成 result |
| 07 | 一次 read tool 往返怎样让模型被调用两次 |
| 08 | 在同一个临时 workspace 中读取、写入、编辑并运行命令 |
| 09 | 一个 Agent 对象怎样完成 run 1、接收队列输入，再开始 run 2 |
| 10 | 一棵使用固定 id 的 session tree 与它的 active path |
| 11 | 一段固定 transcript 在 token 预算下怎样分组、保留和摘要 |
| 12 | 同一个 workspace 中的资源、Skill、模板与 Extension 怎样被发现 |
| 13 | 一次 `Runtime.prompt()` 从输入、context、loop 到持久化的完整调用 |
| 14 | 一个最小 EvalCase 从 setup、运行、观察、judge 到 EvalReport |

## 分工和审稿

每个 agent 一次只改一个 chapter 文件，不改课程代码、测试、生成文件或其他章节。
主 agent 在每个波次后检查：技术事实、指代连续性、与前后章的接缝、模板句密度和
内容契约。生成文件由主 agent 统一更新。

## 验证与发布

每个波次运行学习契约和内容构建。全书完成后运行 workshop、站点构建、渲染测试和
课程历史校验。只有同一 Git 源码状态通过全部验证后，才保存并部署 Sites 版本。
