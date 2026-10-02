import {
  open,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import {
  executeToolCall as executeCoreToolCall,
  type Tool,
  type ToolExecutor,
  type ToolRegistry,
} from "./tool.js";
import {
  text,
  type ToolCall,
  type ToolResultMessage,
} from "./types.js";

interface ResourceBase {
  name: string;
  description: string;
  source: string;
  scope: string;
}

export interface TemplateResource extends ResourceBase {
  kind: "template";
  body: string;
  /**
   * 兼容第 12 章之前的 eager loader 字段。
   */
  content: string;
}

export interface SkillResource extends ResourceBase {
  kind: "skill";
  root: string;
  /**
   * discoverResources 不填正文；activateSkill 或旧 loadResources 才填。
   */
  body?: string;
  content?: string;
}

export type Resource = TemplateResource | SkillResource;
export type TextResource = Resource;

export interface ResourceDiagnostic {
  level: "warning" | "error";
  code:
    | "root_unreadable"
    | "resource_read_failed"
    | "missing_description"
    | "resource_conflict"
    | "skill_not_found"
    | "skill_resource_read_failed";
  message: string;
  source?: string;
  sources?: string[];
}

export interface ResourceCatalog {
  resources: Resource[];
  templates: TemplateResource[];
  skills: SkillResource[];
  diagnostics: ResourceDiagnostic[];
  diagnosticMessages: string[];
}

export interface DiscoveredResourceCatalog extends ResourceCatalog {
  resourceDiagnostics: ResourceDiagnostic[];
}

export interface ResourceRoot {
  path: string;
  scope?: string;
}

export type ResourceRootInput = string | ResourceRoot;

export interface ActivatedSkillFile {
  request: string;
  source: string;
  content: string;
}

export interface ActivatedSkill {
  skill?: SkillResource & { body: string; content: string };
  body?: string;
  source?: string;
  resources: ActivatedSkillFile[];
  diagnostics: ResourceDiagnostic[];
}

interface ParsedFrontmatter {
  attributes: Record<string, string>;
  content: string;
  hasFrontmatter: boolean;
  complete: boolean;
}

interface ResourceCandidate {
  resource: Resource;
  rootOrder: number;
}

function frontmatter(value: string): ParsedFrontmatter {
  const normalized = value.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      attributes: {},
      content: normalized,
      hasFrontmatter: false,
      complete: true,
    };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return {
      attributes: {},
      content: "",
      hasFrontmatter: true,
      complete: false,
    };
  }
  const attributes: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.+)$/);
    if (match) {
      attributes[match[1]] = match[2].replace(
        /^["']|["']$/g,
        "",
      );
    }
  }
  return {
    attributes,
    content: normalized.slice(end + 5).trim(),
    hasFrontmatter: true,
    complete: true,
  };
}

