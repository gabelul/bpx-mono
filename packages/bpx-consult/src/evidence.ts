/**
 * evidence — deterministic evidence classification + audit ledger (SPEC §E.0).
 *
 * §E.1's whole promise is "evidence-aware fit," and the trap it must not fall
 * into is letting a (possibly stuck) model score its own evidence — that quietly
 * reintroduces the weak-judge problem and would score away the very fact that
 * proves the model wrong. So selection is DETERMINISTIC, by artifact type, before
 * any model touches the transcript. This module is that classifier plus the
 * ledger types that make the fit auditable.
 *
 * Everything here is pure and unit-testable. The only pi coupling is the message
 * TYPES (`Message` and friends) — no session, no registry, no I/O. That keeps the
 * classifier cheap to test with hand-built fixtures and honest about what it can
 * see: a toolResult carries `toolName`/`isError`/`details` but NOT the tool's
 * input, so to recover a bash command or an edited path we correlate the result
 * back to its `ToolCall` via `toolCallId`. That correlation is the one bit of
 * bookkeeping the caller doesn't have to think about — `classifyMessages` walks
 * the whole array so it can build that map itself.
 */

import type { Message, AssistantMessage, ToolResultMessage, ToolCall, TextContent } from "@earendil-works/pi-ai";
import {
	countPatchChanges,
	extractBashExitCode,
	isVerificationCommand,
} from "./advisor-signals.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The artifact type of a single transcript message. Deterministic — derived from
 * role + tool name + a content regex, never from model judgment. The union is the
 * vocabulary the §E.1 fit uses to decide what to pin, compress, or drop.
 */
export type EvidenceTag =
	| "directive"
	| "question"
	| "acceptance"
	| "diff"
	| "failing-output"
	| "stack-trace"
	| "edited-file"
	| "test"
	| "reviewer-finding"
	| "repeated-failure"
	| "exploration"
	| "other";

/** What the fit did with a message. Recorded per-message in the ledger. */
export type Disposition = "kept" | "compressed" | "clipped" | "dropped";

/**
 * One row of the audit ledger — the answer to "what happened to message N and
 * why." `fittedTokens + omitted` alone can't debug a bad consult; this can. See
 * §E.0: without the ledger, §E.1 can look principled while silently dropping the
 * decisive evidence under a nicer name.
 */
export interface EvidenceLedgerEntry {
	/** Index of the message in the stripped session array. */
	index: number;
	tag: EvidenceTag;
	disposition: Disposition;
	/** Human-readable reason — the priority rule that decided this row. */
	reason: string;
}

/**
 * A classified message: the original message, its position, its tag, whether it's
 * pinned (survives compression by §E.0 promotion rules), and a one-line signal
 * summary the fit can drop in when the verbatim message is too expensive to keep.
 */
export interface ClassifiedMessage {
	index: number;
	message: Message;
	tag: EvidenceTag;
	pinned: boolean;
	/** One-liner for signal-compression ("read x.ts", "$ npm test (exit 1)"). */
	signal: string;
	/**
	 * Stable signature used to detect repeated failures. Only set for failing
	 * output / stack traces; undefined otherwise. Two failures with the same
	 * signature collapse to one pinned "signature ×N" entry.
	 */
	failureSignature?: string;
}

// ---------------------------------------------------------------------------
// Pinning rules (§E.0 promotion)
// ---------------------------------------------------------------------------

/**
 * Tags that are ALWAYS pinned — they survive compression even when old, because
 * they're the "middle clue" that recency-slicing drops. Note "diff" and the
 * failure tags are NOT in this set: only the LATEST diff and LATEST failure get
 * pinned as the payload (see `markLatestPayload`), older ones are compressible.
 */
export const PINNED_TAGS: ReadonlySet<EvidenceTag> = new Set<EvidenceTag>([
	"directive",
	"question",
	"acceptance",
	"reviewer-finding",
	"repeated-failure",
]);

// ---------------------------------------------------------------------------
// Content shape detectors (regex heuristics, documented per SPEC §E.0)
// ---------------------------------------------------------------------------

/**
 * Stack-trace shape. Deliberately broad — matches the common runtime traces
 * (JS/TS `at fn (file:line)`, Python `Traceback ... File "x", line N`, Go/Java
 * `at pkg.Fn`). It's a heuristic; false negatives just fall back to
 * `failing-output`, which is still pinned as the latest payload, so a miss here
 * costs richer tagging, not correctness.
 */
