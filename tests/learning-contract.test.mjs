import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  extractDirectiveField,
  hasValidStartTarget,
} from "../scripts/validate-learning-contract.mjs";

const root = path.resolve(import.meta.dirname, "..");
const chapterRoot = path.join(root, "content", "chapters");

async function chapters() {
  const files = (await readdir(chapterRoot))
    .filter((file) => /^\d{2}-.*\.md$/.test(file))
    .sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      id: file.slice(0, 2),
      source: await readFile(path.join(chapterRoot, file), "utf8"),
    })),
  );
}

function rebuildBlock(source) {
  const match = source.match(
    /:::rebuild\b[^\n]*\n(?<body>[\s\S]*?)\n:::/,
  );
  return match?.groups?.body ?? null;
}

test("起终点字段允许自然换行，但不从下一字段借用缺失词", () => {
  const multiline = [
    "**起终点：** `parent` `d055` 是第 09 章",
    "完成后的起点；`target` `5551` 是会话树与",
    "14 项测试通过的终点。",
    "",
    "**教学文件：** `packages/pi-course/src/session.ts`",
  ].join("\n");

  assert.equal(
    extractDirectiveField(multiline, "起终点"),
    [
      "`parent` `d055` 是第 09 章",
      "完成后的起点；`target` `5551` 是会话树与",
      "14 项测试通过的终点。",
    ].join("\n"),
  );
  assert.equal(hasValidStartTarget(multiline), true);

  const leakedWords = [
    "**起终点：** `parent` 只有角色，没有完整关系。",
    "",
    "**第一步：** 从起点找到 `target`，再走到终点。",
  ].join("\n");

  assert.equal(
    extractDirectiveField(leakedWords, "起终点"),
    "`parent` 只有角色，没有完整关系。",
  );
  assert.equal(hasValidStartTarget(leakedWords), false);
});

test("每章把讲解桥接到真实 commit 的第一个可执行动作", async () => {
  const all = await chapters();
  assert.equal(all.length, 15);

  const failures = [];
  for (const chapter of all) {
    const body = rebuildBlock(chapter.source);
    if (!body) {
      failures.push(`${chapter.id}: missing rebuild directive`);
      continue;
    }

    if (!hasValidStartTarget(body)) {
      failures.push(`${chapter.id}: missing 起终点`);
    }

    const expectedMode = chapter.id === "00" ? "观察" : "重建";
    const required = [
      [`模式`, new RegExp(`\\*\\*模式：\\*\\*\\s*${expectedMode}`)],
      [
        "教学文件",
        /\*\*教学文件：\*\*\s*(?:-\s*)?`packages\/pi-course\/[^`]+`/,
      ],
      ["第一步", /\*\*第一步：\*\*\s*\S+/],
      [
        "聚焦测试",
        new RegExp(
          `\\*\\*聚焦测试：\\*\\*\\s*\`packages/pi-course/test/${chapter.id}-[^\\s\`]+\\.test\\.ts\``,
        ),
      ],
      [
        "定位命令",
        new RegExp(
          `\\*\\*定位命令：\\*\\*\\s*\`npm run checkpoint -w @pi/course -- ${chapter.id}\``,
        ),
      ],
      [
        "练习目录",
        new RegExp(
          `\\*\\*练习目录：\\*\\*\\s*\`npm run practice -w @pi/course -- ${chapter.id}\``,
        ),
      ],
      [
        "聚焦运行",
        new RegExp(
          `\\*\\*聚焦运行：\\*\\*\\s*\`npm run build -w @pi/course\`[\\s\\S]*\`node --test packages/pi-course/dist/test/${chapter.id}-\\*\\.test\\.js\``,
        ),
      ],
      ["通过证据", /\*\*通过证据：\*\*\s*\S+/],
    ];

    for (const [label, pattern] of required) {
      if (!pattern.test(body)) failures.push(`${chapter.id}: missing ${label}`);
    }
  }

  assert.deepEqual(failures, []);
});

test("第一次学习明确禁止直接查看目标实现", async () => {
  const all = await chapters();
  const failures = all
    .filter(({ source }) => {
      const body = rebuildBlock(source);
      return !body || !/先不看 (?:target )?diff|禁止.*完整答案/.test(body);
    })
    .map(({ id }) => `${id}: answer-before-attempt guard missing`);

  assert.deepEqual(failures, []);
});

