/**
 * cli-backend — external-CLI advisor calls via async pi.exec.
 *
 * An alternative to the inline `completeSimple` path: pipe the fitted context
 * (as markdown) to an external CLI's stdin (codex / claude / opencode) and parse
 * the reply. Replaces pi-external-advisor's `execSync` with async `pi.exec` —
 * execSync blocks the event loop and would serialize a Promise.all council.
 *
 * The whole point of going async is that a CLI-backed council member can run
 * in parallel with an inline member. A solo CLI call doesn't prove that; the
 * mixed inline+cli council smoke test does.
 *
 * Defensive parsing is load-bearing: real CLIs print deprecation notices,
 * progress warnings, and auth chatter to stdout/stderr before the payload.
 * We don't crash on junk preamble — we scan for the JSON payload (codex/
 * opencode JSONL) or fall back to the whole stdout (claude plain text).
 */

import type { Message } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { deriveInputBudget, estimateTokens } from "./context-engine.js";
import { withTimeout } from "./timeout.js";

export type CliCommand = "codex" | "claude" | "opencode";

/** Pre-baked invocations. Read prompt from stdin (`-` or `-p`). */
const CLI_INVOCATIONS: Record<CliCommand, { command: string; args: string[] }> = {
	codex: { command: "codex", args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"] },
	claude: { command: "claude", args: ["-p", "--tools", ""] },
	opencode: { command: "opencode", args: ["run", "--format", "json", "--pure", "--agent", "bpx-consult"] },
};

export interface CliBackendConfig {
	type: "cli";
	command: CliCommand | string;
	args?: string[];
	timeoutMs?: number;
	/** Preset CLI model override. Omit to use the CLI's configured default. */
	model?: string;
	/** Declared context window (tokens) for a custom CLI whose underlying model
	 * isn't known. Preset commands (codex/claude/opencode) have built-in windows
	 * and don't need this; a custom command MUST declare one or the member is
	 * pre-failed with a clear message rather than silently falling back to a
	 * guessed window (council: 'remove the unverified 32k fallback'). */
	contextWindow?: number;
}

export interface CliCallInput {
	systemPrompt: string;
	/** Fitted, window-safe messages (already through §C). */
	messages: Message[];
	backend: CliBackendConfig;
	signal: AbortSignal | undefined;
	/** Working directory for the subprocess (usually ctx.cwd). */
	cwd?: string;
	/** Reply reserve used by the context fitter; defaults to 4096 for probes. */
	responseReserveTokens?: number;
}

export interface CliCallResult {
	text: string;
	/** Whether the subprocess timed out (res.killed). */
	timedOut: boolean;
	/** Non-zero exit without timeout. */
	exitCode: number | null;
	errorMessage?: string;
}

const DEFAULT_CLI_TIMEOUT_MS = 120_000;

/**
 * Run one CLI advisor call. Never throws — every failure path returns a result
 * with errorMessage set, so a council can collect it as a failed member without
 * a try/catch at every call site.
 *
 * Uses node:child_process.spawn directly (async, non-blocking) rather than
 * pi.exec — pi 0.80.x's ExecOptions doesn't expose stdin, and these CLIs read
 * the prompt from stdin. spawn is the right primitive: it's non-blocking (unlike
 * execSync, which is what makes pi-external-advisor serialize under a council),
 * so a CLI council member runs truly parallel to an inline completeSimple member.
 */
export async function callCliAdvisor(input: CliCallInput): Promise<CliCallResult> {
	const { systemPrompt, messages, backend, signal, cwd } = input;
	if (backend.model && (backend.args?.length || !Object.hasOwn(CLI_INVOCATIONS, backend.command))) {
		return { text: "", timedOut: false, exitCode: null, errorMessage: "CLI model override requires a supported preset without custom args" };
	}
	const inv = resolveInvocation(backend);
	const promptText = buildPromptText(systemPrompt, messages);
	const window = cliContextWindow(backend);
	if (window) {
		const inputBudget = deriveInputBudget(window, { responseReserveTokens: input.responseReserveTokens ?? 4096 });
		const promptTokens = estimateTokens(promptText);
		if (promptTokens > inputBudget) {
			return { text: "", timedOut: false, exitCode: null,
				errorMessage: `CLI "${inv.command}" serialized prompt needs ~${promptTokens} tokens, over its ${window}-token context window input budget (${inputBudget}); nothing was sent` };
		}
	}
	const timeoutMs = backend.timeoutMs && backend.timeoutMs > 0 ? backend.timeoutMs : DEFAULT_CLI_TIMEOUT_MS;

	// Race the subprocess against a wall-clock timeout that fires its own abort
	// controller (linked to the parent signal so user-abort still propagates).
	let childCall: ReturnType<typeof runSpawn> | undefined;
	const outcome = await withTimeout(timeoutMs, signal, (timeoutSignal) => {
		childCall = runSpawn(inv, promptText, cwd, timeoutSignal, backend);
		return childCall;
	});
	// withTimeout races the abort; wait for this child to close before reporting it.
	if (!outcome.ok && childCall) await childCall.catch(() => {});

	if (outcome.timedOut) {
		return { text: "", timedOut: true, exitCode: null, errorMessage: `CLI "${inv.command}" timed out after ${timeoutMs}ms` };
	}
	if (!outcome.ok) {
		// Non-timeout throw — likely ENOENT (CLI not installed).
		const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
		return { text: "", timedOut: false, exitCode: null, errorMessage: `CLI "${inv.command}" failed to run: ${message}` };
	}

	const { stdout, code } = outcome.value;
	// FR5 branch order (from rpiv-args): non-zero exit here. (Timeout is handled
	// above via withTimeout aborting the subprocess; a kill surfaces as a throw.)
	if (code !== 0) {
		const output = outcome.value.stderr || stdout;
		const lastError = backend.command === "codex"
			? output.split(/\r?\n/).reverse().find((line) => /^ERROR:/i.test(line.trim()))
			: undefined;
		const detail = truncate(lastError ?? output, 500);
		return { text: "", timedOut: false, exitCode: code, errorMessage: `CLI "${inv.command}" exited ${code}${detail ? `: ${detail}` : ""}` };
	}

	// Custom OpenCode argv may use the old JSONL/plain-text contract, not our preset's `text` events.
	const format = backend.command === "opencode" && backend.args?.length ? "codex" : backend.command;
	const text = parseCliOutput(stdout, format as CliCommand);
	if (!text.trim()) {
		return { text: "", timedOut: false, exitCode: 0, errorMessage: `CLI "${inv.command}" returned no usable output` };
	}
	return { text: text.trim(), timedOut: false, exitCode: 0 };
}

/** Spawn the CLI, write the prompt to stdin, collect stdout/stderr, resolve on exit. */
function runSpawn(
	inv: { command: string; args: string[] },
	promptText: string,
	cwd: string | undefined,
	signal: AbortSignal,
	backend: CliBackendConfig,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(signal.reason ?? new Error("CLI aborted")); return; }
		let child;
		try {
			const env = backend.command === "opencode" && !backend.args?.length ? openCodeAdvisorEnv() : process.env;
			child = spawn(inv.command, inv.args, { cwd, stdio: ["pipe", "pipe", "pipe"], env, detached: process.platform !== "win32" });
		} catch (error) { reject(error); return; }
		let stdout = "";
		let stderr = "";
		let failure: Error | undefined;
		let closed = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let cleanupDone = false;
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		const killTree = (signalName: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
				else child.kill(signalName);
			} catch { /* Process group already exited. */ }
		};
		const finish = () => {
			if (settled || (!closed && !cleanupDone) || (signal.aborted && !cleanupDone)) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (killTimer) clearTimeout(killTimer);
			if (closeTimer) clearTimeout(closeTimer);
			if (signal.aborted) reject(signal.reason ?? new Error("CLI aborted"));
			else if (failure) reject(failure);
			else if (exitCode === null) reject(new Error(`CLI terminated by signal ${exitSignal ?? "unknown"}`));
			else resolve({ stdout, stderr, code: exitCode });
		};
		const onAbort = () => {
			killTree("SIGTERM");
			// Parent can exit 0 while a descendant still owns stdout. Kill the group
			// regardless of the parent's exit status, then wait for pipe closure.
			killTimer = setTimeout(() => {
				killTree("SIGKILL");
				cleanupDone = true;
				if (closed) finish();
				else closeTimer = setTimeout(finish, 1_000);
			}, 500);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (d: string) => { stdout += d; });
		child.stderr?.on("data", (d: string) => { stderr += d; });
		child.on("error", (error) => { failure = error; });
		child.stdin?.on("error", (error) => { failure = error; killTree("SIGTERM"); });
		child.on("close", (code, killedBy) => {
			closed = true;
			exitCode = code;
			exitSignal = killedBy;
			finish();
		});
		child.stdin?.end(promptText);
	});
}

