"use client";

import { BookOpen, Route } from "lucide-react";
import Link from "next/link";
import { CourseSearch } from "./course-search";
import { useProgress } from "./progress-provider";

export function SiteHeader({ totalChapters }: { totalChapters: number }) {
  const { completed } = useProgress();
  const progress = Math.round((completed.size / totalChapters) * 100);

  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="回到教材首页">
        <span className="brand-mark" aria-hidden="true">
          π
        </span>
        <span>
          <strong>动手学 Pi</strong>
          <small>从零实现 Pi</small>
        </span>
      </Link>
      <nav aria-label="全站导航">
        <Link href="/map">
          <Route aria-hidden="true" size={16} />
          路线
        </Link>
        <Link href="/about">
          <BookOpen aria-hidden="true" size={16} />
          方法
        </Link>
        <Link href="/glossary">术语</Link>
        <Link href="/pi-1-0">附录</Link>
      </nav>
      <div className="header-actions">
        <CourseSearch />
        <span
          className="header-progress"
          title={`已完成 ${completed.size}/${totalChapters} 章`}
        >
          <span style={{ width: `${progress}%` }} />
        </span>
      </div>
    </header>
  );
}
