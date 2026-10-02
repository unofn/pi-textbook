import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const courseRoot = process.env.PI_COURSE_ROOT
  ? path.resolve(process.env.PI_COURSE_ROOT)
  : path.resolve(import.meta.dirname, "..", "..", "pi-course");

function createPractice(chapter, output) {
  return spawnSync(
    "npm",
    [
      "run",
      "practice",
      "-w",
      "@pi/course",
      "--",
      chapter,
      output,
    ],
    {
      cwd: courseRoot,
      encoding: "utf8",
    },
  );
}

test("practice helper creates an answer-free chapter sandbox", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-practice-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const chapter00 = path.join(root, "chapter-00");
  const observed = createPractice("00", chapter00);
  assert.equal(observed.status, 0, observed.stderr);
  assert.equal(
    existsSync(
      path.join(
        chapter00,
        "packages/pi-course/src/demo/prologue.ts",
      ),
    ),
    true,
  );
  assert.equal(
    existsSync(
      path.join(
        chapter00,
        "packages/pi-course/test/01-typescript-survival.test.ts",
      ),
    ),
    false,
  );
  const chapter00Guide = await readFile(
    path.join(chapter00, "LEARNING.md"),
    "utf8",
  );
  assert.match(chapter00Guide, /模式：观察/);
  assert.match(
    chapter00Guide,
    /没有额外 Git 历史或另一份答案可供偷看/,
  );
  assert.doesNotMatch(chapter00Guide, /没有 target 实现可供偷看/);
  const chapter00RootPackage = JSON.parse(
    await readFile(path.join(chapter00, "package.json"), "utf8"),
  );
  assert.equal(
    chapter00RootPackage.scripts?.prepare,
    undefined,
    "isolated sandboxes must not run a Git-only Husky prepare hook",
  );

  const chapter01 = path.join(root, "chapter-01");
  const reconstructed = createPractice("01", chapter01);
  assert.equal(reconstructed.status, 0, reconstructed.stderr);
  assert.equal(
    existsSync(
      path.join(
        chapter01,
        "packages/pi-course/src/survival/events.ts",
      ),
    ),
    false,
  );
  assert.equal(
    existsSync(
      path.join(
        chapter01,
        "packages/pi-course/test/01-typescript-survival.test.ts",
      ),
    ),
    true,
  );
  const chapter01Guide = await readFile(
    path.join(chapter01, "LEARNING.md"),
    "utf8",
  );
  assert.match(chapter01Guide, /模式：重建/);
  assert.match(chapter01Guide, /当前源码来自 parent/);
  assert.match(
    await readFile(
      path.join(chapter01, "packages/pi-course/AGENT_GUIDE.md"),
      "utf8",
    ),
    /Checkpoint 01/,
    "a parent sandbox must still receive the current chapter coaching guide",
  );

  const duplicate = createPractice("01", chapter01);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /已存在/);

  const chapter02 = path.join(root, "chapter-02");
  const eventStream = createPractice("02", chapter02);
  assert.equal(eventStream.status, 0, eventStream.stderr);
  const chapter02Test = await readFile(
    path.join(
      chapter02,
      "packages/pi-course/test/02-event-stream.test.ts",
    ),
    "utf8",
  );
  assert.match(
    chapter02Test,
    /events\.end\("A"\);[\s\S]*await events\.result\(\)[\s\S]*"A"/,
    "end(result) must be observed through result(), not only iterator.done",
  );
  assert.equal(
    [...chapter02Test.matchAll(/\(event: Event\) =>/g)].length,
    2,
    "callback types must keep the expected first red focused on the missing module",
  );

  const chapter03 = path.join(root, "chapter-03");
  const messageIr = createPractice("03", chapter03);
  assert.equal(messageIr.status, 0, messageIr.stderr);
  const chapter03Test = await readFile(
    path.join(
      chapter03,
      "packages/pi-course/test/03-message-ir.test.ts",
    ),
    "utf8",
  );
  assert.match(
    chapter03Test,
    /const result = await stream\.result\(\);[\s\S]*assert\.strictEqual\(\s*result,\s*error\s*\)/,
    "the error terminal test must prove that result() resolves the final message",
  );
  assert.doesNotMatch(
    chapter03Test,
    /stream\.end\(error\)/,
    "the test must not complete the stream on behalf of a broken terminal detector",
  );
  assert.match(
    chapter03Test,
    /\{\s*timeout:\s*1_000\s*\}/,
    "the terminal regression must fail promptly instead of hanging",
  );

  const chapter04 = path.join(root, "chapter-04");
  const scriptedModel = createPractice("04", chapter04);
  assert.equal(scriptedModel.status, 0, scriptedModel.stderr);
  const chapter04Test = await readFile(
    path.join(
      chapter04,
      "packages/pi-course/test/04-scripted-model.test.ts",
    ),
    "utf8",
  );
  assert.match(
    chapter04Test,
    /context\.messages\.push[\s\S]*model\.requests\[0\][\s\S]*messages/,
    "the recorded request must be tested as a call-time snapshot",
  );
  assert.match(
    chapter04Test,
    /partialText:\s*"正在"[\s\S]*errorMessage:\s*"rate limited"/,
    "an explicit error turn must preserve partial output and its diagnostic",
  );
  assert.ok(
    [...chapter04Test.matchAll(/\{\s*timeout:\s*1_000\s*\}/g)].length >= 3,
    "all three streaming regressions must fail promptly",
  );
  assert.match(
    chapter04Test,
    /textDelta\.contentIndex,\s*0[\s\S]*textDelta\.delta,\s*"先看"[\s\S]*textDelta\.partial\.content/,
    "the success oracle must inspect event payloads, not only event type names",
  );
  assert.match(
    chapter04Test,
    /toolDelta\.contentIndex,\s*1[\s\S]*toolDelta\.delta[\s\S]*toolDelta\.partial\.content[\s\S]*toolEnd\.toolCall/,
    "tool deltas and completion must preserve their index, cumulative partial, and canonical call",
  );
  assert.match(
    chapter04Test,
    /secondStream[\s\S]*textOf\([\s\S]*"第二轮"/,
    "the scripted cursor must be observed across two successive turns",
  );

  const chapter05 = path.join(root, "chapter-05");
  const providerAdapter = createPractice("05", chapter05);
  assert.equal(providerAdapter.status, 0, providerAdapter.stderr);
  const chapter05Test = await readFile(
    path.join(
      chapter05,
      "packages/pi-course/test/05-provider-adapter.test.ts",
    ),
    "utf8",
  );
  const chapter05Starter = await readFile(
    path.join(
      chapter05,
      "packages/pi-course/src/provider-adapter.ts",
    ),
    "utf8",
  );
  const chapter05Guide = await readFile(
    path.join(chapter05, "LEARNING.md"),
    "utf8",
  );
  assert.match(chapter05Guide, /学习脚手架/);
  assert.match(chapter05Guide, /不属于 parent，也不是完整 target/);
  assert.match(chapter05Starter, /Lab 5\.1 toProviderMessages/);
  assert.match(chapter05Starter, /Lab 5\.2 createOpenAICompatibleModel/);
  assert.match(chapter05Starter, /Lab 5\.3 createOpenAICompatibleTransport/);
  assert.doesNotMatch(
    chapter05Starter,
    /readSSEData|toolBuffers|fetchImplementation/,
    "the scaffold must expose the public surface without leaking core implementation",
  );
  assert.ok(
    [...chapter05Test.matchAll(/\{\s*timeout:\s*1_000\s*\}/g)].length >= 10,
    "every asynchronous provider regression must fail promptly",
  );
  assert.match(
    chapter05Test,
    /assert\.deepEqual\(\s*messages,\s*\[/,
    "the outbound oracle must compare complete wire messages",
  );
  assert.match(
    chapter05Test,
    /call\?\.type === "toolCall" \? call\.arguments[\s\S]*rawArguments/,
    "length must keep incomplete arguments untrusted",
  );
  assert.match(
    chapter05Test,
    /doesNotMatch\([\s\S]*JSON\.stringify\(body\)[\s\S]*offline-test-key/,
    "the fetch body must be checked for API-key leakage",
  );
  assert.match(
    chapter05Test,
    /normalized transport[\s\S]*contentIndex/s,
    "normalized chunks need an adapter-only content-index oracle",
  );
  assert.match(chapter05Test, /toolcall_end/);

  const chapter06 = path.join(root, "chapter-06");
  const toolContract = createPractice("06", chapter06);
  assert.equal(toolContract.status, 0, toolContract.stderr);
  const chapter06Test = await readFile(
    path.join(
      chapter06,
      "packages/pi-course/test/06-tool-contract.test.ts",
    ),
    "utf8",
  );
  const chapter06Starter = await readFile(
    path.join(chapter06, "packages/pi-course/src/tool.ts"),
    "utf8",
  );
  const chapter06Guide = await readFile(
    path.join(chapter06, "LEARNING.md"),
    "utf8",
  );
  assert.match(chapter06Guide, /学习脚手架/);
  assert.match(chapter06Starter, /Lab 6\.1 stringValue/);
  assert.match(chapter06Starter, /Lab 6\.2 ToolRegistry/);
  assert.match(chapter06Starter, /Lab 6\.3 executeToolCall/);
  assert.doesNotMatch(
    chapter06Starter,
    /new Map|failedResult|Object\.fromEntries/,
    "the starter may expose signatures but not registry, result, or schema algorithms",
  );
  assert.equal(
    [...chapter06Test.matchAll(/test\(/g)].length,
    4,
    "chapter 06 must expose four independently named proofs",
  );
  assert.match(chapter06Test, /assert\.throws[\s\S]*Tool 已存在/);
  assert.match(
    chapter06Test,
    /executionCount[\s\S]*invalid[\s\S]*executionCount,\s*1/,
    "invalid arguments must be proved not to reach execute",
  );
  assert.match(
    chapter06Test,
    /seenContext[\s\S]*signal[\s\S]*reportProgress[\s\S]*details[\s\S]*isError/s,
    "the executor oracle must inspect its complete context and output",
  );

  const chapter07 = path.join(root, "chapter-07");
  const agentLoop = createPractice("07", chapter07);
  assert.equal(agentLoop.status, 0, agentLoop.stderr);
  const chapter07Test = await readFile(
    path.join(
      chapter07,
      "packages/pi-course/test/07-agent-loop.test.ts",
    ),
    "utf8",
  );
  const chapter07Starter = await readFile(
    path.join(chapter07, "packages/pi-course/src/agent-loop.ts"),
    "utf8",
  );
  const chapter07Guide = await readFile(
    path.join(chapter07, "LEARNING.md"),
    "utf8",
  );
  assert.match(chapter07Guide, /学习脚手架/);
  for (const lab of ["7.1", "7.2", "7.3", "7.4", "7.5"]) {
    assert.match(chapter07Starter, new RegExp(`Lab ${lab.replace(".", "\\.")}`));
  }
  assert.match(chapter07Starter, /throw labError/);
  assert.doesNotMatch(
    chapter07Starter,
    /Promise\.all\(|Tool call was not executed/,
    "the starter may expose the control surface but not concurrency or skipped-result algorithms",
  );
  assert.ok(
    [...chapter07Test.matchAll(/test\(/g)].length >= 8,
    "chapter 07 must expose at least eight independently named proofs",
  );
  assert.match(
    chapter07Test,
    /纯文本 stop[\s\S]*systemPrompt[\s\S]*definitions|纯文本 stop[\s\S]*definitions[\s\S]*systemPrompt/s,
    "the first stage must observe the complete model request",
  );
  assert.match(
    chapter07Test,
    /\["tool_start",\s*"tool_progress",\s*"tool_end"\]/,
    "the single-tool proof must lock the relative lifecycle event order",
  );
  assert.match(
    chapter07Test,
    /context[\s\S]*deepEqual[\s\S]*turn_end|turn_end[\s\S]*deepEqual[\s\S]*context/s,
    "the loop must preserve caller ownership and emit one terminal event",
  );
  assert.match(
    chapter07Test,
    /非执行终态[\s\S]*length[\s\S]*aborted[\s\S]*unexpected-stop/s,
    "all non-executing terminal branches need paired-result evidence",
  );
  assert.match(
    chapter07Test,
    /并发工具[\s\S]*(?:deferred|Deferred|release)[\s\S]*(?:reject|rejection)/s,
    "concurrency tests must use controlled gates and cover injected rejection",
  );
  assert.match(
    chapter07Test,
    /取消与上限[\s\S]*AbortController[\s\S]*maxSteps/s,
    "pre-cancel, post-tool cancel, and maxSteps need deterministic evidence",
  );

  const chapter08 = path.join(root, "chapter-08");
  const codingTools = createPractice("08", chapter08);
  assert.equal(codingTools.status, 0, codingTools.stderr);
  const chapter08Test = await readFile(
    path.join(
      chapter08,
      "packages/pi-course/test/08-coding-tools.test.ts",
    ),
    "utf8",
  );
  const chapter08Starter = await readFile(
    path.join(
      chapter08,
      "packages/pi-course/src/coding-tools.ts",
    ),
    "utf8",
  );
  const chapter08Guide = await readFile(
    path.join(chapter08, "LEARNING.md"),
    "utf8",
  );
  assert.match(chapter08Guide, /学习脚手架/);
  for (const lab of ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"]) {
    assert.match(chapter08Starter, new RegExp(`Lab ${lab.replace(".", "\\.")}`));
  }
  assert.match(chapter08Starter, /Lab 8\.1 Read/);
  assert.match(chapter08Starter, /class MutationQueue/);
  assert.doesNotMatch(
    chapter08Starter,
    /node:(?:fs|child_process)|realpath|rename|spawn\(/,
    "the starter may expose public shapes and construction sites but not filesystem or process algorithms",
  );
  assert.equal(
    [...chapter08Test.matchAll(/test\(/g)].length,
    12,
    "chapter 08 must expose twelve independently named proofs",
  );
  assert.match(chapter08Test, /offset=5 超出文件范围/);
  assert.match(
    chapter08Test,
    /offset=2[\s\S]*detailsOf<ReadDetails>\(first\)\.endLine,\s*1[\s\S]*read-second[\s\S]*offset:\s*2/s,
    "Read must derive continuation from the last complete output line",
  );
  assert.match(
    chapter08Test,
    /outside-read[\s\S]*outside-write[\s\S]*outside-edit[\s\S]*symlink-read[\s\S]*symlink-write[\s\S]*symlink-edit/s,
    "all three file tools must share the external-path and symlink boundary",
  );
  assert.match(
    chapter08Test,
    /recordMutationRuns[\s\S]*queue === mutationRuns\[0\]\?\.queue[\s\S]*firstStarted[\s\S]*releaseFirst/s,
    "queue identity, wiring, and scheduling must use instrumentation plus a controlled Promise gate",
  );
  assert.doesNotMatch(
    chapter08Test,
    /16_000_000|setImmediate/,
    "queue evidence must not depend on a large write or scheduler timing",
  );
  assert.match(
    chapter08Test,
    /started\.txt[\s\S]*assert\.rejects\(access\(marker\)/s,
    "pre-cancel must prove the command did not create its environment marker",
  );
  assert.match(
    chapter08Test,
    /hardLinkWitness[\s\S]*write-rename-failure[\s\S]*\.pi-tmp-/s,
    "Write must distinguish replacement from direct mutation and observe failure cleanup",
  );
  assert.match(
    chapter08Test,
    /bash-guard-parent[\s\S]*bash-guard-absolute[\s\S]*outsideMarker/s,
    "the Bash guardrail must prove blocked commands do not create an outside marker",
  );
  assert.match(
    chapter08Test,
    /maxBashOutputBytes[\s\S]*stdout\.write[\s\S]*stderr\.write[\s\S]*Buffer\.byteLength\(outputOf\(result\)\)[\s\S]*运行中的取消/s,
    "Bash must prove the shared captured-output cap and runtime cancellation separately",
  );
  assert.match(
    chapter08Test,
    /timeout-stopped\.txt[\s\S]*cancel-stopped\.txt[\s\S]*descendant-ready\.txt[\s\S]*descendant-survived\.txt/s,
    "Bash termination must wait for direct cleanup and stop a same-group descendant on POSIX",
  );
  assert.match(
    chapter08Test,
    /真 Agent 循环[\s\S]*loop-read[\s\S]*loop-edit[\s\S]*loop-bash[\s\S]*run\.messages/s,
    "the final stage must observe real environment changes and call/result pairing",
  );

  const chapter09 = path.join(root, "chapter-09");
  const statefulAgent = createPractice("09", chapter09);
  assert.equal(statefulAgent.status, 0, statefulAgent.stderr);
  const chapter09Test = await readFile(
    path.join(
      chapter09,
      "packages/pi-course/test/09-stateful-agent.test.ts",
    ),
    "utf8",
  );
  const chapter09AgentStarter = await readFile(
    path.join(chapter09, "packages/pi-course/src/agent.ts"),
    "utf8",
  );
  const chapter09LoopStarter = await readFile(
    path.join(chapter09, "packages/pi-course/src/agent-loop.ts"),
    "utf8",
  );
  const chapter09Guide = await readFile(
    path.join(chapter09, "LEARNING.md"),
    "utf8",
  );

  assert.match(chapter09Guide, /packages\/pi-course\/src\/agent\.ts/);
  assert.match(chapter09Guide, /packages\/pi-course\/src\/agent-loop\.ts/);
  for (const lab of ["9.1", "9.2", "9.3", "9.4", "9.5"]) {
    const pattern = new RegExp(`Lab ${lab.replace(".", "\\.")}`);
    assert.match(chapter09AgentStarter, pattern);
  }
  for (const lab of ["9.2", "9.3", "9.4", "9.5"]) {
    const pattern = new RegExp(`Lab ${lab.replace(".", "\\.")}`);
    assert.match(chapter09LoopStarter, pattern);
  }
  assert.doesNotMatch(
    chapter09AgentStarter,
    /structuredClone|new Set|new AbortController|splice\(|pendingEvents|dispatchingEvents/,
    "the Agent starter may expose public ownership surfaces but not lifecycle algorithms",
  );
  assert.doesNotMatch(
    chapter09LoopStarter,
    /canonicalToolResult|failedModelTurn|messages\.push\(\.\.\.(?:steering|followUps)\)/,
    "the loop starter must preserve prior chapters without leaking Chapter 09 answers",
  );
  assert.equal(
    [...chapter09Test.matchAll(/test\(/g)].length,
    12,
    "chapter 09 must expose twelve independently named proofs",
  );
  assert.match(
    chapter09Test,
    /ThrowOnSecondRequestModel[\s\S]*write committed[\s\S]*provider stream failed/s,
    "model failure after a tool effect must preserve the completed transcript",
  );
  assert.match(
    chapter09Test,
    /parallel third[\s\S]*Agent is busy[\s\S]*run_start:1[\s\S]*run_end:1[\s\S]*run_start:2[\s\S]*run_end:2/s,
    "run-end reentry must keep ownership and global event order",
  );
  assert.match(
    chapter09Test,
    /broken renderer[\s\S]*unsubscribeBroken\(\)[\s\S]*observedStarts,\s*2[\s\S]*unsubscribeObserver\(\)/s,
    "a broken listener and selective unsubscribe must not block later observers",
  );
  assert.match(
    chapter09Test,
    /uncloneable-details[\s\S]*not cloneable[\s\S]*structured-cloneable[\s\S]*status,\s*"idle"/s,
    "non-cloneable tool details must become a canonical result without splitting state",
  );
  assert.match(
    chapter09Test,
    /ManualModel\(false\)[\s\S]*cancelledText\.reason,\s*"aborted"/s,
    "the loop must settle cancellation even when the model ignores its signal",
  );
  assert.match(
    chapter09Test,
    /must not consume before abort[\s\S]*doesNotMatch[\s\S]*must not consume/s,
    "abort must win over text-stop queue consumption",
  );
  assert.match(
    chapter09Test,
    /must not consume after tool[\s\S]*doesNotMatch[\s\S]*retry after abort/s,
    "abort must win after a tool batch and leave the next run clean",
  );
});