async function readMetadataPrefix(file: string): Promise<ParsedFrontmatter> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const parsed = frontmatter(buffer.subarray(0, bytesRead).toString("utf8"));
    if (parsed.hasFrontmatter && !parsed.complete) {
      throw new Error("frontmatter 超过 64 KiB 或缺少结束分隔符");
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

async function directoryEntries(directory: string): Promise<Dirent[]> {
  return readdir(directory, { withFileTypes: true });
}

async function isDirectoryOrSymlinkToDirectory(
  absolutePath: string,
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
}

function resourceDiagnostic(
  diagnostic: ResourceDiagnostic,
): ResourceDiagnostic {
  return diagnostic;
}

function isMissingDirectory(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function discoverRoot(
  rootInput: ResourceRootInput,
  rootOrder: number,
): Promise<{
  candidates: ResourceCandidate[];
  diagnostics: ResourceDiagnostic[];
}> {
  const configured =
    typeof rootInput === "string"
      ? { path: rootInput, scope: undefined }
      : rootInput;
  const diagnostics: ResourceDiagnostic[] = [];
  const candidates: ResourceCandidate[] = [];
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(configured.path);
  } catch (error) {
    diagnostics.push(
      resourceDiagnostic({
        level: "warning",
        code: "root_unreadable",
        source: path.resolve(configured.path),
        message: `resource root ${configured.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
    return { candidates, diagnostics };
  }
  const scope = configured.scope ?? `root:${rootOrder}`;

  const templateDirectory = path.join(canonicalRoot, "templates");
  try {
    const entries = (await directoryEntries(templateDirectory))
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".md"),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const configuredSource = path.join(templateDirectory, entry.name);
      try {
        const source = await realpath(configuredSource);
        const parsed = frontmatter(await readFile(source, "utf8"));
        if (!parsed.complete) {
          throw new Error("frontmatter 缺少结束分隔符");
        }
        const name =
          parsed.attributes.name ?? path.basename(source, ".md");
        candidates.push({
          rootOrder,
          resource: {
            kind: "template",
            name,
            description: parsed.attributes.description ?? "",
            source,
            scope,
            body: parsed.content,
            content: parsed.content,
          },
        });
      } catch (error) {
        diagnostics.push({
          level: "error",
          code: "resource_read_failed",
          source: configuredSource,
          message: `template ${configuredSource}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  } catch (error) {
    // templates/ 可选；不存在不是诊断，其他失败必须可见。
    if (!isMissingDirectory(error)) {
      diagnostics.push({
        level: "error",
        code: "resource_read_failed",
        source: templateDirectory,
        message: `templates ${templateDirectory}: ${errorMessage(error)}`,
      });
    }
  }

  const skillDirectory = path.join(canonicalRoot, "skills");
  try {
    const entries = (await directoryEntries(skillDirectory)).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const configuredSkillRoot = path.join(
        skillDirectory,
        entry.name,
      );
      if (
        !(await isDirectoryOrSymlinkToDirectory(
          configuredSkillRoot,
          entry,
        ))
      ) {
        continue;
      }
      const configuredSource = path.join(
        configuredSkillRoot,
        "SKILL.md",
      );
      try {
        const source = await realpath(configuredSource);
        const root = await realpath(path.dirname(source));
        const parsed = await readMetadataPrefix(source);
        const name = parsed.attributes.name ?? path.basename(root);
        const description = parsed.attributes.description ?? "";
        const resource: SkillResource = {
          kind: "skill",
          name,
          description,
          source,
          root,
          scope,
        };
        candidates.push({ resource, rootOrder });
        if (!description) {
          diagnostics.push({
            level: "warning",
            code: "missing_description",
            source,
            message: `skill ${name} 缺少 description`,
          });
        }
      } catch (error) {
        diagnostics.push({
          level: "error",
          code: "resource_read_failed",
          source: configuredSource,
          message: `skill ${configuredSource}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  } catch (error) {
    // skills/ 可选；不存在不是诊断，其他失败必须可见。
    if (!isMissingDirectory(error)) {
      diagnostics.push({
        level: "error",
        code: "resource_read_failed",
        source: skillDirectory,
        message: `skills ${skillDirectory}: ${errorMessage(error)}`,
      });
    }
  }

  return { candidates, diagnostics };
}

function catalogFrom(
  resources: Resource[],
  diagnostics: ResourceDiagnostic[],
): DiscoveredResourceCatalog {
  const ordered = [...resources].sort((left, right) =>
    left.source.localeCompare(right.source),
  );
  const orderedDiagnostics = [...diagnostics].sort((left, right) =>
    [
      left.source ?? "",
      left.code,
      left.message,
    ].join("\0").localeCompare(
      [right.source ?? "", right.code, right.message].join("\0"),
    ),
  );
  return {
    resources: ordered,
    templates: ordered.filter(
      (resource): resource is TemplateResource =>
        resource.kind === "template",
    ),
    skills: ordered.filter(
      (resource): resource is SkillResource =>
        resource.kind === "skill",
    ),
    diagnostics: orderedDiagnostics,
    resourceDiagnostics: orderedDiagnostics,
    diagnosticMessages: orderedDiagnostics.map(
      (diagnostic) => diagnostic.message,
    ),
  };
}

/**
 * 只发现 skill 的 metadata；完整正文要等 activateSkill。
 * root 数组的顺序是公开 precedence，同一 root 内再按 canonical source 排序。
 */
export async function discoverResources(
  roots: ResourceRootInput[] | ResourceRootInput,
): Promise<DiscoveredResourceCatalog> {
  const rootInputs = Array.isArray(roots) ? roots : [roots];
  const discovered = await Promise.all(
    rootInputs.map((root, index) => discoverRoot(root, index)),
  );
  const diagnostics = discovered.flatMap((item) => item.diagnostics);
  const candidates = discovered
    .flatMap((item) => item.candidates)
    .sort(
      (left, right) =>
        left.rootOrder - right.rootOrder ||
        left.resource.source.localeCompare(right.resource.source),
    );
  const winners = new Map<string, ResourceCandidate>();
  const allByKey = new Map<string, ResourceCandidate[]>();

  for (const candidate of candidates) {
    const key = `${candidate.resource.kind}:${candidate.resource.name}`;
    const sameSource = allByKey
      .get(key)
      ?.some(
        (item) =>
          item.resource.source === candidate.resource.source,
      );
    if (sameSource) continue;
    const bucket = allByKey.get(key) ?? [];
    bucket.push(candidate);
    allByKey.set(key, bucket);
    if (!winners.has(key)) winners.set(key, candidate);
  }

  for (const [key, conflicts] of allByKey) {
    if (conflicts.length < 2) continue;
    const sources = conflicts.map((item) => item.resource.source);
    diagnostics.push({
      level: "warning",
      code: "resource_conflict",
      source: sources[0],
      sources,
      message: `${key} 冲突；按 root precedence 与 source 排序选择 ${sources[0]}；候选：${sources.join(
        ", ",
      )}`,
    });
  }

  return catalogFrom(
    [...winners.values()].map((candidate) => candidate.resource),
    diagnostics,
  );
}

export async function resolveSkillResource(
  root: string,
  request: string,
): Promise<string> {
  if (request.trim() === "" || path.isAbsolute(request)) {
    throw new Error("skill_resource_outside_root");
  }
  const canonicalRoot = await realpath(root);
  const unresolved = path.resolve(canonicalRoot, request);
  const lexicalRelative = path.relative(canonicalRoot, unresolved);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lexicalRelative)
  ) {
    throw new Error("skill_resource_outside_root");
  }
  const candidate = await realpath(unresolved);
  const relative = path.relative(canonicalRoot, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("skill_resource_outside_root");
  }
  return candidate;
}

export async function activateSkill(
  catalog: ResourceCatalog,
  name: string,
  options: { resources?: string[] } = {},
): Promise<ActivatedSkill> {
  const discovered = catalog.skills.find((skill) => skill.name === name);
  if (!discovered) {
    return {
      resources: [],
      diagnostics: [
        {
          level: "error",
          code: "skill_not_found",
          message: `skill 不存在：${name}`,
        },
      ],
    };
  }

  const diagnostics: ResourceDiagnostic[] = [];
  const resources: ActivatedSkillFile[] = [];
  let parsed: ParsedFrontmatter;
  try {
    parsed = frontmatter(await readFile(discovered.source, "utf8"));
    if (!parsed.complete) {
      throw new Error("frontmatter 缺少结束分隔符");
    }
    resources.push({
      request: "SKILL.md",
      source: discovered.source,
      content: parsed.content,
    });
  } catch (error) {
    diagnostics.push({
      level: "error",
      code: "skill_resource_read_failed",
      source: discovered.source,
      message: `skill ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return { resources, diagnostics };
  }

  const requests = [...new Set(options.resources ?? [])];
  for (const request of requests) {
    try {
      const source = await resolveSkillResource(
        discovered.root,
        request,
      );
      resources.push({
        request,
        source,
        content: await readFile(source, "utf8"),
      });
    } catch (error) {
      diagnostics.push({
        level: "error",
        code: "skill_resource_read_failed",
        source: path.resolve(discovered.root, request),
        message: `skill ${name} resource ${request}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  const activated: SkillResource & {
    body: string;
    content: string;
  } = {
    ...discovered,
    body: parsed.content,
    content: parsed.content,
  };
  return {
    skill: activated,
    body: activated.body,
    source: activated.source,
    resources,
    diagnostics,
  };
}

/**
 * 资源文本在 system message 中占用的具名段落。资源变化时只替换这一段，
 * 基础 prompt 与已经持久化的 transcript 前缀保持不变。
 */
export const RESOURCE_SECTION = "pi-resources";

/**
 * 把资源 metadata 与已激活 skill 的正文渲染成一段文本；没有内容时返回空串。
 * 它只返回文本，由调用方放进 sections[RESOURCE_SECTION]，而不是拼进基础 prompt。
 */
export function formatResourceContext(
  catalog: ResourceCatalog,
  activatedSkills: readonly ActivatedSkill[],
): string {
  const index = [
    ...catalog.templates.map(
      (resource) =>
        `- template ${resource.name}: ${resource.description || "(无描述)"} [${resource.source}]`,
    ),
    ...catalog.skills.map(
      (resource) =>
        `- skill ${resource.name}: ${resource.description || "(无描述)"} [${resource.source}]`,
    ),
  ];
  const active = activatedSkills.flatMap((item) =>
    item.skill
      ? [
          `## Activated skill: ${item.skill.name}\nSource: ${item.skill.source}\n${item.skill.body}`,
        ]
      : [],
  );
  return [
    index.length > 0
      ? `## Available resources\n${index.join("\n")}`
      : "",
    ...active,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 兼容早期 eager API：它显式激活全部 skill。新调用方应优先使用
 * discoverResources + activateSkill，以免所有正文常驻 context。
 */
export async function loadResources(
  root: string,
): Promise<DiscoveredResourceCatalog> {
  const discovered = await discoverResources(root);
  const skills: SkillResource[] = [];
  const diagnostics = [...discovered.resourceDiagnostics];
  for (const skill of discovered.skills) {
    const activated = await activateSkill(discovered, skill.name);
    diagnostics.push(...activated.diagnostics);
    skills.push(activated.skill ?? skill);
  }
  return catalogFrom(
    [...discovered.templates, ...skills],
    diagnostics,
  );
}

export type BeforeToolDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

export interface BeforeToolOutcome {
  decision: "allow" | "deny";
  extensionId?: string;
  reason?: string;
}

export interface HookDiagnostic {
  extensionId: string;
  hook: "beforeToolCall" | "afterToolResult";
  message: string;
}

export type BeforeToolHook = (
  call: Readonly<ToolCall>,
) =>
  | void
  | BeforeToolDecision
  | Promise<void | BeforeToolDecision>;

export type AfterToolHook = (
  result: Readonly<ToolResultMessage>,
) => void | Promise<void>;

export type ExtensionHookMap = {
  beforeToolCall: BeforeToolHook;
  afterToolResult: AfterToolHook;
  /**
   * 兼容旧命名；它们进入同一条有序 hook 链。
   */
  beforeTool: BeforeToolHook;
  afterTool: AfterToolHook;
};

export interface ExtensionContext {
  registerTool(tool: Tool): void;
  on<TKey extends keyof ExtensionHookMap>(
    event: TKey,
    listener: ExtensionHookMap[TKey],
  ): void;
}

export interface ExtensionHost {
  context: ExtensionContext;
  contextFor(extensionId: string): ExtensionContext;
  runBeforeToolCall(call: ToolCall): Promise<BeforeToolOutcome>;
  runAfterToolResult(
    result: ToolResultMessage,
  ): Promise<HookDiagnostic[]>;
  executeToolCall: ToolExecutor;
  wrapExecutor(executor?: ToolExecutor): ToolExecutor;
  runHook<TKey extends keyof ExtensionHookMap>(
    event: TKey,
    value: Parameters<ExtensionHookMap[TKey]>[0],
  ): Promise<void>;
}

export interface ExtensionHostOptions {
  hookTimeoutMs?: number;
}

interface RegisteredBeforeHook {
  extensionId: string;
  listener: BeforeToolHook;
}

interface RegisteredAfterHook {
  extensionId: string;
  listener: AfterToolHook;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function frozenClone<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

async function withHookTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deniedToolResult(
  call: ToolCall,
  outcome: BeforeToolOutcome,
): ToolResultMessage {
  const reason = outcome.reason ?? "extension policy denied this call";
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [
      text(
        `Tool ${call.name} denied by ${
          outcome.extensionId ?? "extension policy"
        }: ${reason}`,
      ),
    ],
    details: {
      denied: true,
      extensionId: outcome.extensionId,
      reason,
    },
    isError: true,
    timestamp: Date.now(),
  };
}

export function createExtensionHost(
  tools: ToolRegistry,
  options: ExtensionHostOptions = {},
): ExtensionHost {
  const beforeHooks: RegisteredBeforeHook[] = [];
  const afterHooks: RegisteredAfterHook[] = [];
  const timeoutMs = options.hookTimeoutMs ?? 1_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("hookTimeoutMs 必须是正整数");
  }

  const contextFor = (extensionId: string): ExtensionContext => ({
    registerTool(tool) {
      tools.register(tool);
    },
    on(event, listener) {
      if (event === "beforeToolCall" || event === "beforeTool") {
        beforeHooks.push({
          extensionId,
          listener: listener as BeforeToolHook,
        });
      } else {
        afterHooks.push({
          extensionId,
          listener: listener as AfterToolHook,
        });
      }
    },
  });

  const runBeforeToolCall = async (
    call: ToolCall,
  ): Promise<BeforeToolOutcome> => {
    for (const hook of beforeHooks) {
      try {
        const decision = await withHookTimeout(
          Promise.resolve(hook.listener(frozenClone(call))),
          timeoutMs,
          `beforeToolCall:${hook.extensionId}`,
        );
        if (decision?.decision === "deny") {
          return {
            decision: "deny",
            extensionId: hook.extensionId,
            reason: decision.reason,
          };
        }
      } catch (error) {
        return {
          decision: "deny",
          extensionId: hook.extensionId,
          reason: `hook_error:${errorMessage(error)}`,
        };
      }
    }
    return { decision: "allow" };
  };

  const runAfterToolResult = async (
    result: ToolResultMessage,
  ): Promise<HookDiagnostic[]> => {
    const diagnostics: HookDiagnostic[] = [];
    for (const hook of afterHooks) {
      try {
        await withHookTimeout(
          Promise.resolve(hook.listener(frozenClone(result))),
          timeoutMs,
          `afterToolResult:${hook.extensionId}`,
        );
      } catch (error) {
        diagnostics.push({
          extensionId: hook.extensionId,
          hook: "afterToolResult",
          message: errorMessage(error),
        });
      }
    }
    return diagnostics;
  };

  const wrapExecutor = (
    executor: ToolExecutor = (call, context) =>
      executeCoreToolCall(call, tools, context),
  ): ToolExecutor => {
    return async (call, context) => {
      const decision = await runBeforeToolCall(call);
      const result =
        decision.decision === "deny"
          ? deniedToolResult(call, decision)
          : await executor(call, context);
      // after hook 只能观察。失败诊断由显式 runAfterToolResult 调用可取得，
      // 但绝不改写已经发生的 tool result。
      await runAfterToolResult(result);
      return result;
    };
  };

  const context = contextFor("manual");
  const host: ExtensionHost = {
    context,
    contextFor,
    runBeforeToolCall,
    runAfterToolResult,
    executeToolCall: undefined as never,
    wrapExecutor,
    async runHook(event, value) {
      if (event === "beforeToolCall" || event === "beforeTool") {
        const outcome = await runBeforeToolCall(value as ToolCall);
        if (outcome.decision === "deny") {
          throw new Error(
            `tool_call_denied:${outcome.extensionId ?? "unknown"}:${
              outcome.reason ?? ""
            }`,
          );
        }
        return;
      }
      await runAfterToolResult(value as ToolResultMessage);
    },
  };
  host.executeToolCall = wrapExecutor();
  return host;
}

export type ExtensionModule = {
  default(context: ExtensionContext): void | Promise<void>;
};

export interface ExtensionSource {
  id: string;
  path: string;
}

export interface ExtensionLoadDiagnostic {
  source: string;
  extensionId: string;
  status: "active" | "skipped_untrusted" | "failed";
  message?: string;
}

export async function loadExtension(
  source: ExtensionSource,
  deps: {
    isTrusted(
      source: ExtensionSource,
    ): boolean | Promise<boolean>;
    importModule(path: string): Promise<ExtensionModule>;
    context?: ExtensionContext;
    host?: ExtensionHost;
  },
): Promise<ExtensionLoadDiagnostic> {
  let trusted: boolean;
  try {
    trusted = await deps.isTrusted(source);
  } catch (error) {
    return {
      source: source.path,
      extensionId: source.id,
      status: "failed",
      message: `trust_check_failed:${errorMessage(error)}`,
    };
  }
  if (!trusted) {
    return {
      source: source.path,
      extensionId: source.id,
      status: "skipped_untrusted",
    };
  }

  const context =
    deps.context ?? deps.host?.contextFor(source.id);
  if (!context) {
    return {
      source: source.path,
      extensionId: source.id,
      status: "failed",
      message: "ExtensionContext 缺失",
    };
  }

  let extension: ExtensionModule;
  try {
    extension = await deps.importModule(source.path);
  } catch (error) {
    return {
      source: source.path,
      extensionId: source.id,
      status: "failed",
      message: `import_failed:${errorMessage(error)}`,
    };
  }
  if (typeof extension.default !== "function") {
    return {
      source: source.path,
      extensionId: source.id,
      status: "failed",
      message: "Extension 必须 default export 一个注册函数",
    };
  }

  try {
    const publicContext = Object.freeze({
      registerTool: context.registerTool.bind(context),
      on: context.on.bind(context),
    }) satisfies ExtensionContext;
    await extension.default(publicContext);
    return {
      source: source.path,
      extensionId: source.id,
      status: "active",
    };
  } catch (error) {
    return {
      source: source.path,
      extensionId: source.id,
      status: "failed",
      message: `factory_failed:${errorMessage(error)}`,
    };
  }
}

/**
 * 兼容旧入口：调用它意味着上层已经完成信任判断。
 */
export async function loadTrustedExtension(
  moduleUrl: string,
  context: ExtensionContext,
): Promise<void> {
  const result = await loadExtension(
    { id: moduleUrl, path: moduleUrl },
    {
      isTrusted: () => true,
      importModule: async (source) =>
        (await import(source)) as ExtensionModule,
      context,
    },
  );
  if (result.status !== "active") {
    throw new Error(result.message ?? result.status);
  }
}