/** Add a subprocess-only no-tool agent without replacing user provider config. */
function openCodeAdvisorEnv(): NodeJS.ProcessEnv {
	let base: Record<string, unknown> = {};
	if (process.env.OPENCODE_CONFIG_CONTENT) {
		let parsed: unknown;
		try { parsed = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); }
		catch { throw new Error("OPENCODE_CONFIG_CONTENT is invalid JSON; refusing to replace it"); }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
		}
		base = parsed as Record<string, unknown>;
	}
	const permissions = Object.fromEntries(
		["*", "read", "bash", "edit", "glob", "grep", "webfetch", "websearch", "task", "skill", "lsp"].map((name) => [name, "deny"]),
	);
	const agents = base.agent && typeof base.agent === "object" && !Array.isArray(base.agent)
		? base.agent as Record<string, unknown> : {};
	return {
		...process.env,
		OPENCODE_PERMISSION: JSON.stringify(permissions),
		OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...base, agent: { ...agents, "bpx-consult": {
			description: "Read-only advisor; answer from the supplied transcript without tools.", mode: "primary", permission: permissions,
		} } }),
	};
}

// ---------------------------------------------------------------------------
// Invocation resolution
// ---------------------------------------------------------------------------

/** Resolve preset argv; custom args remain authoritative and are never rewritten. */
export function resolveInvocation(backend: CliBackendConfig): { command: string; args: string[] } {
	// Custom command path: user specified a command + args verbatim.
	if (backend.args && backend.args.length > 0) {
		return { command: String(backend.command), args: backend.args };
	}
	const preset = Object.hasOwn(CLI_INVOCATIONS, backend.command)
		? CLI_INVOCATIONS[backend.command as CliCommand] : undefined;
	if (preset) {
		const args = [...preset.args];
		if (backend.model) {
			if (backend.command === "codex") args.splice(-1, 0, "-m", backend.model);
			else args.push("--model", backend.model);
		}
		return { command: preset.command, args };
	}
	// Unknown command name with no preset and no args — treat the string itself
	// as a bare command (user-defined CLI).
	return { command: String(backend.command), args: [] };
}

