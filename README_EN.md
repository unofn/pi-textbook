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

## Course at a Glance (Checkpoints 00–14)

The 15 checkpoints follow one Agent execution path. First you establish messages and model protocols, then close the tool loop, preserve state and history, and finally compose and evaluate the complete Runtime.

| Part | Checkpoint | Chapter | What you build | Textbook (ZH) |
| --- | :---: | --- | --- | :---: |
| Prologue | `00` | **How a README Request Travels Through the Agent Loop** | Trace one offline README request through user input, two model turns, a paired tool call and result, and the final answer. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/prologue) |
| I · Models & Protocols | `01` | **TypeScript Survival Kit: Four DemoEvents from Values to Tests** | Define a tagged event union, narrow every branch, validate unknown input at runtime, and load compiled TypeScript through an ESM test. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/typescript-survival) |
| I · Models & Protocols | `02` | **EventStream: Delivering Events and a Final Result** | Implement one async event stream that handles queued events and waiting consumers, exposes terminal events, and resolves a separate final result. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/event-stream) |
| I · Models & Protocols | `03` | **Persisting a Complete Tool Round Trip** | Model user text, assistant text and tool calls, and paired tool results as a canonical message format that can be saved and replayed. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/message-ir) |
| I · Models & Protocols | `04` | **ScriptedModel: Replaying Two Turns in Order** | Build a deterministic model double that snapshots each request, advances through scripted turns, and projects assistant messages into asynchronous model events. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/scripted-model) |
| I · Models & Protocols | `05` | **Model Calls: Translating Between Course Protocols and Provider APIs** | Translate canonical messages into provider requests, parse streamed SSE chunks, reassemble incremental tool arguments, and emit provider-independent model events. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/provider-adapter) |
| II · Tools & Loop | `06` | **Tool Calls: Turning an Echo Request into Its Paired Result** | Define a tool schema and registry, validate untrusted arguments, execute the selected tool, and return a result carrying the original call ID. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/tool-contract) |
| II · Tools & Loop | `07` | **Agent Loop: A README Round Trip in Two Model Calls** | Implement the loop that appends model messages, executes requested tools, records paired results, and calls the model again until it stops. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/agent-loop) |
| II · Tools & Loop | `08` | **Four Coding Tools in One Workspace** | Create read, write, exact-edit, and shell tools that stay inside one workspace, serialize mutations, and return bounded text with structured details. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/coding-tools) |
| III · State & History | `09` | **From a One-Shot Loop to a Stateful Agent** | Wrap the loop in a long-lived Agent that preserves transcripts, publishes state changes, rejects reentrancy, and coordinates cancellation, steering, and follow-up input. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/stateful-agent) |
| III · State & History | `10` | **Restoring the Current Conversation from a Session Tree** | Store completed messages as append-only JSONL entries with stable parent links, preserve branches, and reconstruct the active conversation from a selected leaf. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/session-tree) |
| III · State & History | `11` | **Rebuilding Context to Fit a Budget Without Rewriting History** | Group messages into indivisible interactions, keep the newest complete suffix that fits the token budget, and append structured summaries for earlier facts. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/context-compaction) |
| IV · Extensions & Evaluation | `12` | **Loading Knowledge on Demand and Gating Executable Extensions** | Discover project instructions, skills, and templates as data, activate only needed knowledge, then load trusted extensions with atomic registration and isolated hooks. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/resources-extensions) |
| IV · Extensions & Evaluation | `13` | **Composing a Runtime That Commits History** | Wire Agent, session storage, context projection, resources, and extensions into one Runtime whose prompt resolves only after new entries reach the Session Store. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/composition-root) |
| IV · Extensions & Evaluation | `14` | **Independent Evaluation for the Complete Pi Runtime** | Run each evaluation from a fresh fixture, collect the active path and declared files, judge frozen observations, and report only stable counts and categories. | [Open](https://build-your-own-pi-cn.enochzhang.chatgpt.site/learn/eval-capstone) |

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
