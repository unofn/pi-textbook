# 参与开发

## 教材网站

```bash
npm install
npm run dev
```

提交前执行：

```bash
npm run content:build
npm run learning:verify
npm run typecheck
npm run workshop:verify
npm run build
```

## 跨仓库历史校验

教材记录了课程分支的 20 个 commit、parent、subject 与聚焦测试。运行完整校验时，用 `PI_COURSE_ROOT` 指向任意位置的课程仓库，不要求固定 worktree 名称或相邻目录结构：

```bash
git clone --branch course/build-your-own-pi \
  https://github.com/unofn/pi.git /path/to/pi

PI_COURSE_ROOT=/path/to/pi npm run history:verify
```

课程分支重写 checkpoint 后，先同步清单：

```bash
PI_COURSE_ROOT=/path/to/pi npm run history:sync
```

`history:sync` 默认读取课程仓库的 `course/build-your-own-pi` 分支；要从别的分支同步，设置 `PI_COURSE_BRANCH`，例如 `PI_COURSE_BRANCH=course/build-your-own-pi-1.0 npm run history:sync`。

未设置 `PI_COURSE_ROOT` 时，脚本为本地开发便利仍会尝试默认位置 `../pi-course`；这只是默认值，不是公开仓库结构的一部分。

## 代码边界

- `content/chapters/`：20 章教材源文件（00–14 核心课程，15–19 进阶）
- `scripts/build-content.mjs`：正文、链接和上游路径验证
- `lib/generated-course.ts`：生成的页面数据
- `workshop/`：教材对应的最终参考实现
- `docs/research/`：课程研究资料
- `docs/usability/`：逐章可用性回归记录

课程实现位于 `pi` fork 的 `course/build-your-own-pi` 分支中，仓库内路径为 `packages/pi-course/`。这是 Git 仓库内部路径，与维护者电脑上的 worktree 位置无关。
