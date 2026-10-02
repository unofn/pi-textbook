import type { Metadata } from "next";
import { CourseMap } from "@/components/course-map";
import { courseNav, courseParts } from "@/lib/course";

export const metadata: Metadata = {
  title: "课程路线",
  description: "从事件流到 durable 执行的 20 个 Pi 工程 checkpoint：00–14 核心课程，15–19 进阶。",
};

const invariants = [
  "Provider 专属格式止于 adapter，不能进入 Agent Loop。",
  "每个 tool call 都有且只有一个配对 tool result。",
  "length 截断中的工具参数绝不执行。",
  "完成事件顺序与 transcript 顺序是两种不同事实。",
  "Session 只追加；Context 可以重建，但不覆盖历史。",
  "Skill 是资源，Extension 是可执行代码与信任边界。",
];

export default function MapPage() {
  return (
    <main className="reference-page">
      <header className="reference-hero">
        <p>COURSE MAP</p>
        <h1>不是 20 个主题，<br />是一个系统的 20 次状态转移。</h1>
        <span>
          你会反复穿过同一条 user → model → tool → result → next turn 主链路；
          每一部只增加一种新的所有权或资源约束。00–14 是核心课程，15–19 是 Pi 1.0 进阶。
        </span>
      </header>
      <section className="map-invariants">
        <h2>贯穿全书的不变量</h2>
        <ol>
          {invariants.map((invariant, index) => (
            <li key={invariant}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {invariant}
            </li>
          ))}
        </ol>
      </section>
      <CourseMap parts={courseParts} chapters={courseNav} />
    </main>
  );
}
