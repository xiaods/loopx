// <!-- loopx-managed-slash-command:v1 command=/loopx surface=pi-extension -->
//
// LoopX Pi goal extension — the Pi host adapter for LoopX.
//
// Pi is a terminal coding agent whose extensions register commands, tools, and
// event handlers. This extension gives a Pi session a LoopX surface:
//
// - `/loopx` inspects the project packet, or starts a guided LoopX goal when
//   arguments are provided.
// - `loopx_goal_activate` binds the current session to a LoopX goal after
//   `loopx start-goal` wrote todos and produced a heartbeat task_body.
// - Once bound, every `agent_settled` continuation runs through
//   `loopx quota should-run --runtime-profile generic_cli`; LoopX decides
//   whether to continue (injecting the heartbeat task_body as a follow-up),
//   wait with backoff, or stop at a validated terminal no-follow-up.
//
// The extension is self-contained: pi's extension loader aliases `typebox` and
// the `@earendil-works/*` packages, so no local node_modules are required.
// The loop never self-declares closure: only LoopX-derived terminal state
// stops auto-continuation, and quota probe failures fail closed with a bounded
// retry instead of guessing.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";

const execFile = promisify(execFileCallback);

const BRIDGE_SCHEMA_VERSION = "loopx_pi_goal_bridge_v0";
const TERMINAL_STATE_SCHEMA_VERSION = "goal_terminal_state_v0";
const SOURCE_COMPLETENESS_SCHEMA_VERSION = "goal_terminal_source_completeness_v0";
const DEFAULT_RETRY_MINUTES = 3;
const LOOPX_CLI_TIMEOUT_MS = 30_000;

interface Binding {
  schemaVersion: string;
  sessionKey: string;
  directory: string;
  goalId: string;
  agentId: string;
  registryPath: string;
  availableCapabilities: string[];
  taskBody: string;
  autoResume: boolean;
  terminal: boolean;
  schedulerToken: string;
  unchangedPolls: number;
  lastInjectedPrompt: string;
  updatedAt: string;
}