test("页面主 artifact 指向学生实际修改的教学历史", async () => {
  const all = await chapters();
  const failures = all
    .filter(({ id, source }) => {
      const pattern = id === "14"
        ? /^artifact:\s*packages\/pi-course\/test-support\/eval\.ts$/m
        : /^artifact:\s*packages\/pi-course\/src\/\S+$/m;
      return !pattern.test(source);
    })
    .map(({ id }) =>
      id === "14"
        ? "14: artifact does not point to pi-course test-support/eval.ts"
        : `${id}: artifact does not point to pi-course src`
    )

  assert.deepEqual(failures, []);
});

test("重建章节的所有可执行动作只指向隔离教学目录", async () => {
  const all = await chapters();
  const failures = all
    .filter(({ id }) => id !== "00")
    .filter(({ source }) => /workshop\//.test(source))
    .map(({ id }) => `${id}: still sends the learner to workshop/`);

  assert.deepEqual(failures, []);
});

test("每个重建入口在第一步前给出最小概念并预告真实首红", async () => {
  const all = await chapters();
  const failures = [];

  for (const chapter of all.filter(({ id }) => id !== "00")) {
    const body = rebuildBlock(chapter.source);
    if (!body) continue;
    if (!/\*\*动手前只需知道：\*\*\s*\S+/.test(body)) {
      failures.push(`${chapter.id}: missing minimum schema before action`);
    }
    if (!/\*\*第一次红灯：\*\*\s*\S+/.test(body)) {
      failures.push(`${chapter.id}: missing first-red preview`);
    }
  }

  assert.deepEqual(failures, []);
});

test("第一章预告真实首红，并让四个 DemoEvent 串起所需语言机制", async () => {
  const chapter = (await chapters()).find(({ id }) => id === "01");
  assert.ok(chapter);
  const body = rebuildBlock(chapter.source);
  assert.ok(body);

  assert.match(body, /第一次红灯.*(?:Cannot find module|找不到.*events)/s);
  assert.match(chapter.source, /`type`.*(?:带标签的联合类型|tagged union)/s);
  assert.match(chapter.source, /`unknown`.*运行时检查/s);
  assert.match(chapter.source, /`never`.*遗漏/s);
  assert.doesNotMatch(chapter.source, /tests 4\s*\npass 4/);
  assert.match(
    chapter.source,
    /聚焦测试覆盖四种事件的格式和顺序.*合法 delta.*数字 `text`.*边界反例/s,
  );
  assert.match(chapter.source, /`never`.*TypeScript 编译器/s);
});

test("第二章用同一个 EventStream 展示两种到达顺序与共同终态", async () => {
  const chapter = (await chapters()).find(({ id }) => id === "02");
  assert.ok(chapter);
  const body = rebuildBlock(chapter.source);
  assert.ok(body);

  assert.match(body, /第一次红灯.*(?:Cannot find module|找不到.*event-stream)/s);
  assert.match(chapter.source, /同一个 `EventStream`.*事件先到.*消费者先等待/s);
  assert.match(chapter.source, /`queue`.*`waiting`.*终态/s);
  assert.doesNotMatch(chapter.source, /运行 .*取消路径.*应通过/s);
  assert.match(
    body,
    /2 项测试.*终态事件.*`result\(\)`/s,
  );
  assert.match(chapter.source, /取消.*不在.*实现范围/s);
  assert.match(
    chapter.source,
    /声明构造器.*`end\(result\)`.*--test-name-pattern="先到的事件"/s,
  );
});

test("第三章披露两个真实源文件，并让两段实验都可独立运行", async () => {
  const chapter = (await chapters()).find(({ id }) => id === "03");
  assert.ok(chapter);
  const body = rebuildBlock(chapter.source);
  assert.ok(body);

  assert.match(
    body,
    /\*\*教学文件：\*\*[\s\S]*`packages\/pi-course\/src\/types\.ts`[\s\S]*`packages\/pi-course\/src\/event-stream\.ts`/,
  );
  assert.match(
    body,
    /第一次红灯.*AssistantMessageEventStream.*types\.js/s,
  );
  assert.match(
    chapter.source,
    /实践 3\.1.*临时.*AssistantMessageEventStream.*--test-name-pattern="文本投影"/s,
  );
  assert.match(
    chapter.source,
    /2 项聚焦测试.*文本投影.*不修改.*error.*`result\(\)`/s,
  );
  assert.doesNotMatch(chapter.source, /预期失败[^]*丢掉 toolCallId/);
});

test("第四章只重建 ScriptedModel，并用三个场景验证可执行规格", async () => {
  const chapter = (await chapters()).find(({ id }) => id === "04");
  assert.ok(chapter);
  const body = rebuildBlock(chapter.source);
  assert.ok(body);

  assert.match(
    body,
    /\*\*教学文件：\*\*\s*`packages\/pi-course\/src\/scripted-model\.ts`/,
  );
  assert.match(body, /第一次红灯.*(?:TS2307|找不到.*scripted-model)/s);
  assert.match(
    chapter.source,
    /实践 4\.1.*--test-name-pattern="脚本消息"/s,
  );
  assert.match(
    chapter.source,
    /3 项聚焦测试.*事件顺序.*请求快照.*错误回合.*脚本耗尽.*预取消/s,
  );
  assert.match(
    chapter.source,
    /单进程里的确定性事件生产者.*请求.*快照.*cursor.*microtask.*测试探针.*背压.*中途取消/s,
  );
});

test("第五章披露两个源文件，并把 provider 边界拆成可运行的小阶段", async () => {
  const chapter = (await chapters()).find(({ id }) => id === "05");
  assert.ok(chapter);
  const body = rebuildBlock(chapter.source);
  assert.ok(body);

  assert.match(
    body,
    /\*\*教学文件：\*\*[\s\S]*`packages\/pi-course\/src\/types\.ts`[\s\S]*`packages\/pi-course\/src\/provider-adapter\.ts`/,
  );
  assert.match(
    body,
    /第一次红灯.*ToolDefinition.*AgentContext.*tools/s,
  );
  assert.match(
    chapter.source,
    /实践 5\.1.*--test-name-pattern="出站转换"/s,
  );
  assert.match(
    chapter.source,
    /实践 5\.2.*--test-name-pattern="normalized transport"/s,
  );
  assert.match(
    chapter.source,
    /实践 5\.3.*--test-name-pattern="SSE"/s,
  );
  assert.match(chapter.source, /实践 5\.4.*11\/11/s);
  assert.match(
    chapter.source,
    /11 项聚焦测试.*三段边界.*canonical context.*wire messages.*网络读取.*SSE payload.*unknown.*ProviderChunk.*取消.*脱敏.*AssistantMessage/s,
  );
  assert.match(
    chapter.source,
    /工具执行与 transcript 更新.*第 06、07 章/s,
  );
  assert.doesNotMatch(chapter.source, /transport (?:保持)?很薄/);
});

test("第六章沿唯一教学路线分三步闭合工具契约", async () => {
  const chapter = (await chapters()).find(({ id }) => id === "06");
  assert.ok(chapter);
  const body = rebuildBlock(chapter.source);
  assert.ok(body);

  assert.match(
    body,
    /\*\*教学文件：\*\*\s*`packages\/pi-course\/src\/tool\.ts`/,
  );
  assert.match(body, /学习脚手架.*公共.*不(?:包含|含).*实现/s);
  assert.match(body, /第一次红灯.*Lab 6\.1.*validator/s);
  assert.match(
    chapter.source,
    /实践 6\.1.*--test-name-pattern="validator".*1\/1/s,
  );
  assert.match(
    chapter.source,
    /实践 6\.2.*--test-name-pattern="Registry".*1\/1/s,
  );
  assert.match(
    chapter.source,
    /实践 6\.3.*--test-name-pattern="执行器".*2\/2.*4\/4/s,
  );
  assert.match(
    chapter.source,
    /4 项聚焦测试.*validator.*Registry.*执行器.*signal.*progress.*details/s,
  );
  assert.match(
    chapter.source,
    /signal.*取消请求.*传递.*工具.*主动观察 signal.*及时停止/s,
  );
  assert.match(
    chapter.source,
    /executeToolCall\(\).*一次调用.*多个工具.*排队或并行.*loop/s,
  );
  assert.match(
    chapter.source,
    /通用脱敏.*外层.*路径或秘密.*原样保留/s,
  );
  assert.match(chapter.source, /`echo`/);
  assert.doesNotMatch(chapter.source, /`add`|workshop\//);
});

test("第七章把 Agent Loop 拆成五段可单独验证的状态迁移", async () => {
  const chapter = (await chapters()).find(({ id }) => id === "07");
  assert.ok(chapter);
  const body = rebuildBlock(chapter.source);
  assert.ok(body);

  assert.match(
    body,
    /\*\*教学文件：\*\*\s*`packages\/pi-course\/src\/agent-loop\.ts`/,
  );
  assert.match(body, /学习脚手架.*公共.*(?:分支|算法).*留给/s);
  assert.match(body, /第一次红灯.*Lab 7\.1.*收集模型终态/s);
  assert.match(
    chapter.source,
    /实践 7\.1.*--test-name-pattern="纯文本 stop".*1\/1/s,
  );
  assert.match(
    chapter.source,
    /实践 7\.2.*--test-name-pattern="单工具往返".*1\/1/s,
  );
  assert.match(
    chapter.source,
    /实践 7\.3.*--test-name-pattern="非执行终态".*[2-9]\/[2-9]/s,
  );
  assert.match(
    chapter.source,
    /实践 7\.4.*--test-name-pattern="并发工具".*[2-9]\/[2-9]/s,
  );
  assert.match(
    chapter.source,
    /实践 7\.5.*--test-name-pattern="取消与上限".*[2-9]\/[2-9].*(?:8|9|10|11|12)\/(?:8|9|10|11|12)/s,
  );
  assert.match(
    chapter.source,
    /assistant_message\(length.*executor 调用次数\s+0.*toolResult\(call-1.*skipped.*tool_skipped.*finish\("length"/s,
  );
  assert.match(
    chapter.source,
    /`stop` \+ 至少一个工具调用.*`unexpected-stop`.*finish\("error".*`toolUse` \+ 没有工具调用.*finish\("error"/s,
  );
  assert.match(
    chapter.source,
    /context.*不修改.*systemPrompt.*tool definitions.*唯一.*turn_end/s,
  );
  assert.match(
    chapter.source,
    /这份 loop 管理一次进程内运行.*signal.*阻止新的模型请求.*provider.*工具.*第 09 章/s,
  );
  assert.doesNotMatch(chapter.source, /`add`|workshop\//);
});

test("第八章把环境副作用拆成六段可恢复的资源协议", async () => {
  const chapter = (await chapters()).find(({ id }) => id === "08");
  assert.ok(chapter);
  const body = rebuildBlock(chapter.source);
  assert.ok(body);

  assert.match(
    body,
    /\*\*教学文件：\*\*\s*`packages\/pi-course\/src\/coding-tools\.ts`/,
  );
  assert.match(
    body,
    /学习脚手架.*公共类型.*Lab 8\.1–8\.6.*(?:不包含|留给你实现)/s,
  );
  assert.match(body, /第一次红灯.*Lab 8\.1 Read.*尚未实现/s);
  assert.match(
    chapter.source,
    /实践 8\.1.*--test-name-pattern="Lab 8\.1".*2\/2/s,
  );
  assert.match(
    chapter.source,
    /实践 8\.2.*--test-name-pattern="Lab 8\.2".*1\/1/s,
  );
  assert.match(
    chapter.source,
    /实践 8\.3.*--test-name-pattern="Lab 8\.3".*2\/2/s,
  );
  assert.match(
    chapter.source,
    /实践 8\.4.*--test-name-pattern="Lab 8\.4".*2\/2/s,
  );
  assert.match(
    chapter.source,
    /实践 8\.5.*--test-name-pattern="Lab 8\.5".*4\/4/s,
  );
  assert.match(
    chapter.source,
    /实践 8\.6.*--test-name-pattern="Lab 8\.6".*1\/1.*12\/12/s,
  );
  assert.match(chapter.source, /`endLine`.*实际.*完整/s);
  assert.match(chapter.source, /续读位置为 `endLine \+ 1`/);
  assert.match(
    chapter.source,
    /B 等待.*同一个解析后的绝对路径.*C 指向另一个路径.*同时前进.*A 即使抛错.*B.*执行权.*`MutationQueue`/s,
  );
  assert.match(chapter.source, /Edit 先验证整批/s);
  assert.match(chapter.source, /`bash`.*一个有界的终态/s);
  assert.match(
    chapter.source,
    /硬链接.*直接改写.*`rename`.*提交失败.*临时文件/s,
  );
  assert.match(
    chapter.source,
    /stdout、stderr 与截断说明共用.*`maxBashOutputBytes`/s,
  );
  assert.match(
    chapter.source,
    /POSIX.*`SIGTERM`.*`SIGKILL`.*忽略 `SIGTERM` 的后代进程/s,
  );
  assert.match(
    chapter.source,
    /这四个工具的边界.*`resolvedPath\(\)`.*操作系统沙箱.*`MutationQueue`.*`rename`.*持久化事务.*Windows.*命令\s*审批/s,
  );
  assert.doesNotMatch(chapter.source, /workshop\//);
});

test("第九章用两份脚手架分五段建立跨运行所有权", async () => {
  const chapter = (await chapters()).find(({ id }) => id === "09");
  assert.ok(chapter);
  const body = rebuildBlock(chapter.source);
  assert.ok(body);

  assert.match(
    body,
    /\*\*教学文件：\*\*[\s\S]*`packages\/pi-course\/src\/agent\.ts`[\s\S]*`packages\/pi-course\/src\/agent-loop\.ts`/,
  );
  assert.match(
    body,
    /学习脚手架.*`agent\.ts`.*`agent-loop\.ts`.*(?:没有本章答案|施工位)/s,
  );
  assert.match(body, /第一次红灯.*Lab 9\.1 reducer 尚未实现/s);
  for (const [lab, count] of [
    ["9.1", "2/2"],
    ["9.2", "2/2"],
    ["9.3", "2/2"],
    ["9.4", "2/2"],
    ["9.5", "3/3"],
  ]) {
    assert.match(
      chapter.source,
      new RegExp(
        `实践 ${lab.replace(".", "\\.")}[\\s\\S]*--test-name-pattern="Lab ${lab.replace(".", "\\.")}"[\\s\\S]*${count.replace("/", "\\/")}`,
      ),
    );
  }
  assert.match(
    chapter.source,
    /工具已经执行[\s\S]*模型\s*请求抛错[\s\S]*保留对应的工具调用和工具结果/s,
  );
  assert.match(
    chapter.source,
    /`run_start` 要深复制[\s\S]*`event\.message`[\s\S]*`run_end`[\s\S]*深复制 `result\.messages`/s,
  );
  assert.match(
    chapter.source,
    /`event\.event`[\s\S]*`const loop = event\.event`[\s\S]*类型证据[\s\S]*不需要用 `as any`/s,
  );
  assert.match(
    chapter.source,
    /已经完成的历史[\s\S]*当前用户消息[\s\S]*回调重入产生的 `run_start`[\s\S]*FIFO[\s\S]*发布前完成的快照/s,
  );
  assert.match(
    chapter.source,
    /发布 `run_start`[\s\S]*同一份局部副本[\s\S]*若发布事件后再回读[\s\S]*`this\.state\.messages`[\s\S]*FIFO[\s\S]*发布前完成的快照/s,
  );
  assert.match(
    chapter.source,
    /回调重入产生的新事件不能插队[\s\S]*start1 → end1 → start2 → end2/s,
  );
  assert.match(
    chapter.source,
    /不可复制[\s\S]*标准、\s*可复制的错误结果[\s\S]*回到 `idle`/s,
  );
  assert.match(
    chapter.source,
    /模型忽略 `signal`[\s\S]*`stop` 分支优先以 `aborted`/s,
  );
  assert.match(
    chapter.source,
    /取消检查一定先于队列消费[\s\S]*`error` 或 `aborted`[\s\S]*不会进入下一次/s,
  );
  assert.match(
    chapter.source,
    /保留你已有的清理[\s\S]*身份检查[\s\S]*发布\s*`run_end` 之后[\s\S]*不带身份检查的清理[\s\S]*原来的清理仍留在 `run_end` 之前[\s\S]*整体移到事件之后/s,
  );
  assert.match(
    chapter.source,
    /队列规则只覆盖[\s\S]*完整终态[\s\S]*steering 或 follow-up[\s\S]*最后一个允许回合[\s\S]*未定的产品策略/s,
  );
  assert.match(
    chapter.source,
    /两条 steering 何时排队[\s\S]*按 FIFO 写入消息历史[\s\S]*下一次模型请求何时发起/s,
  );
  assert.match(
    chapter.source,
    /边界是单实例、内存内生命周期[\s\S]*`ActiveRun`[\s\S]*subscriber[\s\S]*`abort\(\)`[\s\S]*signal[\s\S]*transcript[\s\S]*会话持久化/s,
  );
  assert.match(chapter.source, /陪练迁移 · waitForIdle/);
  assert.doesNotMatch(chapter.source, /workshop\//);
});

test("序章的实验、所有权和离线语义与 checkpoint 00 一致", async () => {
  const prologue = (await chapters()).find(({ id }) => id === "00");
  assert.ok(prologue);

  assert.doesNotMatch(prologue.source, /复制测试中的乱序事件数组/);
  assert.match(prologue.source, /删除 `tool_result`.*重新编号/s);
  assert.match(
    prologue.source,
    /`owner` 表示.*事件记录.*不等于.*发起者/s,
  );
  assert.match(
    prologue.source,
    /固定 (?:fixture|结果).*不执行\s*真实的文件读取/s,
  );
  assert.match(
    prologue.source,
    /`packages\/pi-course\/`.*引导重建.*`workshop\/`.*最终参考实现/s,
  );
  assert.match(
    prologue.source,
    /`model_start`.*`tool_start`.*运行轨迹事件.*不是.*`AgentMessage`/s,
  );
  assert.doesNotMatch(prologue.source, /被接受的 tool call/);
});
