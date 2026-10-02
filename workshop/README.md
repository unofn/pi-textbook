# Workshop 参考实现

这里是教材 HEAD 对应的完整系统，用于页面代码契约与全量回归。真正的逐章学习
状态位于 Pi 仓库分支 `course/build-your-own-pi` 的 `packages/pi-course`。

## 运行

从 `pi-textbook/` 根目录：

```bash
npm run workshop:verify
npm run workshop:test -- provider-adapter
npm run workshop:test -- context
npm run workshop:test -- eval
npm run workshop:test -- tool-exposure
npm run workshop:test -- codemode
npm run workshop:test -- mcp
npm run workshop:test -- virtual-models
npm run workshop:test -- durable
```

聚焦别名与章节一一对应（也接受 `15-tool-exposure` 这样带编号的写法）；runner
先编译，再运行对应测试文件。测试默认完全离线，真实 provider 只在手工配置 `.env`
后才使用。

## 第五部（15–19）对应的文件

| 章节 | 源码 | 测试 |
| --- | --- | --- |
| 15 工具暴露 | `tool.ts`（exposure、声明集合与可调用集合）、`types.ts`（`currentTools`、`toolStateChanges`）、`agent-loop.ts`（声明补丁）、`tool-search.ts` | `tool-exposure.test.ts` |
| 16 Codemode | `codemode.ts`、`codemode-worker.ts`、`codemode-protocol.ts` | `codemode.test.ts` |
| 17 MCP | `mcp.ts`（client、内存与 stdio 传输）、`mcp-runtime.ts`（命名、注册、`mcp_servers` 段落） | `mcp.test.ts` |
| 18 虚拟模型 | `virtual-models.ts`、`agent-loop.ts`（`prepareRequest`）、`composition.ts`（`RuntimeRequestSession`、`appendMetadata`） | `virtual-models.test.ts` |
| 19 Durable | `durable.ts`（只有四个机制） | `durable.test.ts` |

Codemode 依赖 `quickjs-wasi`（3.6.2，教材根目录的 devDependency）。`codemode-worker.ts`
在 import 时就启动 worker，所以 `index.ts` 不导出它；宿主按编译产物旁的
`codemode-worker.js` 创建 worker。

## 两份代码各自负责什么

- `pi-textbook/workshop`：最终参考实现；保证所有章节正文共用同一套可编译接口。
- `pi-course/packages/pi-course`：00～19 累积 commit；让学习者和陪学
  Agent 精确比较每章 parent 与 target。

不要在学习第 03 章时直接用最终 HEAD 的第 14 章抽象解释问题；先通过
`npm run checkpoint -w @pi/course -- 03` 取得当时的真实边界。