const STACK_TRACE_PATTERNS: RegExp[] = [
	/^\s*at\s+.+\(.+:\d+(?::\d+)?\)/m, // JS/TS: "at fn (file.ts:12:3)"
	/Traceback \(most recent call last\)/, // Python
	/^\s*File ".+", line \d+/m, // Python frame
	/\b[A-Za-z_.]+(?:Error|Exception):/, // "TypeError:", "RuntimeException:"
	/^\s*at\s+[\w$.]+\.[\w$]+\(/m, // Java/Go-ish "at pkg.Fn("
	/panic:\s/, // Go panic
];

function looksLikeStackTrace(text: string): boolean {
	if (!text) return false;
	return STACK_TRACE_PATTERNS.some((p) => p.test(text));
}

/**
 * Reviewer / security finding keywords. Best-effort, documented as heuristic in
 * §E.0 ("low priority to nail perfectly"). We only fire on assistant/user text
 * that reads like a review call-out, not on every mention of the word "review".
 * Pinned when it hits because a reviewer finding is exactly the kind of middle
 * clue recency drops.
 */
const REVIEWER_FINDING_PATTERNS: RegExp[] = [
	/\b(?:security|vulnerabilit(?:y|ies)|CVE-\d)/i,
	/\b(?:code review|reviewer|review finding)\b/i,
	/\b(?:SQL injection|XSS|CSRF|RCE|SSRF|path traversal)\b/i,
	/\b(?:critical|high[- ]severity|P0|P1)\b.*\b(?:issue|bug|risk|flaw)\b/i,
];

function looksLikeReviewerFinding(text: string): boolean {
	if (!text) return false;
	return REVIEWER_FINDING_PATTERNS.some((p) => p.test(text));
}

/**
 * Acceptance-criteria keywords. Also best-effort per §E.0. Matches the phrasings
 * humans use to state what "done" means ("acceptance criteria", "must pass",
 * "the requirement is", checkbox lists of shoulds). Pinned when it hits.
 */
const ACCEPTANCE_PATTERNS: RegExp[] = [
	/\bacceptance criteria\b/i,
	/\b(?:must|should|has to|needs? to)\s+(?:pass|handle|support|return|fit|satisfy)\b/i,
	/\brequirements?\b\s*:/i,
	/^\s*[-*]\s*\[[ xX]\]/m, // markdown checkbox list — a de-facto criteria list
];

function looksLikeAcceptance(text: string): boolean {
	if (!text) return false;
	return ACCEPTANCE_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Text extraction helpers (pi-free, mirror context-engine's shapes)
// ---------------------------------------------------------------------------

function squeeze(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Flatten a user message's content to text (drops images — advisors don't need them). */
function userTextOf(msg: Message & { role: "user" }): string {
	if (typeof msg.content === "string") return msg.content;
	return textBlocks(msg.content)
		.map((b) => b.text)
		.join("\n");
}

/** Flatten an assistant message's text + thinking to a single string. */
function assistantTextOf(msg: AssistantMessage): string {
	return msg.content
		.map((b) => {
			if (b.type === "text") return b.text;
			if (b.type === "thinking") return b.thinking ?? "";
			return "";
		})
		.join("\n")
		.trim();
}

/** Flatten a toolResult's text content. */
function toolResultTextOf(msg: ToolResultMessage): string {
	return textBlocks(msg.content)
		.map((b) => b.text)
		.join("\n")
		.trim();
}

function textBlocks(content: unknown): TextContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter((b): b is TextContent => b?.type === "text" && typeof b.text === "string");
}

/**
 * The tool's input path — read/edit/write all take `path` (with a `file_path`
 * legacy alias, matching pi's own tolerance in edit.js/write.js). Pulled from the
 * matching ToolCall's arguments, since the toolResult itself has no input.
 */
function toolCallPath(call: ToolCall | undefined): string | undefined {
	const args = call?.arguments;
	if (!args) return undefined;
	const path = args.path ?? args.file_path;
	return typeof path === "string" ? path : undefined;
}

/** The bash command from the matching ToolCall's arguments. */
function toolCallCommand(call: ToolCall | undefined): string | undefined {
	const cmd = call?.arguments?.command;
	return typeof cmd === "string" ? cmd : undefined;
}

// ---------------------------------------------------------------------------
// summarizeToolResult — port of advisor-signals, adapted to pi types (§E.0)
// ---------------------------------------------------------------------------

/**
 * Turn a toolResult into a one-liner ("read x.ts", "edit y.ts (+30/-5)",
 * "$ npm test (exit 1)"). Ported from advisor-signals.summarizeToolResult, but
 * adapted to pi's real message shape: the command/path live on the matching
 * ToolCall (passed in as `call`), not on the toolResult. The signal is what the
 * fit substitutes when a verbatim message is too expensive to keep — the path
 * gets compressed, but the fact that it happened doesn't get silently dropped.
 *
 * @param msg - the toolResult message
 * @param call - the ToolCall that produced it (matched by toolCallId), or undefined
 * @returns a compact one-line summary of the tool event
 */
export function summarizeToolResult(msg: ToolResultMessage, call?: ToolCall): string {
	const { toolName, isError } = msg;
	const text = toolResultTextOf(msg);
	const oneLine = squeeze(text).slice(0, 140);

	switch (toolName) {
		case "read": {
			const path = toolCallPath(call) ?? "(unknown path)";
			return `read ${path}`;
		}
		case "edit":
		case "write": {
			const path = toolCallPath(call) ?? "(unknown path)";
			const patch = (msg.details as { patch?: unknown } | undefined)?.patch;
			let changeStats = "";
			if (typeof patch === "string" && patch.length > 0) {
				const { added, removed } = countPatchChanges(patch);
				changeStats = ` (+${added}/-${removed})`;
			}
			return `${toolName} ${path}${changeStats}`;
		}
		case "bash": {
			const command = toolCallCommand(call);
			const cmdShort = command ? squeeze(command).slice(0, 140) : "(unknown command)";
			const exitCode = extractBashExitCode(text);
			const suffix = exitCode !== undefined ? ` (exit ${exitCode})` : isError ? " (error)" : "";
			return `$ ${cmdShort}${suffix}`;
		}
		default:
			return oneLine ? `${toolName}: ${oneLine}` : toolName;
	}
}

// ---------------------------------------------------------------------------
// Failure signatures (for repeated-failure detection)
// ---------------------------------------------------------------------------

/**
 * A stable signature for a failing output, so two runs of the same broken command
 * collapse to one pinned "signature ×N" entry instead of N separate blocks.
 * Deliberately coarse — normalize whitespace, strip volatile bits (timestamps,
 * hex addresses, line/col numbers, temp paths), take a bounded prefix. Two
 * failures that differ only in a timestamp or a PID should share a signature.
 */
export function failureSignature(text: string): string {
	return squeeze(text)
		.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, "<ts>") // ISO timestamps
		.replace(/0x[0-9a-fA-F]+/g, "<addr>") // hex addresses
		.replace(/:\d+:\d+/g, ":<pos>") // line:col
		.replace(/\/(?:tmp|var)\/\S+/g, "<tmp>") // temp paths
		.replace(/\b\d+\b/g, "<n>") // any remaining bare numbers
		.slice(0, 200);
}

// ---------------------------------------------------------------------------
// classifyMessage / classifyMessages — the deterministic tagger (§E.0)
// ---------------------------------------------------------------------------

/**
 * Classify ONE message deterministically. Needs `all` (+ a toolCall lookup, built
 * once by `classifyMessages`) because some tags depend on context — e.g. a bash
 * result is a `test` only if its command was a verification command, and that
 * command lives on the preceding assistant's ToolCall.
 *
 * The rules, each documented (SPEC §E.0):
 *  - user message                          → directive (user instructions/corrections)
 *  - toolResult isError, stack-trace shape  → stack-trace
 *  - toolResult isError                     → failing-output
 *  - edit/write toolResult (has patch)      → diff (also an edited file)
 *  - edit/write toolResult (no patch)       → edited-file
 *  - bash toolResult, verification command  → test
 *  - read toolResult                        → exploration
 *  - assistant text w/ reviewer keywords    → reviewer-finding
 *  - assistant text w/ acceptance keywords  → acceptance
 *  - assistant text/thinking (otherwise)    → other (tail context, not pinned)
 *  - anything else                          → other
 *
 * @param msg - the message to classify
 * @param index - its position in the array
 * @param callFor - lookup from toolCallId → the ToolCall that produced a result
 * @returns the tag + the signal one-liner + a failure signature when relevant
 */
export function classifyMessage(
	msg: Message,
	index: number,
	callFor: (toolCallId: string) => ToolCall | undefined,
): { tag: EvidenceTag; signal: string; failureSignature?: string } {
	// --- user messages: the human's instructions/corrections are directives ---
	if (msg.role === "user") {
		const text = userTextOf(msg);
		// A user turn stating acceptance criteria is still, first, a directive —
		// but if it reads strongly like criteria we tag acceptance so it pins under
		// that bucket. Directive is the safe default (also pinned) either way.
		if (looksLikeAcceptance(text)) {
			return { tag: "acceptance", signal: `acceptance: ${squeeze(text).slice(0, 120)}` };
		}
		return { tag: "directive", signal: `directive: ${squeeze(text).slice(0, 120)}` };
	}

	// --- assistant messages: mostly tail context; keyword-detect the exceptions ---
	if (msg.role === "assistant") {
		const text = assistantTextOf(msg);
		if (looksLikeReviewerFinding(text)) {
			return { tag: "reviewer-finding", signal: `reviewer: ${squeeze(text).slice(0, 120)}` };
		}
		if (looksLikeAcceptance(text)) {
			return { tag: "acceptance", signal: `acceptance: ${squeeze(text).slice(0, 120)}` };
		}
		// Everything else the assistant said is kept as tail context, not pinned.
		return { tag: "other", signal: squeeze(text).slice(0, 120) || "(assistant turn)" };
	}

	// --- toolResult messages ---
	const call = callFor(msg.toolCallId);
	const signal = summarizeToolResult(msg, call);
	const text = toolResultTextOf(msg);

	if (msg.isError) {
		const sig = failureSignature(text);
		if (looksLikeStackTrace(text)) {
			return { tag: "stack-trace", signal, failureSignature: sig };
		}
		return { tag: "failing-output", signal, failureSignature: sig };
	}

	if (msg.toolName === "edit" || msg.toolName === "write") {
		const patch = (msg.details as { patch?: unknown } | undefined)?.patch;
		if (typeof patch === "string" && patch.length > 0) {
			return { tag: "diff", signal };
		}
		return { tag: "edited-file", signal };
	}

	if (msg.toolName === "bash") {
		const command = toolCallCommand(call);
		if (isVerificationCommand(command)) {
			return { tag: "test", signal };
		}
		return { tag: "other", signal };
	}

	if (msg.toolName === "read") {
		return { tag: "exploration", signal };
	}

	// grep/ls/find and other read-only tools → exploration.
	if (msg.toolName === "grep" || msg.toolName === "ls" || msg.toolName === "find") {
		return { tag: "exploration", signal };
	}

	return { tag: "other", signal };
}

/**
 * Classify the whole (already in-flight-stripped) transcript. Builds the
 * toolCallId → ToolCall lookup once so per-message classification can recover the
 * command/path a toolResult lacks, applies the base pinning rules, then runs two
 * context-dependent promotions:
 *
 *   1. LATEST payload — the highest-index `diff` and the highest-index
 *      failing-output/stack-trace get pinned as "the payload" (§E.0 PINNED_TAGS
 *      note). Older diffs/failures stay compressible.
 *   2. REPEATED failures — a failing-output/stack-trace signature that appears ≥2×
 *      is re-tagged `repeated-failure` (pinned) so the fit can collapse it to one
 *      "signature ×N" entry instead of N copies.
 *
 * @param messages - the stripped session messages
 * @returns one ClassifiedMessage per input message, in order
 */
export function classifyMessages(messages: Message[]): ClassifiedMessage[] {
	// Build toolCallId → ToolCall from every assistant message's toolCalls.
	const callMap = new Map<string, ToolCall>();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content) {
			if (block.type === "toolCall") callMap.set(block.id, block);
		}
	}
	const callFor = (id: string) => callMap.get(id);

	const classified: ClassifiedMessage[] = messages.map((message, index) => {
		const { tag, signal, failureSignature: sig } = classifyMessage(message, index, callFor);
		return {
			index,
			message,
			tag,
			pinned: PINNED_TAGS.has(tag),
			signal,
			failureSignature: sig,
		};
	});

	markRepeatedFailures(classified);
	markLatestPayload(classified);

	return classified;
}

