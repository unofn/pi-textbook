import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { ProgressProvider } from "@/components/progress-provider";
import { SiteHeader } from "@/components/site-header";
import {
  COURSE_REPOSITORY_URL,
  UPSTREAM_REPOSITORY_URL,
} from "@/lib/course-links";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const rawHost =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3002";
  const host = /^[A-Za-z0-9.:[\]-]+$/.test(rawHost)
    ? rawHost
    : "localhost:3002";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const socialImage = `${protocol}://${host}/og.png`;

  return {
    title: {
      default: "动手学 Pi",
      template: "%s · 动手学 Pi",
    },
    description:
      "沿 15 个 checkpoint，从一条离线轨迹开始，用 TypeScript 逐步实现 Pi。",
    applicationName: "动手学 Pi",
    authors: [{ name: "Pi Textbook Project" }],
    keywords: [
      "Agent",
      "Pi",
      "TypeScript",
      "LLM",
      "Tool Calling",
      "Agent 教程",
    ],
    openGraph: {
      title: "动手学 Pi",
      description: "15 个 checkpoint，亲手实现一个可运行、可恢复、可扩展的 Pi。",
      type: "website",
      locale: "zh_CN",
      images: [
        {
          url: socialImage,
          width: 1672,
          height: 941,
          alt: "动手学 Pi",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "动手学 Pi",
      description: "15 个 checkpoint，亲手实现一个可运行、可恢复、可扩展的 Pi。",
      images: [socialImage],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f5f0",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <ProgressProvider>
          <SiteHeader />
          {children}
          <footer className="site-footer">
            <div>
              <span className="brand-mark" aria-hidden="true">π</span>
              <p>
                开源中文教材。学习方法受 Dive into Deep Learning 启发，
                内容与代码独立编写。
              </p>
            </div>
            <nav aria-label="页脚导航">
              <Link href="/map">课程路线</Link>
              <Link href="/about">学习方法</Link>
              <Link href="/glossary">术语表</Link>
              <Link href="/pi-1-0">Pi 1.0 附录</Link>
              <a
                href={COURSE_REPOSITORY_URL}
                target="_blank"
                rel="noreferrer"
              >
                课程代码
              </a>
              <a
                href={UPSTREAM_REPOSITORY_URL}
                target="_blank"
                rel="noreferrer"
              >
                Pi 上游
              </a>
            </nav>
          </footer>
        </ProgressProvider>
      </body>
    </html>
  );
}
