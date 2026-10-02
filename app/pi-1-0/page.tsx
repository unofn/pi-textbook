import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { UPSTREAM_COMMIT } from "@/lib/course";
import { UPSTREAM_REPOSITORY_URL } from "@/lib/course-links";

export const metadata: Metadata = {
  title: "附录：Pi 1.0 机制与章节对照",
  description:
    "Pi 1.0 的 system 消息补丁、工具暴露、codemode、MCP、虚拟模型和 pi-durable 各对应哪一章，以及章节之外只读的补充：OAuth、Streamable HTTP、QuickJS 隔离、JSONL、poison、文档与分叉。",
};

const UPSTREAM_TAG = "v1.0.0";

function upstreamUrl(path: string, lines?: string): string {
  const base = `${UPSTREAM_REPOSITORY_URL}/blob/${UPSTREAM_COMMIT}/${path}`;
  const first = lines?.match(/^(\d+)(?:-(\d+))?/);
  if (!first) return base;
  return first[2] ? `${base}#L${first[1]}-L${first[2]}` : `${base}#L${first[1]}`;
}

/** 上游源码引用：显示为 `path:lines`，链接到固定提交。 */
function Src({ path, lines }: { path: string; lines?: string }) {
  return (
    <a href={upstreamUrl(path, lines)} target="_blank" rel="noreferrer">
      <code>{lines ? `${path}:${lines}` : path}</code>
    </a>
  );
}

