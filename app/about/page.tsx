import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "学习方法",
  description: "为什么本教材采用预测、真实 commit、陪学 Agent、故障注入与可选迁移。",
};

export default function AboutPage() {
  return (
    <main className="reference-page prose-page">
      <header className="reference-hero">
        <p>LEARNING CONTRACT</p>
        <h1>把“我看懂了”<br />变成可迁移的工程判断。</h1>
        <span>
          这本书借鉴 D2L 的短反馈回路，但为持续演进的软件系统加入了真实
          commit、陪学 Agent、提示阶梯与故障诊断。
        </span>
      </header>

      <article>
        <h2>为什么不是源码导览</h2>
        <p>
          上游仓库按照维护、复用和发布优化；学习路径要按照认知依赖优化。
          如果一开始同时面对 provider 协议、流式事件、工具校验、循环终止和会话持久化，
          代码可能跑起来，但你很难判断错误第一次出现在哪一层。因此每章只让一种主要复杂性进入系统。
        </p>

        <h2>每个学习单元怎样工作</h2>
        <ol className="method-steps">
          <li><strong>预测</strong><span>在看到 trace 前先写判断，让错误形成可比较的信号。</span></li>
          <li><strong>完整范例</strong><span>先沿一条因果链建立 schema，不让新手同时搜索目标和代码形状。</span></li>
          <li><strong>对照提交</strong><span>每章对应教学分支上的真实 commit，先看 parent，再看这一章只增加了什么。</span></li>
          <li><strong>隔离重建</strong><span>从 parent 生成无 Git 历史的目录，只注入本章聚焦测试；第 00 章例外，只观察 target。</span></li>
          <li><strong>Agent 陪练</strong><span>旁边的 Agent 一次只给一个动作；卡住时按“定位文件 → 指出签名 → 伪代码 → 局部代码”逐级提示。</span></li>
          <li><strong>故障注入</strong><span>主动破坏一个边界，寻找首次偏差而不是盯最后一句输出。</span></li>
          <li><strong>可选迁移</strong><span>第一次学习不以独立写出 sibling case 为门槛；熟练后再减少提示、延迟重做。</span></li>
        </ol>

        <h2>为什么要让 Agent 同时看教材和 commit</h2>
        <p>
          只看讲解时，你知道“为什么”；只看最终代码时，你又会一下子看到太多变化。
          教学 commit 把两者锁在同一个状态转换上：parent 是本章起点，commit 是本章终点，
          diff 就是这一步真实增加的复杂性。陪学 Agent 因而能基于你的当前位置提示，而不是
          从最终答案倒着猜一条虚假的捷径。
        </p>
        <pre><code>{`npm run checkpoint -w @pi/course -- 05
npm run practice -w @pi/course -- 05 ../pi-practice-05

请阅读 target commit 与 parent 的 diff，但不要把答案展示或复制给我。
结合当前教材和练习目录里的 LEARNING.md 指导我：先问我对下一次测试
结果的预测，然后一次只给一个动作；我卡住时再逐级增加提示。`}</code></pre>
        <p>
          `checkpoint` 负责定位状态转换；`practice` 才把它变成可动手的练习目录。
          除序章 00 外，每章都从 parent 开始，只带 target 的聚焦测试，因此学生不会意外看到实现。
          `迁移练习` 保留为可选挑战：它适合在你已经完成一次引导重建后检验迁移，
          不适合拿来判断第一次学习是否合格。
        </p>

        <h2>什么来自 D2L，什么是本书新增</h2>
        <p>
          D2L 明确采用 just-in-time、一个 working example 对应一个 notebook、
          解释与代码交错、从零实现再切换到高层抽象的组织方式。本书迁移的是这种
          “问题—概念—代码—结果”短距离，而不是复制 Notebook 或页面皮肤。
        </p>
        <p>
          Pi 是多文件、事件驱动、涉及文件系统和进程生命周期的 Node 程序。
          它的等价物不是“一节一个 notebook”，而是“一章一个可复现的系统增量”。
          本书进一步加入 D2L 网站没有强制编排的预测、真实 commit、陪学提示阶梯、
          延迟检索和混合故障诊断。
        </p>
        <p className="source-note">
          参考：
          <a href="https://d2l.ai/chapter_preface/index.html" target="_blank" rel="noreferrer">
            D2L Preface
          </a>
          、
          <a href="https://book.d2l.ai/develop/pipeline.html" target="_blank" rel="noreferrer">
            D2L build pipeline
          </a>
          。本书正文和代码均为原创。
        </p>

        <h2>课程实现与上游 Pi 的关系</h2>
        <p>
          课程保留消息配对、流终态、事件顺序、追加式历史和扩展信任边界等关键不变量，
          但会主动删掉不影响核心推理的产品复杂度。每章的 “Pi 源码对照” 会明确标记：
          哪些行为相同、哪些是教学简化、哪些是课程主动强化。
        </p>
        <ul>
          <li>课程的 deterministic eval、maxSteps 与 workspace guardrail 是教学增强。</li>
          <li>当前上游 coding tools 没有内建 cwd jail 或权限确认。</li>
          <li>当前产品主路径仍是 Agent、AgentSession 与 SessionManager；AgentHarness 是并存的演进方向。</li>
          <li>Compaction 生成 Context 投影，不删除 Session 历史。</li>
        </ul>

        <aside className="mastery-rule">
          <small>MASTER RULE</small>
          <p>
            第一次跟着提示做出来，是建立正确 schema；之后在更少提示、延迟和新情境下仍守住不变量，
            才逐步形成掌握。二者是前后阶段，不该用后者堵住前者。
          </p>
        </aside>

        <Link className="text-action" href="/learn/prologue">
          进入序章 →
        </Link>
      </article>
    </main>
  );
}