// ---------------------------------------------------------------------------
// Prompt assembly — markdown transcript piped to stdin
// ---------------------------------------------------------------------------

function buildPromptText(systemPrompt: string, messages: Message[]): string {
	const lines: string[] = [systemPrompt, "", "---", ""];
	for (const msg of messages) {
		const role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "Tool result";
		const text = messageToText(msg);
		if (!text.trim()) continue;
		lines.push(`=== ${role} ===`, text, "");
	}
	return lines.join("\n");
}

function messageToText(msg: Message): string {
	if (msg.role === "user") {
		return typeof msg.content === "string" ? msg.content : msg.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n");
	}
	if (msg.role === "assistant") {
		return msg.content
			.map((b) => {
				if (b.type === "text") return b.text;
				if (b.type === "toolCall") return `[tool call: ${b.name}]`;
				if (b.type === "thinking") return "";
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return msg.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n");
}

// ---------------------------------------------------------------------------
// Defensive output parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI stdout into advisor text.
 *
 * - JSONL producers (codex, opencode): scan lines for `{"type":"item.completed",...}`
 *   or any line that JSON-parses to an object with a `.text` / `.item.text` field.
 *   Ignore everything else (deprecation notices, progress chatter, auth warnings).
 * - Plain-text producers (claude): return the trimmed stdout.
 *
 * The junk-preamble tolerance is the whole point: a real codex run prints a
 * "Using model X" line and sometimes a warning before the payload. We must not
 * crash or return that junk as the advisor's reply.
 */
export function parseCliOutput(stdout: string, command: CliCommand): string {
	const trimmed = stdout.trim();
	if (!trimmed) return "";

	if (command === "opencode") {
		// `opencode run --format json` emits completed answer parts as `text`
		// events. Never return raw JSON events or tool output as advisor prose.
		return trimmed.split("\n").map((line) => {
			try {
				const event = JSON.parse(line) as { type?: string; part?: { text?: unknown } };
				return event.type === "text" && typeof event.part?.text === "string" ? event.part.text : "";
			} catch { return ""; }
		}).filter(Boolean).join("\n");
	}
	if (command === "codex") {
		const collected: string[] = [];
		for (const line of trimmed.split("\n")) {
			const payload = extractJsonlText(line.trim());
			if (payload) collected.push(payload);
		}
		if (collected.length > 0) return collected.join("\n");
		// Some Codex builds print plain text instead of JSONL.
	}

	// Plain text: return as-is (already trimmed).
	return trimmed;
}

/**
 * Try to extract advisor text from one JSONL line. Returns undefined for lines
 * that aren't JSON, or JSON without a recognizable text field.
 */
function extractJsonlText(line: string): string | undefined {
	if (!line.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined; // junk preamble that happens to start with '{' — skip
	}
	if (!parsed || typeof parsed !== "object") return undefined;

	// codex/opencode shape: { type: "item.completed", item: { text: "..." } }
	const obj = parsed as Record<string, unknown>;
	const item = obj.item;
	if (item && typeof item === "object") {
		const t = (item as Record<string, unknown>).text;
		if (typeof t === "string" && t.trim()) return t;
	}
	// Generic shape: { text: "..." } at the top level.
	if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
	// message.content array shape (some CLIs echo the prompt schema).
	if (Array.isArray(obj.content)) {
		const text = obj.content
			.map((c) => (c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string" ? (c as Record<string, unknown>).text : null))
			.filter((x): x is string => !!x)
			.join("\n");
		if (text.trim()) return text;
	}
	return undefined;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------------------------------------------------------------------
// Context-window presets (council §3: 'presets must provide known context-
// window caps; remove the unverified 32k fallback for unknown CLIs')
// ---------------------------------------------------------------------------

/**
 * Known context windows for the preset CLI commands (the underlying models'
 * real windows). Codex and Claude presets default to 200k. OpenCode routes
 * to arbitrary providers and needs discovered model metadata or a declared
 * contextWindow; guessing a capacity risks forwarding an oversized prompt.
 */
export const CLI_WINDOW_PRESETS: Record<string, number> = {
	codex: 200_000,
	claude: 200_000,
};

/**
 * Resolve a CLI backend's context window. Declared `contextWindow` wins; then
 * the preset for known commands; then undefined for an unknown custom command
 * with no declared window (the caller pre-fails the member rather than
 * silently guessing — the 32k fallback is gone by design).
 */
export function cliContextWindow(backend: CliBackendConfig): number | undefined {
	if (typeof backend.contextWindow === "number" && backend.contextWindow > 0) return backend.contextWindow;
	return Object.hasOwn(CLI_WINDOW_PRESETS, backend.command) ? CLI_WINDOW_PRESETS[backend.command] : undefined;
}
