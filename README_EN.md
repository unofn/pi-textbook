<p align="center">
  <a href="README.md">简体中文</a> · English
</p>

<p align="center">
  <img src="docs/assets/logo.png" alt="Build Your Own Pi logo" width="132" />
</p>

<h1 align="center">Build Your Own Pi</h1>

<p align="center">
  Build a Pi-style coding agent in 15 checkpoints, starting from a single offline trace.
</p>

<p align="center">
  <a href="https://build-your-own-pi-cn.enochzhang.chatgpt.site">Read the textbook in Chinese</a>
  · <a href="https://github.com/hahhforest/pi/tree/course/build-your-own-pi/packages/pi-course">Course code</a>
</p>

<p align="center">
  <a href="https://build-your-own-pi-cn.enochzhang.chatgpt.site">
    <img src="docs/assets/homepage.jpg" alt="Build Your Own Pi textbook homepage" width="1200" />
  </a>
</p>

## What Is This?

Starting with a single offline agent trace, this course takes you through 15 runnable checkpoints. You will build the system layer by layer:

`TypeScript protocols → streaming models → provider integration → tools → agent loop → session tree → context compaction → extensions → evaluation`

Each chapter brings together four artifacts: **a textbook chapter, a real commit, focused tests, and a controlled failure experiment**. Rather than presenting isolated pseudocode snippets, the course is organized as a Git history that you can check out, run, and verify.

## Start Reading

Open the [online textbook](https://build-your-own-pi-cn.enochzhang.chatgpt.site), currently available in Chinese, or run it locally:

```bash
git clone https://github.com/hahhforest/pi-textbook.git
cd pi-textbook
npm install
npm run dev
```

## Textbook and Course Code

| Repository | Purpose |
| --- | --- |
| [`pi-textbook`](https://github.com/hahhforest/pi-textbook) | The textbook website and its source code |
| [The `pi` course branch](https://github.com/hahhforest/pi/tree/course/build-your-own-pi) | Runnable code for all 15 checkpoints, located under `packages/pi-course/` |

The course branch is based on upstream commit `8479bd84` and contains commits `course(00)` through `course(14)`. The `pi-course-v1` and `course-v1/00` through `course-v1/14` tags preserve the course's first release.

## Practice with an Agent

```bash
git clone --branch course/build-your-own-pi https://github.com/hahhforest/pi.git
cd pi
npm install
npm run checkpoint -w @pi/course -- 05
npm run practice -w @pi/course -- 05 ../pi-practice-05
```

`checkpoint` shows the chapter's parent commit, target commit, and focused test suite. `practice` creates an isolated exercise directory without the solution or Git history. Share the chapter page, command output, and the exercise directory's `LEARNING.md` file with the AI agent guiding your practice.

## Project Notes

This is an original, community-built, unofficial course. It is not affiliated with Pi or Earendil Works and does not represent either organization. Original software in this repository is licensed under the MIT License. The textbook and original media are licensed under CC BY 4.0. Upstream Pi code retains its original license and attribution. See [`LICENSE`](LICENSE) and [`LICENSE-CONTENT`](LICENSE-CONTENT) for details.

For build instructions, tests, and cross-repository history verification, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

Thanks to [LINUX DO](https://linux.do/) for providing a space for Chinese-language technical discussion.
