import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowDown,
  Braces,
  GitBranch,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { ContinueLearning } from "@/components/continue-learning";
import { CourseMap } from "@/components/course-map";
import { courseNav, courseParts } from "@/lib/course";

export const metadata: Metadata = {
  description:
    "从消息协议和事件流开始，亲手实现工具、Agent Loop、会话树、上下文压缩与产品入口。",
};

const trace = [
  ["01", "user", "读取 README，修复失败测试"],
  ["02", "model", "toolCall · read({ path })"],
  ["03", "tool", "toolResult · 文件内容"],
  ["04", "model", "toolCall · edit({ oldText, newText })"],
  ["05", "tool", "toolResult · exact replacement"],
  ["06", "model", "toolCall · bash({ command: npm test })"],
  ["07", "loop", "stop · 修改完成，测试通过"],
];

export default function Home() {
  return (
    <main>
      <section className="home-hero">
        <div className="hero-copy">
          <p className="eyebrow">20 CHECKPOINTS · TYPESCRIPT</p>
          <h1>
            从一条运行轨迹开始，
            <br />
            <em>一步步实现 Pi。</em>
          </h1>
          <p className="hero-intro">
            课程从完全离线的运行轨迹出发，逐章建立流式模型、工具协议、
            Agent Loop、会话树、Context Compaction 与可扩展产品入口。
            每一步都有真实 TypeScript、故障实验和机器验收。
          </p>
          <ContinueLearning chapters={courseNav} />
          <div className="hero-secondary-links">
            <Link href="/map">先看完整路线</Link>
            <Link href="/about">为什么这样组织</Link>
          </div>
        </div>
        <div className="hero-trace" aria-label="一次完整 Agent 轨迹">
          <header>
            <span className="trace-status" />
            <strong>OFFLINE TRACE</strong>
            <small>ScriptedModel · deterministic</small>
          </header>
          <ol>
            {trace.map(([number, owner, event]) => (
              <li key={number}>
                <span>{number}</span>
                <small>{owner}</small>
                <code>{event}</code>
              </li>
            ))}
          </ol>
          <footer>
            <span>7 events</span>
            <span>3 model turns</span>
            <span>0 network calls</span>
          </footer>
        </div>
        <a className="hero-scroll" href="#course">
          <ArrowDown aria-hidden="true" size={16} />
          从地图开始
        </a>
      </section>

      <section className="principle-band" aria-label="教材的四个保证">
        <div>
          <Braces aria-hidden="true" />
          <strong>真实代码</strong>
          <span>正文接口来自同一套可编译 Workshop</span>
        </div>
        <div>
          <TerminalSquare aria-hidden="true" />
          <strong>真实输出</strong>
          <span>关键 trace 和边界由测试固定</span>
        </div>
        <div>
          <GitBranch aria-hidden="true" />
          <strong>逐章累积</strong>
          <span>每章留下一个可恢复 checkpoint</span>
        </div>
        <div>
          <ShieldCheck aria-hidden="true" />
          <strong>失败优先</strong>
          <span>从首次偏差定位责任层与不变量</span>
        </div>
      </section>

      <section id="course" className="home-course">
        <header className="section-heading">
          <p>20 CHECKPOINTS · ONE RUNNING SYSTEM</p>
          <h2>沿同一条主链路，逐层增加真实复杂性</h2>
          <span>
            章节不是仓库目录导览。每一章只引入一种主要复杂性，并让上一章的知识在新约束下再次被调用。
            00–14 是核心课程，15–19 在完整 Runtime 之上进阶到 Pi 1.0 的新机制。
          </span>
        </header>
        <CourseMap parts={courseParts} chapters={courseNav} />
      </section>

      <section className="home-contract">
        <div>
          <p>本书的掌握标准</p>
          <h2>当堂绿灯不是终点。</h2>
        </div>
        <blockquote>
          延迟、无提示、换一个故障情境后，仍能守住消息配对、状态所有权和历史不变量，
          才说明你真的会造 Agent。
        </blockquote>
        <Link href="/about">阅读学习契约 →</Link>
      </section>
    </main>
  );
}
