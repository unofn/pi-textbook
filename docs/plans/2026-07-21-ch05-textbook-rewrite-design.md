# 第 05 章样章重写设计

## 目标

保留第 05 checkpoint 的代码、测试、四个实践阶段和技术边界，只重写教材正文。样章
用于验证一种更自然的技术写法：让具体对象和代码成为叙述主语，让解释沿一次模型
调用连续展开。

## 选择的写法

采用“调用链正文 + 后置练习卡”的方案。

- 正文从 `AgentContext` 开始，依次经过 Provider request、HTTP、SSE、
  `ProviderChunk`、`ModelEvent` 和 `AssistantMessage`。
- 每个术语紧邻一个已经出现的对象，不先列定义表。
- 代码与数据形状属于正文；parent、target、命令、测试数量和施工步骤留在 directive
  中。
- 不要求概念先由失败引出。`failure` 仅作为完成实现后的诊断实验保留。
- 不展示 target 的完整实现，只展示接口、输入输出和局部表达式。

## 保留的工程契约

- frontmatter、章节编号、artifact、prerequisites 和上游固定提交；
- 唯一 rebuild 入口及其 parent、target、教学文件、首红和命令；
- 实践 5.1 至 5.4 的独立测试入口；
- provider index 与 content index、累计 partial、finish/usage、SSE 分帧、unknown
  验证、取消和密钥脱敏；
- failure、checkpoint、Pi 对照、transfer 与测试证据边界。

## 行文约束

- 少用“本章”“你必须”“先……再……”作为段落骨架；
- 一段只跟随一个对象或一次转换；
- 用“这个对象”“上面的 payload”“返回方向”等指代保持上下文连续；
- 标题直接说明当前对象或动作；
- 不把每段收束成格言或边界声明；
- 练习说明不打断首次解释。

## 验证

重写后运行学习契约、中文正文、workshop、内容构建和渲染测试。生产部署必须引用已
提交并推送的同一源码状态。
