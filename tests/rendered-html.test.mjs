import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(
    "test",
    `${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: {
        accept: "text/html",
        host: "textbook.local",
        "x-forwarded-host": "textbook.local",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("首页服务端渲染完整课程入口，而不是 starter", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /动手学 Pi/);
  assert.match(html, /从一条运行轨迹开始/);
  assert.match(html, /一步步实现 Pi/);
  assert.match(html, /15 CHECKPOINTS/);
  assert.match(html, /href="\/learn\/prologue"/);
  assert.match(html, /href="\/about"/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("章节页暴露真实 commit、parent、测试与陪学协议", async () => {
  const response = await render("/learn/prologue");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /一次 README 读取请求怎样走完 Agent 闭环/);
  assert.match(html, /七个里程碑/);
  assert.match(html, /REAL CHECKPOINT/);
  assert.match(html, /course\/build-your-own-pi/);
  assert.match(html, /f9798b7c/);
  assert.match(html, /8479bd84/);
  assert.match(
    html,
    /https:\/\/github\.com\/hahhforest\/pi\/tree\/course\/build-your-own-pi/,
  );
  assert.match(
    html,
    /https:\/\/github\.com\/hahhforest\/pi\/commit\/f9798b7ce690abeca3539e3410e5f402bc65862d/,
  );
  assert.match(
    html,
    /https:\/\/github\.com\/hahhforest\/pi\/compare\/8479bd84743e8889f728acb21a62794102db0529\.\.\.f9798b7ce690abeca3539e3410e5f402bc65862d/,
  );
  assert.match(html, /00-prologue\.test\.ts/);
  assert.match(html, /npm run checkpoint -w @pi\/course -- 00/);
  assert.match(html, /npm run practice -w @pi\/course -- 00/);
  assert.match(html, /本章重建入口/);
  assert.match(html, /起终点.*parent.*起点.*target.*终点/s);
  assert.match(html, /可选迁移练习/);
});

test("学习方法明确 commit + Agent 引导优先，迁移为可选", async () => {
  const response = await render("/about");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /对照提交/);
  assert.match(html, /Agent 陪练/);
  assert.match(html, /定位文件/);
  assert.match(html, /可选迁移/);
  assert.match(html, /parent/);
  assert.match(html, /practice/);
});

test("社交图已接入绝对请求 host，旧 preview 资产已移除", async () => {
  const response = await render("/");
  const html = await response.text();
  assert.match(html, /https:\/\/textbook\.local\/og\.png/);

  const image = await stat(new URL("../public/og.png", import.meta.url));
  assert.ok(image.size > 100_000);
  await assert.rejects(
    access(
      new URL(
        "../app/_sites-preview/SkeletonPreview.tsx",
        import.meta.url,
      ),
    ),
  );
  const packageJson = await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