function sanitizedKey(value: string | null | undefined): string {
  const cleaned = String(value || "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 160);
  return cleaned || "session";
}

function stateRoot(directory: string): string {
  if (process.env.LOOPX_PI_STATE_DIR) {
    return path.resolve(process.env.LOOPX_PI_STATE_DIR);
  }
  return path.join(directory, ".loopx", "pi");
}

// File-backed binding store scoped to one project. Bindings live under the
// gitignored `.loopx/` tree so they survive Pi restarts without touching
// tracked repository state.
function createStore(directory: string) {
  const root = stateRoot(directory);
  const target = (key: string) => path.join(root, `${sanitizedKey(key)}.json`);
  return {
    async read(key: string): Promise<Binding | null> {
      try {
        const payload = JSON.parse(await fs.readFile(target(key), "utf8"));
        if (payload?.schemaVersion !== BRIDGE_SCHEMA_VERSION || payload?.sessionKey !== key) {
          return null;
        }
        return payload as Binding;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(key: string, changes: Partial<Binding>): Promise<Binding> {
      const current = await this.read(key);
      const payload: Binding = {
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        sessionKey: key,
        directory,
        goalId: "",
        agentId: "",
        registryPath: "",
        availableCapabilities: [],
        taskBody: "",
        autoResume: true,
        terminal: false,
        schedulerToken: "",
        unchangedPolls: 0,
        lastInjectedPrompt: "",
        updatedAt: new Date().toISOString(),
        ...(current || {}),
        ...changes,
        updatedAt: new Date().toISOString(),
      };
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const destination = target(key);
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temporary, destination);
      return payload;
    },
    async remove(key: string): Promise<void> {
      try {
        await fs.unlink(target(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
    },
  };
}

async function runLoopxCli(args: string[], directory: string): Promise<string> {
  const { stdout } = await execFile(process.env.LOOPX_BIN || "loopx", args, {
    cwd: directory,
    timeout: LOOPX_CLI_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

// Mirrors the OpenCode bridge probe: LoopX quota should-run is the only
// continuation authority for the visible goal loop.
async function probeLoopxQuota(binding: Binding): Promise<Record<string, unknown>> {
  const args: string[] = [];
  if (binding.registryPath) args.push("--registry", binding.registryPath);
  args.push(
    "--format",
    "json",
    "quota",
    "should-run",
    "--goal-id",
    binding.goalId,
    "--runtime-profile",
    "generic_cli",
    "--include-detail",
    "scheduler",
  );
  if (binding.agentId) args.push("--agent-id", binding.agentId);
  for (const capability of binding.availableCapabilities || []) {
    args.push("--available-capability", capability);
  }
  const stdout = await runLoopxCli(args, binding.directory);
  const decision: unknown = JSON.parse(stdout || "{}");
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error("loopx quota should-run returned a non-object payload");
  }
  return decision as Record<string, unknown>;
}

function isTerminalNoFollowup(decision: Record<string, unknown>): boolean {
  const frontier = decision?.goal_frontier_projection as Record<string, unknown> | undefined;
  const terminal = frontier?.terminal_state as Record<string, unknown> | undefined;
  const completeness = frontier?.source_completeness as Record<string, unknown> | undefined;
  return Boolean(
    decision?.should_run === false &&
      decision?.effective_action === "terminal_no_followup" &&
      terminal?.schema_version === TERMINAL_STATE_SCHEMA_VERSION &&
      terminal?.kind === "no_followup" &&
      terminal?.derived === true &&
      terminal?.source === "validated_goal_closure" &&
      completeness?.schema_version === SOURCE_COMPLETENESS_SCHEMA_VERSION &&
      completeness?.user_todos === "valid" &&
      completeness?.agent_todos === "valid",
  );
}

function shouldRunNow(decision: Record<string, unknown>): boolean {
  const hint = decision?.scheduler_hint as Record<string, unknown> | undefined;
  return hint?.action === "run_now" || decision?.should_run === true;
}

function waitPlan(
  decision: Record<string, unknown>,
  binding: Binding,
): { stop: boolean; minutes: number; schedulerToken: string; unchangedPolls: number } {
  const hint = (decision?.scheduler_hint || {}) as Record<string, unknown>;
  const unchanged = (hint?.unchanged_poll || {}) as Record<string, unknown>;
  const local = unchanged?.local_scheduler as Record<string, unknown> | string | undefined;
  if (!local || local === "stop") {
    return {
      stop: true,
      minutes: DEFAULT_RETRY_MINUTES,
      schedulerToken: binding.schedulerToken,
      unchangedPolls: binding.unchangedPolls,
    };
  }
  const reset = (hint?.reset_policy || {}) as Record<string, unknown>;
  const token = String(reset?.reset_token || "");
  const sameIdentity = Boolean(token) && token === binding.schedulerToken;
  const unchangedPolls = sameIdentity ? Number(binding.unchangedPolls || 0) : 0;
  const limit = Number.isInteger(local.unchanged_poll_limit)
    ? Number(local.unchanged_poll_limit)
    : null;
  if (limit !== null && unchangedPolls >= limit) {
    return {
      stop: true,
      minutes: DEFAULT_RETRY_MINUTES,
      schedulerToken: token,
      unchangedPolls: unchangedPolls,
    };
  }
  const progression = Array.isArray(local.example_progression_minutes)
    ? (local.example_progression_minutes as unknown[]).filter((value) => Number(value) > 0)
    : [];
  const fallback = Number(local.recommended_interval_minutes || DEFAULT_RETRY_MINUTES);
  const minutes = progression.length
    ? Number(progression[Math.min(unchangedPolls, progression.length - 1)])
    : fallback;
  return {
    stop: false,
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_RETRY_MINUTES,
    schedulerToken: token,
    unchangedPolls: unchangedPolls + 1,
  };
}

export default function (pi: ExtensionAPI) {
  const timers = new Map<string, NodeJS.Timeout>();
  const evaluations = new Map<string, Promise<void>>();
  let disposed = false;

  // Durable, TUI-only digest of the last inspected LoopX packet. Custom entries
  // never enter LLM context; the agent reads full state through the CLI itself.
  pi.registerEntryRenderer("loopx-packet", (entry, _options, theme) => {
    const data = (entry.data ?? {}) as { text?: string };
    const preview = String(data.text || "").split("\n").slice(0, 3).join("\n");
    return new Text(
      `${theme.fg("accent", "[loopx]")} packet ready:\n${preview || "(empty)"}`,
      0,
      0,
    );
  });

  const keyFor = (ctx: ExtensionContext) =>
    sanitizedKey(ctx.sessionManager.getSessionFile() ?? "session");
  const storeFor = (ctx: ExtensionContext) => createStore(ctx.cwd);

  const cancelScheduled = (key: string) => {
    const timer = timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(key);
  };

  const scheduleEvaluation = (ctx: ExtensionContext, key: string, minutes: number) => {
    if (disposed) return;
    cancelScheduled(key);
    const timer = setTimeout(async () => {
      timers.delete(key);
      if (disposed) return;
      try {
        await evaluateIdle(ctx, key);
      } catch (error) {
        // Evaluation must never crash the host; fail closed with a retry.
        scheduleEvaluation(ctx, key, DEFAULT_RETRY_MINUTES);
      }
    }, Math.max(1, minutes) * 60_000);
    if (typeof (timer as NodeJS.Timeout & { unref?: () => void })?.unref === "function") {
      (timer as NodeJS.Timeout & { unref: () => void }).unref();
    }
    timers.set(key, timer);
  };

  const evaluateIdleOnce = async (ctx: ExtensionContext, key: string) => {
    if (disposed) return;
    const store = storeFor(ctx);
    let binding: Binding | null = null;
    try {
      binding = await store.read(key);
    } catch {
      cancelScheduled(key);
      return;
    }
    if (!binding || binding.terminal) {
      cancelScheduled(key);
      return;
    }
    if (binding.autoResume === false || !ctx.isIdle()) {
      cancelScheduled(key);
      return;
    }

    let decision: Record<string, unknown>;
    try {
      decision = await probeLoopxQuota(binding);
    } catch {
      // Fail closed: never continue without LoopX authority. Bounded retry.
      scheduleEvaluation(ctx, key, DEFAULT_RETRY_MINUTES);
      return;
    }
    if (disposed) return;

    const current = await store.read(key);
    if (
      !current ||
      current.terminal ||
      current.autoResume === false ||
      current.goalId !== binding.goalId
    ) {
      cancelScheduled(key);
      return;
    }

    if (isTerminalNoFollowup(decision)) {
      await store.write(key, { terminal: true, autoResume: false });
      cancelScheduled(key);
      ctx.ui.notify(
        `LoopX goal ${current.goalId} reached validated terminal no-follow-up; loop stopped.`,
        "info",
      );
      return;
    }

    if (shouldRunNow(decision)) {
      cancelScheduled(key);
      await store.write(key, { schedulerToken: "", unchangedPolls: 0 });
      const prompt = current.taskBody || current.goalId;
      await store.write(key, { lastInjectedPrompt: prompt });
      pi.sendUserMessage(prompt, { deliverAs: "followUp", triggerTurn: true });
      return;
    }

    const wait = waitPlan(decision, current);
    if (wait.stop) {
      cancelScheduled(key);
      return;
    }
    await store.write(key, {
      schedulerToken: wait.schedulerToken,
      unchangedPolls: wait.unchangedPolls,
    });
    scheduleEvaluation(ctx, key, wait.minutes);
  };

  const evaluateIdle = (ctx: ExtensionContext, key: string) => {
    if (disposed) return Promise.resolve();
    const existing = evaluations.get(key);
    if (existing) return existing;
    const evaluation = evaluateIdleOnce(ctx, key).finally(() => {
      if (evaluations.get(key) === evaluation) evaluations.delete(key);
    });
    evaluations.set(key, evaluation);
    return evaluation;
  };

  // /loopx — inspect the project packet, or start a guided LoopX goal.
  pi.registerCommand("loopx", {
    description:
      "Inspect LoopX state, or start a concrete LoopX goal when arguments are provided.",
    handler: async (args, ctx) => {
      const trimmed = String(args || "").trim();
      const store = storeFor(ctx);
      const key = keyFor(ctx);
      const binding = await store.read(key).catch(() => null);
      if (
        !trimmed ||
        trimmed === "status" ||
        trimmed === "history" ||
        trimmed === "list" ||
        trimmed === "resume"
      ) {
        if (trimmed === "resume" && binding) {
          await store.write(key, { autoResume: true, terminal: false });
          ctx.ui.notify(`LoopX goal ${binding.goalId} auto-continuation resumed.`, "info");
          return;
        }
        try {
          const stdout = await runLoopxCli(["bootstrap-command-pack", "--project", "."], ctx.cwd);
          ctx.ui.setWidget("loopx", stdout.split("\n").slice(0, 24));
          ctx.ui.notify("LoopX packet ready (widget above the editor).", "info");
          pi.appendEntry("loopx-packet", { text: stdout });
        } catch (error) {
          ctx.ui.notify(
            `LoopX inspect failed: ${(error as Error)?.message || String(error)}`,
            "error",
          );
        }
        return;
      }
      // Start a guided goal for the exact Pi host; the returned packet
      // includes ordered todos and the heartbeat task_body the agent needs.
      try {
        const stdout = await runLoopxCli(
          ["start-goal", "--guided", "--project", ".", "--goal-text", trimmed, "--host-surface", "pi"],
          ctx.cwd,
        );
        ctx.ui.setEditorText(stdout);
        ctx.ui.notify(
          "LoopX start-goal packet ready in the editor; review and send it, then the agent calls loopx_goal_activate.",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `LoopX start-goal failed: ${(error as Error)?.message || String(error)}`,
          "error",
        );
      }
    },
  });

  // loopx_goal_activate — bind this session to a LoopX goal and start the
  // quota-gated auto-continuation loop. Called by the agent after start-goal.
  pi.registerTool({
    name: "loopx_goal_activate",
    label: "Activate LoopX Goal",
    description:
      "Activate a LoopX-backed Pi goal after LoopX start-goal has written todos and produced a heartbeat task_body. The extension then auto-continues through LoopX quota should-run; it never self-declares closure.",
    parameters: Type.Object({
      goalId: Type.String({ description: "LoopX goal id from the start-goal packet (goal_id)." }),
      objective: Type.String({
        description: "Heartbeat task_body from the start-goal packet.",
      }),
      agentId: Type.Optional(
        Type.String({ description: "Registered agent id when present." }),
      ),
      registryPath: Type.Optional(
        Type.String({ description: "Explicit LoopX registry path when present." }),
      ),
      availableCapabilities: Type.Optional(
        Type.Array(Type.String(), { description: "Declared host capabilities when present." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const key = keyFor(ctx);
      const store = storeFor(ctx);
      const binding = await store.write(key, {
        directory: ctx.cwd,
        goalId: String(params.goalId),
        agentId: params.agentId ? String(params.agentId) : "",
        registryPath: params.registryPath ? String(params.registryPath) : "",
        availableCapabilities: Array.isArray(params.availableCapabilities)
          ? params.availableCapabilities.map(String)
          : [],
        taskBody: String(params.objective),
        autoResume: true,
        terminal: false,
        schedulerToken: "",
        unchangedPolls: 0,
        lastInjectedPrompt: "",
      });
      cancelScheduled(key);
      ctx.ui.notify(
        `LoopX goal ${binding.goalId} activated; continuation gated by LoopX quota.`,
        "info",
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              version: 1,
              operation: "loopx_activate",
              ok: true,
              message: "LoopX-backed Pi goal activated.",
              goalId: binding.goalId,
            }),
          },
        ],
        details: {},
      };
    },
  });

  // When the agent settles and a goal is bound, let LoopX decide the next move.
  pi.on("agent_settled", async (_event, ctx) => {
    if (disposed) return;
    const key = keyFor(ctx);
    const store = storeFor(ctx);
    const binding = await store.read(key).catch(() => null);
    if (!binding || binding.terminal || binding.autoResume === false) return;
    await evaluateIdle(ctx, key);
  });

  // User-driven prompts pause the auto loop; only prompts we injected for the
  // same goal keep auto-resume armed.
  pi.on("before_agent_start", async (event, ctx) => {
    const key = keyFor(ctx);
    const store = storeFor(ctx);
    const binding = await store.read(key).catch(() => null);
    if (!binding || binding.terminal) return;
    const prompt = String(event.prompt || "");
    if (prompt !== binding.lastInjectedPrompt) {
      await store.write(key, { autoResume: false });
      cancelScheduled(key);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cancelScheduled(keyFor(ctx));
  });
}