/**
 * Re-tag failing-output/stack-trace items whose signature repeats ≥2× as
 * `repeated-failure` (pinned). The repeat itself is the signal — "we've hit this
 * exact wall N times" is a stronger clue than any single instance, and it's
 * precisely the "middle clue" the recency window would drop.
 */
function markRepeatedFailures(classified: ClassifiedMessage[]): void {
	const counts = new Map<string, number>();
	for (const c of classified) {
		if (c.failureSignature && (c.tag === "failing-output" || c.tag === "stack-trace")) {
			counts.set(c.failureSignature, (counts.get(c.failureSignature) ?? 0) + 1);
		}
	}
	for (const c of classified) {
		if (!c.failureSignature) continue;
		if (c.tag !== "failing-output" && c.tag !== "stack-trace") continue;
		const n = counts.get(c.failureSignature) ?? 0;
		if (n >= 2) {
			c.tag = "repeated-failure";
			c.pinned = true;
			c.signal = `${c.signal} [repeated ×${n}]`;
		}
	}
}

/**
 * Pin the LATEST diff and the LATEST failing-output/stack-trace as the payload
 * (§E.0). "Latest" = highest index of that tag. These aren't in PINNED_TAGS
 * because only the freshest instance is the payload — older diffs/failures stay
 * compressible so they don't crowd it out.
 */
function markLatestPayload(classified: ClassifiedMessage[]): void {
	let latestDiff = -1;
	let latestFailure = -1;
	for (const c of classified) {
		if (c.tag === "diff" && c.index > latestDiff) latestDiff = c.index;
		if ((c.tag === "failing-output" || c.tag === "stack-trace") && c.index > latestFailure) {
			latestFailure = c.index;
		}
	}
	for (const c of classified) {
		if (c.index === latestDiff && c.tag === "diff") c.pinned = true;
		if (c.index === latestFailure && (c.tag === "failing-output" || c.tag === "stack-trace")) c.pinned = true;
	}
}