function Excerpt({ source, code }: { source: string; code: string }) {
  return (
    <figure className="code-frame">
      <figcaption>
        <span>{source}</span>
      </figcaption>
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function Table({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: ReactNode[][];
}) {
  return (
    <div
      className="appendix-table"
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {head.map((cell) => (
              <th key={cell} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) =>
                cellIndex === 0 ? (
                  <th key={cellIndex} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={cellIndex}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const sections = [
  ["scope", "这一页是什么"],
  ["system-messages", "system 消息模型总览"],
  ["tool-exposure", "工具暴露"],
  ["codemode", "codemode"],
  ["mcp", "MCP"],
  ["virtual-models", "虚拟模型"],
  ["durable", "pi-durable"],
  ["reading", "推荐阅读顺序"],
] as const;

const TRANSCRIPT_SKETCH = `[0] system   content: "You are Pi …"
             sections: { "pi-resources": "…" }
[1] user       读一下 README
[2] assistant  toolCall read(README.md)
[3] toolResult …
[4] assistant  README 讲的是……
[5] system   content: ""
             sections: { "mcp_servers": "…" }   ← 本轮补丁
[6] user       接着看 package.json`;

const DIFF_SECTIONS = `const patch: Record<string, string | null> = {};
for (const [name, text] of Object.entries(current)) {
  if (previous[name] !== text) patch[name] = text;
}
for (const name of Object.keys(previous)) {
  if (current[name] === undefined) patch[name] = null;
}`;

const CALLABLE_TOOLS = `return exposure === "codemode" || exposure === "deferred"
  || (exposure === "direct" && active.has(tool.name));`;

const NESTED_LIMITS = `export const NESTED_CALL_LIMITS = {
  maxCalls: 256,
  maxArgumentBytesPerCall: 8 * 1024,
  maxArgumentBytesTotal: 32 * 1024,
  maxErrorChars: 500,
} as const;`;

const MCP_EXPOSURE = `export function toToolExposure(exposure: McpExposure): ToolExposure {
  return exposure === "codemode" ? "deferred" : exposure;
}`;

const MCP_STARTUP_WAIT = `if (waitedForStartup) return;
waitedForStartup = true;
const ready = servers.flatMap((server) =>
  isEnabled(server) && hasDirectTools(server.entry) && server.ready
    ? [server.ready] : []);
if (ready.length === 0) return;
const finished = await Promise.race([
  Promise.all(ready).then(() => true),
  new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), startupWaitMs);
  }),
]);`;

const MCP_NAME = `const name = \`mcp__\${server}__\${tool}\`.replace(/[^A-Za-z0-9_]/g, "_");
if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
const hash = createHash("sha256")
  .update(\`\${server}\\0\${tool}\`).digest("hex").slice(0, 8);`;

const OAUTH_ISS = `// RFC 9207: never send a code from another authorization server to this one.
const iss = options.iss;
if (metadata && (iss !== undefined
    || metadata.authorization_response_iss_parameter_supported)) {
  if (iss !== metadata.issuer) throw new OAuthIssuerMismatchError(metadata.issuer, iss);
}`;

const ROUTE_REASON = `const lastResponse = context.messages.findLastIndex((m) => m.role === "assistant");
const userTurn = context.messages.slice(lastResponse + 1).some((m) => m.role === "user");
…
reason: failed ? "retry" : userTurn ? "user" : "continuation",`;

const DURABLE_ENQUEUE = `#enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = this.#tail.then(job);
  this.#tail = run.then(() => undefined, () => undefined);
  return run;
}`;

const DURABLE_POISON = `seq = await this.#storage.commit(writes, withoutAbortSignal(context));
} catch (error) {
  tx.discard();
  if (!(error instanceof StorageRejected)) this.#poison = { error };
  throw error;
}`;

const DURABLE_REPLAY = `const tool = (await runtime.agent(context)).tools.find((each) => each.name === call.name);
if (replay === "safe" && tool?.replay === "safe") {
  // 清掉被中断那次发布的进度，从头重跑
}`;

const readingList: {
  id: string;
  title: string;
  files: { path: string; lines?: string; note: string }[];
}[] = [
  {
    id: "reading-system",
    title: "system 消息模型",
    files: [
      { path: "packages/ai/src/types.ts", lines: "512-538", note: "SystemMessage 的字段与增量语义" },
      { path: "packages/ai/src/utils/transcript.ts", lines: "73-123", note: "重放出当前 prompt，以及给不支持中途 system 的 provider 折叠" },
      { path: "packages/agent/src/agent-loop.ts", lines: "323-363", note: "declareToolChanges：工具集合的差异" },
      { path: "packages/coding-agent/src/core/system-prompt.ts", lines: "198-213", note: "diffSystemPromptSections：段落差异" },
      { path: "packages/coding-agent/src/core/agent-session.ts", lines: "1689-1703", note: "补丁在每次 prompt 前生成" },
    ],
  },
  {
    id: "reading-exposure",
    title: "工具暴露",
    files: [
      { path: "packages/coding-agent/src/core/extensions/types.ts", lines: "367-615", note: "ToolExposure、ToolLoadout、prepareLoadout 的契约" },
      { path: "packages/coding-agent/src/core/agent-session.ts", lines: "1449-1572", note: "可调用集合、声明集合与 loadout" },
      { path: "packages/coding-agent/src/extensions/tool-search/tool.ts", note: "tool_search 的 BM25 排序与激活" },
    ],
  },
  {
    id: "reading-codemode",
    title: "codemode",
    files: [
      { path: "packages/coding-agent/src/extensions/codemode/tool.ts", note: "工具定义、描述构建与 inlineBudget" },
      { path: "packages/coding-agent/src/extensions/codemode/execute.ts", note: "单次执行、store 与输出截断" },
      { path: "packages/codemode/src/runtime/host.ts", note: "worker 生命周期与消息桥的宿主一侧" },
      { path: "packages/codemode/src/runtime/worker.ts", note: "worker 里的 QuickJS 虚拟机" },
      { path: "packages/coding-agent/src/core/nested-tool-calls.ts", note: "嵌套调用的 id、记录上限与 usage 汇总" },
    ],
  },
  {
    id: "reading-mcp",
    title: "MCP",
    files: [
      { path: "packages/mcp/src/client.ts", note: "初始化、请求、超时、进度、取消与分页" },
      { path: "packages/mcp/src/oauth/flow.ts", note: "PKCE、iss 校验、token 保存与 step-up" },
      { path: "packages/coding-agent/src/core/mcp-servers.ts", note: "配置类型、校验与暴露级别" },
      { path: "packages/coding-agent/src/extensions/mcp/index.ts", note: "会话事件、启动等待与 mcp_servers 段落" },
      { path: "packages/coding-agent/src/extensions/mcp/tools.ts", note: "工具命名与注册" },
    ],
  },
  {
    id: "reading-virtual",
    title: "虚拟模型",
    files: [
      { path: "packages/coding-agent/src/core/virtual-models.ts", note: "类型、路由请求、选择与状态的读取" },
      { path: "packages/coding-agent/src/core/model-runtime.ts", lines: "994-1032", note: "resolveModel：把虚拟选择解析成物理模型" },
      { path: "packages/coding-agent/src/core/agent-session.ts", lines: "759-815", note: "prepareRequest 中的路由与状态记录" },
      { path: "packages/agent/src/agent.ts", lines: "525-548", note: "路由失败怎样变成一条 error 消息" },
    ],
  },
  {
    id: "reading-durable",
    title: "pi-durable",
    files: [
      { path: "packages/durable/README.md", note: "概念与 Experimental 声明" },
      { path: "packages/durable/src/types.ts", note: "记录、Storage 与事务接口" },
      { path: "packages/durable/src/session/session.ts", note: "变更线、提交与 poison" },
      { path: "packages/durable/src/harness/scheduler.ts", note: "任务认领、恢复与归属" },
      { path: "packages/durable/src/harness/generation.ts", note: "模型请求的检查点与崩溃后重发" },
      { path: "packages/durable/src/harness/tool.ts", note: "工具意图与 replay 判断" },
      { path: "packages/durable/src/storage/jsonl/storage.ts", note: "JSONL 后端：残行截断、poison 与 fsync 选项" },
      { path: "packages/durable/src/session/forks.ts", note: "分叉时复制哪些会话文档" },
    ],
  },
];

/** 每节开头的章节入口。 */
function ChapterLinks({ children }: { children: ReactNode }) {
  return (
    <p>
      <strong>对应章节：</strong>
      {children}
    </p>
  );
}

export default function Pi10AppendixPage() {
  return (
    <main className="reference-page prose-page appendix-page">
      <header className="reference-hero">
        <p>APPENDIX · PI 1.0</p>
        <h1>Pi 1.0 机制<br />与章节对照。</h1>
        <span>
          第五部（第 15–19 章）把 Pi 1.0 新增的几套机制做成了 checkpoint。这一页按机制列出
          对应章节和上游源码位置，并补充章节没有实现、只适合阅读的部分。
        </span>
      </header>

      <article className="chapter-prose">
        <nav className="appendix-toc" aria-label="本页目录">
          <ol>
            {sections.map(([id, title]) => (
              <li key={id}>
                <a href={`#${id}`}>{title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <h2 id="scope">这一页是什么</h2>
        <p>
          第 03–14 章基于 Pi 1.0 重建了 system 消息模型：system prompt 成为 transcript
          里的一条消息，之后的修改以补丁消息的形式追加。第五部在
          <Link href="/learn/eval-capstone">第 14 章</Link>
          完成的 Runtime 之上继续动手：工具暴露、codemode、MCP、虚拟模型和 pi-durable 各占一章，
          每章都有自己的 checkpoint、练习和测试。
        </p>
        <p>
          下面每一节先给出对应章节，再补充上游在章节之外还做了什么：MCP 的 OAuth 与
          Streamable HTTP、codemode 的 QuickJS 隔离细节、coding-agent 里的工具暴露表、pi-durable 的
          JSONL 存储、poison、文档与分叉等。这些补充只供阅读，没有对应的练习。
        </p>
        <p>
          所有引用固定在上游 {UPSTREAM_TAG}（
          <a
            href={`${UPSTREAM_REPOSITORY_URL}/tree/${UPSTREAM_COMMIT}`}
            target="_blank"
            rel="noreferrer"
          >
            <code>{UPSTREAM_COMMIT.slice(0, 12)}</code>
          </a>
          ），写成 <code>packages/…:行号</code>，点开即是该提交下的文件。
          虚拟模型在上游 CHANGELOG 里标为 experimental，pi-durable 的 README 标着 Experimental，
          这两部分的接口可能在后续版本变化。
        </p>

        <h2 id="system-messages">system 消息模型总览</h2>
        <ChapterLinks>
          <Link href="/learn/message-ir">第 03 章 · 为 Agent 建立统一消息语言</Link>
          （<code>SystemMessage</code> 与重放）；
          <Link href="/learn/composition-root">第 13 章 · 把已有能力接成一个能提交历史的 Runtime</Link>
          （段落补丁）。工具声明一侧见
          <Link href="/learn/tool-exposure">第 15 章</Link>。
        </ChapterLinks>
        <p>
          Pi 1.0 处理“模型应该看到什么说明”时遵守一条习惯：只追加，不改写前缀。
          工具集合或 prompt 的某个段落变了，Pi 不回头修改历史里那条声明，而是在对话末尾追加一条带补丁的
          system 消息。前缀因此一直不变，provider 的 prompt cache 可以持续命中；按顺序重放所有
          system 消息，就能得到当前生效的 prompt（
          <Src path="packages/ai/src/utils/transcript.ts" lines="73-105" />）。
        </p>
        <Excerpt source="示意：一次会话中的两条 system 消息" code={TRANSCRIPT_SKETCH} />
        <p>
          上面第 [5] 条只携带变化的段落。<code>sections</code> 里的值按名字覆盖旧段落，
          <code>null</code> 表示删除；<code>content</code> 非空时追加到已有说明之后。
          同一个模式在上游三个包里各自出现了一次：
        </p>
        <Table
          caption="只追加的三处实现"
          head={["位置", "追加什么", "对应章节"]}
          rows={[
            [
              <>
                <code>declareToolChanges</code>
                <br />
                <Src path="packages/agent/src/agent-loop.ts" lines="323-363" />
              </>,
              <>
                每次请求前比较 transcript 已声明的工具与当前可执行的工具，把差异写成
                system 消息上的 <code>toolsAdded</code> / <code>toolsRemoved</code>。
              </>,
              <>
                <Link href="/learn/tool-exposure">第 15 章</Link>。课程只在注册表用到非
                <code>direct</code> 暴露、或 transcript 已声明过工具时才生成这条补丁，07–14 章的
                transcript 因此保持不变。
              </>,
            ],
            [
              <>
                <code>diffSystemPromptSections</code>
                <br />
                <Src path="packages/coding-agent/src/core/system-prompt.ts" lines="198-213" />
              </>,
              <>
                比较重放出的段落与期望段落，把变化作为新 system 消息插在本轮用户消息之前（
                <Src path="packages/coding-agent/src/core/agent-session.ts" lines="1689-1703" />）。
              </>,
              <>
                <Link href="/learn/composition-root">第 13 章</Link>对 <code>pi-resources</code>{" "}
                段落做同样的差异补丁；<Link href="/learn/mcp">第 17 章</Link>用同一条路径维护
                <code>mcp_servers</code> 段落。
              </>,
            ],
            [
              <>
                <code>planSystemEntries</code>
                <br />
                <Src path="packages/durable/src/harness/prompt.ts" lines="66-93" />
              </>,
              <>
                把扩展段落和工具的差异追加成 <code>pi.system</code> entry，工具变化跟在最后一条补丁上。
              </>,
              <>
                没有实现。<Link href="/learn/durable">第 19 章</Link>的 durable harness 只保存
                user、assistant 和 toolResult 三种 entry。
              </>,
            ],
          ]}
        />
        <Excerpt
          source="packages/coding-agent/src/core/system-prompt.ts:203-213（节选）"
          code={DIFF_SECTIONS}
        />
        <p>
          课程按章节补齐了前两处：第 03 章定义 <code>SystemMessage</code> 并按顺序重放出当前
          prompt，第 05 章在出线时把重放结果折叠成一条开头的 system 消息，第 09 章允许
          <code>prompt(value, {"{ system }"})</code> 在用户消息之前追加补丁，第 13 章在每次
          <code>prompt()</code> 前只为变化的段落生成补丁。第 15 章再给 <code>SystemMessage</code> 加上
          <code>toolsAdded</code> / <code>toolsRemoved</code>：<code>tool_search</code> 激活的工具在同一个
          run 里就能声明给模型，恢复会话时也能从 transcript 读回。
        </p>

        <h2 id="tool-exposure">工具暴露</h2>
        <ChapterLinks>
          <Link href="/learn/tool-exposure">第 15 章 · 工具暴露：谁能看见、谁能调用</Link>。
          章节实现了五种 <code>exposure</code>、声明集合与可调用集合、工具声明补丁和
          <code>tool_search</code>；排序用 token 重叠，上游是 BM25。下面是 coding-agent 里的完整对照。
        </ChapterLinks>
        <p>
          一个工具能被谁看到，由注册时的 <code>exposure</code> 决定。下表的四列都对应
          <Src path="packages/coding-agent/src/core/agent-session.ts" lines="1449-1572" />
          里的判断：
        </p>
        <Table
          caption="exposure 与四条可达路径"
          head={["exposure", "声明给模型", "脚本可调", "tool_search 可搜", "列在 codemode 描述里"]}
          rows={[
            [<code key="e">direct</code>, "激活时", "激活时", "否", <>
              <code>on</code> 模式不列，只在已声明工具的描述后追加一行脚本调用说明；<code>only</code> 模式列出
            </>],
            [<code key="e">model-only</code>, "激活时（注册即激活）", "从不", "否", "否"],
            [<code key="e">codemode</code>, "仅显式激活时", "是", "未激活时可搜", "在 inlineBudget 内列出"],
            [<code key="e">deferred</code>, "被 tool_search 激活后", "是", "未激活时可搜", "从不"],
            [<code key="e">hidden</code>, "否", "否", "否", "否"],
          ]}
        />
        <Excerpt
          source="packages/coding-agent/src/core/agent-session.ts:1515-1518（节选）"
          code={CALLABLE_TOOLS}
        />
        <p>
          声明给模型的集合是“已激活且不是 hidden”的工具；注册时只有 <code>direct</code> 和
          <code>model-only</code>、并且 <code>defaultActive !== false</code> 的工具会被激活。
          <code>codemode</code> 和 <code>tool_search</code> 自己都注册为 <code>model-only</code>（
          <Src path="packages/coding-agent/src/extensions/codemode/tool.ts" lines="377" />、
          <Src path="packages/coding-agent/src/extensions/tool-search/tool.ts" lines="232" />），
          所以脚本里既不能再启动一段 codemode，也不能调用 <code>tool_search</code>。
          <code>tool_search</code> 命中后把匹配的工具加入激活集合，下一次请求前由
          <code>declareToolChanges</code> 写进 <code>toolsAdded</code>，同一个 run 里就能生效。
        </p>
        <p>
          MCP 配置里也可以写 <code>codemode</code> 暴露，但注册时它被映射成核心的 <code>deferred</code>：
        </p>
        <Excerpt
          source="packages/coding-agent/src/extensions/mcp/tools.ts:39-41"
          code={MCP_EXPOSURE}
        />
        <p>
          结果是 MCP 工具不会列在 codemode 描述里。脚本知道名字就能直接调用它们；名字本身要由模型通过
          <code>tool_search</code> 或脚本里的 <code>searchTools()</code> 查到，两者使用同一个排序器。
          模型知道有哪些 MCP server，靠的是 MCP 一节的 <code>mcp_servers</code> 段落。
        </p>

        <h2 id="codemode">codemode</h2>
        <ChapterLinks>
          <Link href="/learn/codemode">第 16 章 · Codemode：让模型写脚本调用工具</Link>。
          章节用与上游同版本的 quickjs-wasi 跑脚本，嵌套调用经过第 06 章的参数校验，默认不经过第 12 章的扩展钩子；store、image、
          models、<code>searchTools</code> 和输出截断没有实现。下面补充上游的隔离与记录细节。
        </ChapterLinks>
        <p>
          codemode 是一个参数为一段 JavaScript 的工具。模型调用它时，Pi 为这一次执行新开一个 worker
          线程（<Src path="packages/codemode/src/runtime/host.ts" lines="155" />），在里面启动一个全新的
          QuickJS（WASM）虚拟机（<Src path="packages/codemode/src/runtime/worker.ts" lines="54-61" />）。
          脚本里的 <code>tools.read()</code> 之类调用通过消息桥回到宿主，跨线程传递的只有 JSON 字符串，
          宿主一侧走与普通工具调用相同的参数校验和钩子。
        </p>

        <h3>一次 codemode 调用的路径</h3>
        <ol>
          <li>
            模型发出 <code>codemode{"{code}"}</code>，<code>runToolCall</code> 照常校验参数并触发
            <code>tool_call</code> 钩子。
          </li>
          <li>
            执行器把可调用集合映射成沙箱里的 <code>tools</code> 命名空间，再调用
            <code>sandbox.execute()</code> 新建 worker（
            <Src path="packages/coding-agent/src/extensions/codemode/execute.ts" lines="320-394" />）。
          </li>
          <li>
            脚本里 <code>await tools.read(…)</code> 经消息桥发出 <code>call</code>，宿主执行对应工具。
            这是一次嵌套调用：id 形如 <code>&lt;父 id&gt;/1</code>，同样经过校验，同样触发
            <code>tool_call</code> / <code>tool_result</code>，事件上带 <code>parentToolCallId</code>（
            <Src path="packages/coding-agent/src/core/nested-tool-calls.ts" lines="175-248" />）。
          </li>
          <li>
            有 <code>outputSchema</code> 的工具把 <code>structuredContent</code> 交给脚本，否则交文本；出错时脚本里的
            Promise 被 reject。
          </li>
          <li>
            脚本结束后，宿主先置共享中断标志，再终止 worker（
            <Src path="packages/codemode/src/runtime/host.ts" lines="242-272" />）。这个标志是为 Bun
            准备的；第 16 章用 <code>SharedArrayBuffer</code> 中断加 <code>worker.terminate()</code>。
            输出超过上限时截断，完整内容落到临时文件。
          </li>
          <li>
            codemode 的结果消息上挂一份 <code>nestedCalls</code> 记录，并合并各层嵌套调用的 usage。
          </li>
        </ol>
        <Excerpt
          source="packages/coding-agent/src/core/nested-tool-calls.ts:26-31"
          code={NESTED_LIMITS}
        />
        <p>
          这组上限只约束记录，不约束执行。第 257 次调用照样执行，只是不再记录；
          <code>maxArgumentBytesTotal</code> 是所有调用参数加起来的字节数，超长的参数换成字节数并标
          <code>complete: false</code>；工具结果本身从不记录（
          <Src path="packages/coding-agent/src/core/nested-tool-calls.ts" lines="64-69" />）。
        </p>

        <h2 id="mcp">MCP</h2>
        <ChapterLinks>
          <Link href="/learn/mcp">第 17 章 · MCP：把外部服务器的工具接进来</Link>。
          章节实现 JSON-RPC 客户端、stdio 传输、工具命名与注册和 <code>mcp_servers</code> 段落；
          OAuth、Streamable HTTP、resources、progress、重连与重试只在这里读。
        </ChapterLinks>
        <p>
          上游的 MCP 支持分成两层。<code>packages/mcp</code>（pi-mcp）是一个不依赖其他 Pi 包的 MCP 客户端，负责协议、
          stdio 与 Streamable HTTP 两种传输以及 OAuth；coding-agent 的内置 MCP 扩展负责读配置、管理连接、
          注册工具和维护 system prompt 里的 <code>mcp_servers</code> 段落。扩展的设计目标有两条：MCP
          不拖慢第一个 prompt，也不破坏 prompt cache。
        </p>

        <h3>会话时间线</h3>
        <ol>
          <li>
            <code>session_start</code>：读全局 <code>mcp.json</code>，项目已被信任时再读
            <code>.pi/mcp.json</code>；按配置激活 codemode 或 <code>tool_search</code>；然后用
            <code>setImmediate</code> 在后台连接所有启用的 server（
            <Src path="packages/coding-agent/src/extensions/mcp/index.ts" lines="954-991" />）。
          </li>
          <li>
            <code>before_agent_start</code>：按当前连接状态重新渲染 <code>mcp_servers</code> 段落。段落有变化时，
            core 用 <code>diffSystemPromptSections</code> 把补丁作为新 system 消息插在用户消息之前，已有前缀不动（
            <Src path="packages/coding-agent/src/extensions/mcp/index.ts" lines="1016-1024" />）。
          </li>
          <li>
            第一个 prompt：只等待带 <code>direct</code> 工具的 server，最多 10 秒，每个会话只等一次。超时后照常发请求，
            并提示这些工具连上后才会出现。
          </li>
          <li>
            codemode 调用：对脚本源码做匹配，只等待脚本点名的 server；脚本用到 <code>searchTools</code> 这类发现函数时等待全部
            server。这一步没有超时，只受取消信号约束。
          </li>
          <li>
            server 发来 <code>tools/list_changed</code> 时刷新工具。工具注册后不能注销，被撤下或禁用的工具以
            <code>hidden</code> 重新注册。
          </li>
        </ol>
        <Excerpt
          source="packages/coding-agent/src/extensions/mcp/index.ts:996-1009（节选，DEFAULT_STARTUP_WAIT_MS = 10_000 在 :90）"
          code={MCP_STARTUP_WAIT}
        />

        <h3>工具命名</h3>
        <Excerpt
          source="packages/coding-agent/src/extensions/mcp/tools.ts:87-89（MAX_TOOL_NAME_LENGTH = 64 在 :44）"
          code={MCP_NAME}
        />
        <p>
          工具名形如 <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>，非字母数字下划线的字符替换成下划线。
          名字超过 64 个字符，或替换后与同一 server 内的其他工具重名，就截短并附上
          <code>server\0tool</code> 的 SHA-256 前 8 位。重名判定与工具列表的顺序无关：
          替换后撞名的所有工具都会加 hash，所以 server 调换列表顺序不会让工具名互换。
          <code>mcp_servers</code> 段落整体上限 4096 字符、每条描述 250 字符，放不下的 server 在末尾折叠成一行计数。
        </p>

        <h3>Streamable HTTP 与 OAuth 要点</h3>
        <p>
          远程 server 走 Streamable HTTP 传输，需要授权时进入下面的 OAuth 流程。
        </p>
        <ul>
          <li>
            先按 RFC 9728 查受保护资源元数据，带路径的 well-known 地址失败时回退到根路径（
            <Src path="packages/mcp/src/oauth/discovery.ts" />）。
          </li>
          <li>
            授权服务器元数据依次尝试 <code>oauth-authorization-server</code> 与
            <code>openid-configuration</code>，文档里的 <code>issuer</code> 必须与请求地址一致。
          </li>
          <li>
            客户端身份优先用 client ID metadata document，不支持时动态注册；两者都没有则报错。
          </li>
          <li>
            PKCE 只接受 <code>S256</code>，授权请求带 RFC 8707 的 <code>resource</code> 参数。
          </li>
          <li>
            1.0.0 新增：回调时按 RFC 9207 校验 <code>iss</code>，与元数据里的 issuer 不一致就不交换授权码。
            这一条在 <code>docs/mcp.md</code> 和 README 里都还没有写。
          </li>
          <li>
            token 响应没有给 scope 时，记为请求时的 scope；<code>invalid_client</code> 清空全部凭证重来，
            <code>invalid_grant</code> 只清 token。coding-agent 把凭证存在
            <code>~/.pi/agent/mcp-auth.json</code>，跨进程刷新用锁文件协调（
            <Src path="packages/coding-agent/src/extensions/mcp/oauth.ts" />）。
          </li>
        </ul>
        <Excerpt source="packages/mcp/src/oauth/flow.ts:340-344" code={OAUTH_ISS} />

        <h2 id="virtual-models">虚拟模型</h2>
        <ChapterLinks>
          <Link href="/learn/virtual-models">第 18 章 · 虚拟模型：选择与派发分离</Link>。
          章节实现路由、选择与派发的两类记录和路由状态的恢复；provider 目录登记和 thinking level
          的裁剪只在这里读。
        </ChapterLinks>
        <p>
          虚拟模型是一个 <code>api: &quot;pi-virtual&quot;</code> 的普通 <code>Model</code>，背后是一个
          <code>route()</code> 函数（<Src path="packages/coding-agent/src/core/virtual-models.ts" lines="30-104" />）。
          它把“选择”和“派发”分开：<code>agent.state.model</code> 始终是用户选中的虚拟模型；每次请求前，
          <code>prepareRequest</code> 调用 <code>route()</code>，得到这一次请求实际使用的物理模型和思考级别，
          结果只对这一次请求生效（
          <Src path="packages/coding-agent/src/core/agent-session.ts" lines="759-815" />）。
        </p>
        <p>
          同一个 1.0 里，chat、image、classifier 三类模型也合进了一套 <code>Models</code> 接口，用
          <code>type</code> 字段区分，不写 <code>type</code> 就是 chat（
          <Src path="packages/ai/src/types.ts" lines="1097-1168" />）。虚拟模型只作用在 chat 请求上，路由器可以在
          <code>route()</code> 里调用 classifier 模型来做选择。
        </p>
        <Excerpt
          source="packages/coding-agent/src/core/agent-session.ts:791-795（节选）"
          code={ROUTE_REASON}
        />
        <p>
          <code>route()</code> 收到的 <code>request.reason</code> 有四种取值（
          <Src path="packages/coding-agent/src/core/virtual-models.ts" lines="50" />）：
        </p>
        <Table
          caption="request.reason 的四种取值"
          head={["reason", "何时出现", "路由器能利用什么"]}
          rows={[
            [<code key="r">user</code>, "最后一条 assistant 之后出现了用户消息，即新一轮开始", "可以自由选择物理模型和思考级别；思考级别会被限制在目标模型支持的范围内。在这里调用分类器，延迟会加在首个 token 之前。"],
            [<code key="r">continuation</code>, "工具结果之后的续写", <>
              <code>request.previous</code> 是最近一次有效回复用的物理模型（跳过 error / aborted），沿用它能保住 prompt cache。
            </>],
            [<code key="r">retry</code>, "自动重试或上下文溢出压缩之后", <>
              <code>request.failed</code> 是失败的那次回复；如果失败的是路由本身，它为 undefined。
            </>],
            [<code key="r">direct</code>, "Agent 循环之外的请求，例如扩展调用、压缩和摘要", <>
              不传 <code>state</code>，返回的 <code>state</code> 也被忽略（
              <Src path="packages/coding-agent/src/core/model-runtime.ts" lines="717-730" />）。
            </>],
          ]}
        />
        <p>
          路由器可以返回一份自己的状态，例如“这一段对话已经升级到大模型”。这份状态写成
          <code>pi.virtual-model-state</code> 自定义 entry，不进入模型上下文；下一次路由时沿当前分支倒序找最近一条（
          <Src path="packages/coding-agent/src/core/virtual-models.ts" lines="158-167" />）。
          新旧状态按引用比较，返回一个内容相同的新对象也会再存一条 entry。因为 compaction 只追加不删除，这份状态在压缩后仍能找到。
        </p>
        <p>
          会话里同时留有两类记录：选择记在 <code>model_change</code> / <code>thinking_level_change</code> entry 上，
          派发结果记在每条 assistant 消息的 <code>provider</code> / <code>api</code> / <code>model</code> 字段上。
          <code>route()</code> 抛错、目标未注册或没有凭证时，<code>Agent.handleRunFailure</code>
          合成一条 error 消息，这条消息归属于虚拟模型（
          <Src path="packages/agent/src/agent.ts" lines="525-548" />）。
        </p>

        <h2 id="durable">pi-durable</h2>
        <ChapterLinks>
          <Link href="/learn/durable">第 19 章 · Durable：先提交，再可见</Link>。
          章节用内存存储和快照实现四个机制：单一变更线与原子提交、重新打开时把 running 改回
          pending、<code>execute()</code> 之前提交工具意图并按 <code>replay</code> 决定重跑、部分输出转成
          aborted entry 后从头重发。poison、JSONL 存储、文档与分叉只在这里读。
        </ChapterLinks>
        <p>
          pi-durable（<code>packages/durable</code>）是 1.0 首发的独立库，由早先 agent-core 里的实验性 harness
          拆出来重写，README 第一行就标着 Experimental（
          <Src path="packages/durable/README.md" lines="3" />）。主力 CLI coding-agent 目前没有使用它：
          <code>package.json</code> 里没有这个依赖，<code>src/</code> 下引用 pi-durable 的文件全部在
          <code>experimental/</code> 目录，发布包也排除了这个目录；主线会话仍由
          <code>core/session-manager.ts</code> 负责，课程第 10、13 章对应的是后者。
        </p>
        <p>
          pi-durable 的核心规则是先提交，再可见。同一个 Session 的所有变更排在一条 promise 链上依次执行；
          每次提交是一次 <code>Storage.commit(writes)</code> 批量写入，只有提交成功后，其他部分才能看到这次变更。
          写入失败而又不能确认“什么都没写进去”时，Session 把自己标记为 poison，之后的操作都会失败。
          第 19 章实现了前一半；它的内存存储只会整批拒绝，所以没有 poison。
        </p>
        <Excerpt source="packages/durable/src/session/session.ts:529-536" code={DURABLE_ENQUEUE} />
        <Excerpt
          source="packages/durable/src/session/session.ts:427-433（节选）"
          code={DURABLE_POISON}
        />

        <h3>崩溃后怎样恢复</h3>
        <p>
          重新打开时，调度器先在一次提交里把所有 <code>running</code> 任务改回 <code>pending</code>，但不立即调度；
          调用 <code>resume()</code>、提交新输入或等待结果时才启动（
          <Src path="packages/durable/src/harness/scheduler.ts" lines="230-262" />）。
          一轮对话里不同时刻断电，恢复结果不同：
        </p>
        <Table
          caption="一轮对话中各时刻崩溃后的恢复结果"
          head={["崩溃时刻", "重新打开后"]}
          rows={[
            ["用户输入已提交", <>
              <code>pi.user</code> entry、submission 和 generation 任务在同一次提交里落盘，任务照常执行。客户端用同一个
              requestId 重试，会拿回同一个 submission。
            </>],
            ["模型正在流式输出", <>
              用同样的上下文从头重发模型请求。已经提交的部分输出变成一条 <code>stopReason: &quot;aborted&quot;</code>
              的 assistant entry，会话视图里看得到，但不会再送给模型（
              <Src path="packages/durable/src/harness/generation.ts" lines="184-195" />、
              <Src path="packages/durable/src/harness/context.ts" lines="8" />）。
            </>],
            ["回复已提交，工具还没开始", <>
              工具意图尚未提交，任务从调用阶段重来，<code>beforeTool</code> 钩子会再跑一次。
            </>],
            ["工具 execute() 运行中", <>
              只有存储的意图和当前注册的工具都声明 <code>replay: &quot;safe&quot;</code> 时才清掉旧进度并重跑；
              否则模型收到一条“工具被中断，可能已部分执行”的错误结果，任务以 failed 结束。
            </>],
            ["工具结果已提交", "不会重跑这个工具，generation 任务等其余工具结束后发起下一次模型请求。"],
          ]}
        />
        <Excerpt
          source="packages/durable/src/harness/tool.ts:97-98（节选）"
          code={DURABLE_REPLAY}
        />
        <p>
          工具的意图在 <code>execute()</code> 之前提交，提交时记下当时注册的 <code>replay</code> 值，缺省为
          <code>&quot;unsafe&quot;</code>（<Src path="packages/durable/src/harness/tool.ts" lines="85-91" />）。
          恢复时还要再看一次当前注册的工具，两边都是 <code>&quot;safe&quot;</code> 才重跑；这样一个工具在两个版本之间改了
          replay 声明，也不会被误重跑。
        </p>
        <p>
          README 说部分输出至多每 100 ms 提交一次。代码里是一个 100 ms 的尾随定时器，加上最多一次在途提交，所以“最多丢
          100 ms”只是近似。第 19 章没有节流，每个增量提交一次。操作系统级崩溃可能丢得更多：SQLite 后端使用
          <code>synchronous = NORMAL</code>（
          <Src path="packages/durable/src/storage/sqlite/node.ts" lines="190-191" />），JSONL 后端默认不 fsync（
          <Src path="packages/durable/src/storage/jsonl/storage.ts" lines="256" />）。
        </p>

        <h3>JSONL 存储、文档与分叉</h3>
        <ul>
          <li>
            JSONL 后端打开时检查每个文件的末尾，没有以换行结束的残行直接截掉（
            <Src path="packages/durable/src/storage/jsonl/storage.ts" lines="795-802" />）。追加失败后，存储把自己标为
            poisoned，之后的调用都抛出同一个错误，必须重新打开（
            <Src path="packages/durable/src/storage/jsonl/storage.ts" lines="836-844" />）。
            <code>fsync</code> 是可选项，默认关闭（
            <Src path="packages/durable/src/storage/jsonl/storage.ts" lines="76-79" />）。
          </li>
          <li>
            文档是与 transcript 并列保存的类型化 JSON 状态，和 entry、任务在同一次提交里修改。内置文档保存每个会话的
            agent 选择（<code>pi.agent</code>）、正在运行的 generation 与工具（<code>pi.live</code>，部分输出就写在这里）、
            排队的输入（<code>pi.inbox</code>）和花费（<code>pi.usage</code>）（
            <Src path="packages/durable/src/documents.ts" />）。第 19 章把部分输出放在任务检查点里。
          </li>
          <li>
            分叉从某个 entry 开出一个新会话：新会话看到父会话截至该 entry 的历史，之后各自继续，并按 entry
            当时的状态复制会话文档（
            <Src path="packages/durable/src/session/forks.ts" />）。
          </li>
        </ul>

        <h2 id="reading">推荐阅读顺序</h2>
        <p>
          每组按列出的顺序读。先读 system 消息模型那一组，它连接课程与后面五组；其余各组彼此独立，
          最好在对应章节完成之后再读。
        </p>
        {readingList.map((group) => (
          <section key={group.id} aria-labelledby={group.id}>
            <h3 id={group.id}>{group.title}</h3>
            <ol className="appendix-reading">
              {group.files.map((file) => (
                <li key={`${file.path}:${file.lines ?? ""}`}>
                  <Src path={file.path} lines={file.lines} />
                  <span>{file.note}</span>
                </li>
              ))}
            </ol>
          </section>
        ))}

        <p className="source-note">
          本页内容依据上游{" "}
          <a
            href={`${UPSTREAM_REPOSITORY_URL}/tree/${UPSTREAM_COMMIT}`}
            target="_blank"
            rel="noreferrer"
          >
            {UPSTREAM_TAG}
          </a>{" "}
          源码整理，代码片段只做必要节选。
        </p>

        <Link className="text-action" href="/learn/tool-exposure">
          从第 15 章开始第五部 →
        </Link>
      </article>
    </main>
  );
}
