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
import { withTimeout } from "./timeout.js";

export type CliCommand = "codex" | "claude" | "opencode";

/** Pre-baked invocations. Read prompt from stdin (`-` or `-p`). */
const CLI_INVOCATIONS: Record<CliCommand, { command: string; args: string[] }> = {
	codex: { command: "codex", args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"] },
	claude: { command: "claude", args: ["-p"] },
	opencode: { command: "opencode", args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"] },
};

export interface CliBackendConfig {
	type: "cli";
	command: CliCommand | string;
	args?: string[];
	timeoutMs?: number;
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
	const inv = resolveInvocation(backend);
	const promptText = buildPromptText(systemPrompt, messages);
	const timeoutMs = backend.timeoutMs && backend.timeoutMs > 0 ? backend.timeoutMs : DEFAULT_CLI_TIMEOUT_MS;

	// Race the subprocess against a wall-clock timeout that fires its own abort
	// controller (linked to the parent signal so user-abort still propagates).
	const outcome = await withTimeout(timeoutMs, signal, (timeoutSignal) => runSpawn(inv, promptText, cwd, timeoutSignal));

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
		const detail = truncate(outcome.value.stderr || stdout, 500);
		return { text: "", timedOut: false, exitCode: code, errorMessage: `CLI "${inv.command}" exited ${code}${detail ? `: ${detail}` : ""}` };
	}

	const text = parseCliOutput(stdout, backend.command as CliCommand);
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
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(inv.command, inv.args, { cwd, stdio: ["pipe", "pipe", "pipe"], signal });
		} catch (e) {
			reject(e);
			return;
		}

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => { stdout += d.toString(); });
		child.stderr?.on("data", (d) => { stderr += d.toString(); });

		child.on("error", reject); // ENOENT etc.
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));

		// Write the prompt to stdin and close it so the CLI knows input is complete.
		child.stdin?.on("error", reject);
		child.stdin?.end(promptText);
	});
}

// ---------------------------------------------------------------------------
// Invocation resolution
// ---------------------------------------------------------------------------

function resolveInvocation(backend: CliBackendConfig): { command: string; args: string[] } {
	// Custom command path: user specified a command + args verbatim.
	if (backend.args && backend.args.length > 0) {
		return { command: String(backend.command), args: backend.args };
	}
	const preset = CLI_INVOCATIONS[backend.command as CliCommand];
	if (preset) return preset;
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

	// JSONL producers: collect text from every parseable line that carries it.
	if (command === "codex" || command === "opencode") {
		const collected: string[] = [];
		for (const line of trimmed.split("\n")) {
			const payload = extractJsonlText(line.trim());
			if (payload) collected.push(payload);
		}
		if (collected.length > 0) return collected.join("\n");
		// Fall through to plain text if no JSONL payload was found — some codex
		// builds print plain text despite the documented JSONL contract.
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
 * real windows). Codex runs GPT-5-tier, Claude CLI runs Claude, OpenCode
 * routes to a configured model — all ~200k. Conservative and safe; a user can
 * override per-backend with `contextWindow` in config if they know better.
 */
export const CLI_WINDOW_PRESETS: Record<string, number> = {
	codex: 200_000,
	claude: 200_000,
	opencode: 200_000,
};

/**
 * Resolve a CLI backend's context window. Declared `contextWindow` wins; then
 * the preset for known commands; then undefined for an unknown custom command
 * with no declared window (the caller pre-fails the member rather than
 * silently guessing — the 32k fallback is gone by design).
 */
export function cliContextWindow(backend: CliBackendConfig): number | undefined {
	if (typeof backend.contextWindow === "number" && backend.contextWindow > 0) return backend.contextWindow;
	return CLI_WINDOW_PRESETS[backend.command];
}
