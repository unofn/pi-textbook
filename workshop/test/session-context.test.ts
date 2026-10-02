import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContext,
  compact,
  safeTail,
} from "../src/context.js";
import {
  InMemorySessionStore,
  pathTo,
  recoverJsonl,
  type SessionEntry,
} from "../src/session.js";
import {
  assistantMessage,
  text,
  textOf,
  userMessage,
  type AgentMessage,
} from "../src/types.js";

function entry(
  id: string,
  parentId: string | null,
  message: AgentMessage,
): SessionEntry {
  return {
    id,
    parentId,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    type: "message",
    message,
  };
}

test("parent pointer 形成分支，重复 id、缺 parent、环都可诊断", () => {
  const entries = [
    entry("e1", null, userMessage("root")),
    entry("e2", "e1", assistantMessage([text("left")])),
    entry("e3", "e1", assistantMessage([text("right")])),
  ];
  assert.deepEqual(pathTo(entries, "e2").map((item) => item.id), [
    "e1",
    "e2",
  ]);
  assert.throws(() => pathTo([...entries, entries[0]], "e2"), /重复/);
  assert.throws(
    () => pathTo([entry("x", "missing", userMessage("x"))], "x"),
    /parent 缺失/,
  );
  assert.throws(
    () =>
      pathTo(
        [
          entry("a", "b", userMessage("a")),
          entry("b", "a", userMessage("b")),
        ],
        "a",
      ),
    /形成环/,
  );
});
test("JSONL 只容忍最后一行截断，不掩盖中段损坏", () => {
  const valid = JSON.stringify(entry("e1", null, userMessage("root")));
  const recovered = recoverJsonl(`${valid}\n{"id":`);
  assert.equal(recovered.entries.length, 1);
  assert.equal(recovered.warnings.length, 1);
  assert.throws(() => recoverJsonl(`${valid}\nBAD\n${valid}\n`), /中段/);
});

test("safe cut point 不拆散 assistant toolCall 与 toolResult", () => {
  const messages: AgentMessage[] = [
    userMessage("old"),
    assistantMessage(
      [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "a" },
        },
      ],
      "toolUse",
    ),
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [text("A")],
      isError: false,
      timestamp: 2,
    },
  ];
  const selected = safeTail(messages, 1, () => 1);
  assert.deepEqual(selected.map((message) => message.role), [
    "assistant",
    "toolResult",
  ]);
});

test("compaction 追加 summary，历史仍完整，context 只做投影", async () => {
  const store = new InMemorySessionStore();
  const entries = [
    entry("s0", null, { role: "system", content: "system", timestamp: 0 }),
    entry("e1", "s0", userMessage("goal")),
    entry("e2", "e1", assistantMessage([text("decision")])),
  ];
  for (const item of entries) await store.append(item);
  const summarized: AgentMessage[][] = [];
  const compacted = await compact({
    store,
    leafId: "e2",
    id: "c1",
    summarizer: {
      async summarize(messages) {
        summarized.push(messages);
        return {
          goal: "build pi",
          decisions: ["append-only"],
          files: ["src/session.ts"],
          nextSteps: ["resume"],
          invariants: ["history is truth"],
        };
      },
    },
  });

  // 摘要输入、compactedEntryIds 都不含 system message。
  assert.deepEqual(
    summarized[0].map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(compacted.compactedEntryIds.includes("s0"), false);

  const after = await store.entries();
  assert.equal(after.length, 4);
  assert.equal(after[0].id, "s0");
  const projection = buildContext(after, compacted.id, {
    tokenBudget: 100,
  });
  assert.deepEqual(
    projection.messages.map((message) => message.role),
    ["system", "user", "user", "assistant"],
  );
  assert.equal(projection.messages[0].role === "system" && projection.messages[0].content, "system");
  assert.match(textOf(projection.messages[1]), /Earlier session summary/);
  assert.deepEqual(projection.context.messages, projection.messages);
});

test("strict parser 接受 system message entry，并校验 content 与 sections", () => {
  const system = entry("s1", null, {
    role: "system",
    content: "base",
    sections: { resources: "index", removed: null },
    timestamp: 1,
  });
  const user = entry("u2", "s1", userMessage("hi"));
  const recovered = recoverJsonl(
    `${JSON.stringify(system)}\n${JSON.stringify(user)}\n`,
  );
  assert.deepEqual(recovered.entries, [system, user]);
  assert.deepEqual(recovered.warnings, []);

  const bad = (message: unknown) =>
    `${JSON.stringify({ ...system, message })}\n${JSON.stringify(user)}\n`;
  assert.throws(
    () => recoverJsonl(bad({ role: "system", content: ["x"], timestamp: 1 })),
    /content 必须是字符串/,
  );
  assert.throws(
    () =>
      recoverJsonl(
        bad({ role: "system", content: "", sections: { a: 1 }, timestamp: 1 }),
      ),
    /string 或 null/,
  );
  assert.throws(
    () => recoverJsonl(bad({ role: "developer", content: "", timestamp: 1 })),
    /未知 message role/,
  );
});

test("buildContext 跨 compaction 重放全部 system message，补丁不进入分组", () => {
  const activePath: SessionEntry[] = [
    entry("s1", null, {
      role: "system",
      content: "base",
      sections: { resources: "old" },
      timestamp: 1,
    }),
    entry("u2", "s1", userMessage("old goal")),
    entry("a3", "u2", assistantMessage([text("old answer")])),
    entry("s4", "a3", {
      role: "system",
      content: "",
      sections: { resources: "new", mode: "review" },
      timestamp: 4,
    }),
    entry("u5", "s4", userMessage("current goal")),
    entry("a6", "u5", assistantMessage([text("current answer")])),
    {
      id: "c7",
      parentId: "a6",
      timestamp: 7,
      type: "compaction",
      summary: {
        goal: "g",
        decisions: [],
        files: [],
        nextSteps: [],
        invariants: [],
      },
      compactedEntryIds: ["u2", "a3"],
      firstKeptEntryId: "u5",
      tokensBefore: 10,
    } as SessionEntry,
    entry("s8", "c7", {
      role: "system",
      content: "",
      sections: { mode: null },
      timestamp: 8,
    }),
    entry("u9", "s8", userMessage("next")),
  ];

  const projection = buildContext(activePath, {
    tokenBudget: 100,
    estimateTokens: () => 1,
    estimateTextTokens: () => 3,
  });
  assert.deepEqual(projection.messages[0], {
    role: "system",
    content: "base",
    sections: { resources: "new" },
    timestamp: 1,
  });
  assert.deepEqual(
    projection.messages.map((message) => message.role),
    ["system", "user", "user", "assistant", "user"],
  );
  assert.deepEqual(projection.sourceEntryIds, [
    "s1",
    "s4",
    "s8",
    "c7",
    "u5",
    "a6",
    "u9",
  ]);
  assert.deepEqual(projection.omittedEntryIds, ["u2", "a3"]);
  assert.equal(projection.firstKeptEntryId, "u5");
  // system 是固定成本：单独计入 usage.system，不计入 messages。
  assert.equal(projection.usage.system, 3);
  assert.equal(projection.usage.messages, 4);
  assert.equal(projection.usage.total, 7);
});
