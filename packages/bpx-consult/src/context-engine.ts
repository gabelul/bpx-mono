/**
 * context-engine — the §P fix.
 *
 * rpiv-advisor forwards Pi's already-compacted session context to the advisor
 * model without re-fitting it to the advisor's *own* window. The executor's
 * compacted context can be larger than a small-window advisor (flash-tier 32k,
 * or a CLI at 32–64k), so the advisor call overflows *its* window and dies —
 * exactly when the session is long enough to need it.
 *
 * This module re-fits Pi's compacted context to whatever window *this* advisor
 * has. The pipeline (SPEC §C):
 *   1. strip in-flight consult() call  (lifted from rpiv-advisor/context.ts)
 *   2. extract user/assistant/tool text  (lifted from pi-advisor/advisor-messages.ts)
 *   3. [fast-follow] stage + signal detection — not here yet, doesn't affect fit
 *   4. [fast-follow] signal block
 *   5. per-message char caps with [omitted] markers  (pi-advisor clampText)
 *   6. sliding window: keep first N + last M, drop oldest-first when still over
 *   7. reserve response tokens (load-bearing — see invariant below)
 *   8. assemble final Message[] + a closing context message
 *
 * Window-fit does NOT depend on stage/signal detection. Those improve the
 * directive, not the fit. Ship the guaranteed-fit core first.
 */

import type { Message, UserMessage, AssistantMessage, ToolResultMessage, TextContent } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContextBudget {
	userChars: number;
	assistantChars: number;
	toolArgChars: number;
	toolResultChars: number;
	keepFirst: number;
	keepLast: number;
	/** Tokens reserved for the advisor's reply. The input budget is window minus this. */
	responseReserveTokens: number;
}

export interface FitResult {
	/** The re-fitted messages, guaranteed to fit `maxInputTokens`. */
	messages: Message[];
	/** How many messages were dropped by the sliding window, if any. */
	omittedCount: number;
	/** Estimated tokens of the final payload, for diagnostics. */
	estimatedTokens: number;
	/** The token budget the fit was computed against. */
	maxInputTokens: number;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough token estimate. The ratio is deliberately conservative.
 *
 * The often-cited 4 chars/token is the tiktoken average for English prose.
 * But the bulk of what we forward — tool arguments, tool results, code —
 * tokenizes DENSER (closer to 3-3.5 chars/token). Using 4 would UNDERESTIMATE
 * tokens on code-heavy sessions, causing us to pack more than fits and
 * overflow the advisor window — which reopens the exact §P bug we exist to fix.
 *
 * So we use 3 chars/token (overestimates tokens for prose, the safe direction)
 * and apply a 1.15 safety factor on top for provider-tokenizer variance.
 * Under-packing is cheap; overflow defeats the whole point of this module.
 *
 * No real tokenizer (tiktoken etc.) because (a) heavy native dep for an
 * estimate, (b) every provider tokenizes differently, (c) the heuristic only
 * needs to be conservative enough that the cap+window pass lands under budget
 * with margin.
 */
const CHARS_PER_TOKEN = 3;
const SAFETY_FACTOR = 1.15;

export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_FACTOR);
}

/** Sum tokens across every text-bearing field of a message. */
export function estimateMessageTokens(msg: Message): number {
	return estimateTokens(stringifyMessageForEstimate(msg));
}

/**
 * Flatten a message to a single string for token estimation. Only counts text
 * we will actually forward — image blocks are intentionally excluded (we strip
 * them in extract anyway; advisors don't need screenshots).
 */
function stringifyMessageForEstimate(msg: Message): string {
	if (msg.role === "user") {
		return typeof msg.content === "string" ? msg.content : textBlocks(msg.content).map((b) => b.text).join("\n");
	}
	if (msg.role === "assistant") {
		return msg.content
			.map((b) => {
				if (b.type === "text") return b.text;
				if (b.type === "toolCall") return JSON.stringify(b.arguments ?? {});
				if (b.type === "thinking") return b.thinking ?? "";
				return "";
			})
			.join("\n");
	}
	// toolResult
	return textBlocks(msg.content).map((b) => b.text).join("\n");
}

// ---------------------------------------------------------------------------
// Step 1 — strip in-flight consult() call  (faithful fork of rpiv-advisor)
// ---------------------------------------------------------------------------

export const CONSULT_TOOL_NAME = "consult";

/**
 * Remove the executor's in-flight consult() toolCall from the tail assistant
 * message. That call is what invoked us — there is no matching toolResult yet,
 * and providers reject payloads with orphan toolCalls. Name-targeted so other
 * trailing toolCalls stay visible.
 *
 * Lifted from rpiv-advisor/advisor/context.ts:stripInflightAdvisorCall, renamed
 * to the consult tool name.
 */
export function stripInflightConsultCall(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const filtered = last.content.filter((c) => !(c.type === "toolCall" && c.name === CONSULT_TOOL_NAME));
	if (filtered.length === last.content.length) return messages;
	if (filtered.length === 0) return messages.slice(0, -1);
	return [...messages.slice(0, -1), { ...last, content: filtered }];
}

// ---------------------------------------------------------------------------
// Step 5 — per-message char caps  (fork of pi-advisor clampText)
// ---------------------------------------------------------------------------

/**
 * Clamp text to a char budget with an explicit marker. Lifted from
 * pi-advisor/advisor-messages.ts:clampText, simplified (we cap by chars, not
 * lines — the line cap was a belt-and-braces second constraint that adds noise
 * here). Marks truncation explicitly so the advisor sees content was cut.
 */
export function clampText(text: string, maxChars: number): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars).trimEnd()}…\n[truncated for advisor context]`;
}

function clampUserMessage(msg: UserMessage, budget: ContextBudget): UserMessage {
	if (typeof msg.content === "string") {
		return { ...msg, content: clampText(msg.content, budget.userChars) };
	}
	const capped: TextContent[] = textBlocks(msg.content).map((b) => ({ type: "text", text: clampText(b.text, budget.userChars) }));
	return { ...msg, content: capped };
}

function clampAssistantMessage(msg: AssistantMessage, budget: ContextBudget): AssistantMessage {
	// Keep text + toolCalls + thinking, but cap each text block and each toolCall's
	// serialized arguments. ToolCalls themselves are structurally important (the
	// advisor needs to see what was attempted), so we keep the call but trim
	// oversized args rather than dropping the whole call.
	const content = msg.content.map((b) => {
		if (b.type === "text") return { ...b, text: clampText(b.text, budget.assistantChars) };
		if (b.type === "toolCall") {
			const argsJson = JSON.stringify(b.arguments ?? {});
			if (argsJson.length <= budget.toolArgChars) return b;
			return { ...b, arguments: { _truncated: clampText(argsJson, budget.toolArgChars) } };
		}
		return b; // thinking blocks passed through
	});
	return { ...msg, content };
}

function clampToolResultMessage(msg: ToolResultMessage, budget: ContextBudget): ToolResultMessage {
	const content: TextContent[] = textBlocks(msg.content).map((b) => ({ type: "text", text: clampText(b.text, budget.toolResultChars) }));
	return { ...msg, content };
}

/** Apply per-message char caps. Non-mutating. */
export function applyCharCaps(messages: Message[], budget: ContextBudget): Message[] {
	return messages.map((msg) => {
		if (msg.role === "user") return clampUserMessage(msg, budget);
		if (msg.role === "assistant") return clampAssistantMessage(msg, budget);
		return clampToolResultMessage(msg, budget);
	});
}

// ---------------------------------------------------------------------------
// Step 6 — sliding window  (first-N + last-M, oldest-first drop)
// ---------------------------------------------------------------------------

/**
 * Drop messages from the middle of the transcript until we're under the token
 * budget. Keeps the first `keepFirst` (task framing) and the last `keepLast`
 * (freshest evidence), inserting an [omitted] marker between them. If still
 * over after one pass, shrink keepLast one message at a time until it fits.
 *
 * Faithful to pi-advisor's first-2 + last-N-with-omitted-marker shape, but the
 * *stopping condition* is the token budget, not a fixed message count — that
 * is the §P fix. pi-advisor's `maxMessages` is a guess at the window; we read
 * the real window per-call instead.
 */
export function fitToWindow(messages: Message[], budget: ContextBudget, maxInputTokens: number): FitResult {
	if (messages.length === 0) {
		return { messages: [], omittedCount: 0, estimatedTokens: 0, maxInputTokens };
	}

	// Quick path: already fits.
	const whole = sumTokens(messages);
	if (whole <= maxInputTokens) {
		return { messages, omittedCount: 0, estimatedTokens: whole, maxInputTokens };
	}

	const keepFirst = Math.min(budget.keepFirst, messages.length);
	// Start from the configured tail and shrink under budget.
	let keepLast = Math.min(budget.keepLast, messages.length - keepFirst);

	const head = messages.slice(0, keepFirst);

	// Shrink the tail until head + marker + tail fits. Test down to keepLast=1
	// (a single tail message) before falling through to the last-resort path —
	// otherwise we'd skip a fit that retains the head and lose it unnecessarily.
	while (keepLast >= 1) {
		const tail = messages.slice(-keepLast);
		const omittedCount = messages.length - keepFirst - keepLast;
		const marker = omittedMarker(omittedCount);
		const candidate = [...head, marker, ...tail];
		if (sumTokens(candidate) <= maxInputTokens) {
			return { messages: candidate, omittedCount, estimatedTokens: sumTokens(candidate), maxInputTokens };
		}
		keepLast--;
	}

	// Last resort: keep only the final message, capped. The cap pass already ran
	// but re-clamp the survivor aggressively to whatever budget remains.
	const only = messages[messages.length - 1];
	const omittedCount = messages.length - 1;
	const marker = omittedMarker(omittedCount);
	const survivor = clampSurvivor(only, maxInputTokens - sumTokens([marker]));
	const candidate = [marker, survivor];
	return { messages: candidate, omittedCount, estimatedTokens: sumTokens(candidate), maxInputTokens };
}

function omittedMarker(omittedCount: number): UserMessage {
	return {
		role: "user",
		content: `[${omittedCount} earlier transcript messages omitted to fit the advisor context window. Focus on the retained task framing and the most recent evidence.]`,
		timestamp: Date.now(),
	};
}

/**
 * When even one message won't fit, clamp its text down to the remaining budget.
 * Self-correcting: because estimateTokens applies a safety factor, clamping by
 * chars then re-estimating can overshoot. So we clamp, check the estimate, and
 * halve until it genuinely fits — never trust the char math alone on the
 * last-resort path, which is exactly where overflow would reopen §P.
 */
function clampSurvivor(msg: Message, remainingTokenBudget: number): Message {
	let maxChars = Math.max(64, Math.floor((remainingTokenBudget * CHARS_PER_TOKEN) / SAFETY_FACTOR));
	const original = stringifyMessageForEstimate(msg);
	let clamped = clampText(original, maxChars);
	// Guard: if the re-estimate still overshoots (ceil rounding, provider variance),
	// keep shrinking until it fits. Bounded — maxChars collapses fast.
	let guard = 0;
	while (estimateTokens(clamped) > remainingTokenBudget && maxChars > 32 && guard < 20) {
		maxChars = Math.floor(maxChars * 0.7);
		clamped = clampText(original, maxChars);
		guard++;
	}
	// Return as a single text user message — structure is already lost at this
	// point, honesty about that beats a half-mangled typed payload.
	return { role: "user", content: clamped, timestamp: "timestamp" in msg ? msg.timestamp : Date.now() };
}

// ---------------------------------------------------------------------------
// Step 7 — reserve + derive the input budget  (load-bearing)
// ---------------------------------------------------------------------------

/**
 * Derive the input token budget for this advisor call.
 *
 *   maxInputTokens = advisor.contextWindow - responseReserveTokens
 *
 * This is the §P fix in one line: the budget is relative to *this* advisor's
 * window, read live from the registry, never a global constant. If we can't
 * read the window, fall back to a conservative 32k (typical small advisor) so
 * we still re-fit rather than forwarding blindly.
 */
export function deriveInputBudget(advisorContextWindow: number | undefined, budget: ContextBudget): number {
	const window = advisorContextWindow ?? 32_000;
	// Floor the reserve at a sane minimum; never let it eat the whole window.
	const reserve = Math.min(budget.responseReserveTokens, Math.floor(window * 0.5));
	return Math.max(1024, window - reserve);
}

// ---------------------------------------------------------------------------
// Step 8 — assemble: the full pipeline
// ---------------------------------------------------------------------------

export interface BuildContextInput {
	/** Pi's resolved (already-compacted) session messages for the active branch. */
	sessionMessages: Message[];
	/** This advisor model's context window, from the registry. Undefined if unknown. */
	advisorContextWindow?: number;
	budget: ContextBudget;
	/** Optional closing directive (stage objective etc.) appended as a final user msg. */
	directive?: string;
}

/**
 * Run the full re-fit pipeline. Returns messages guaranteed to fit the advisor's
 * window (§I invariant: the advisor call always fits).
 *
 * Order matters: strip → cap → window. Stripping first means we never budget for
 * our own in-flight call; capping before windowing means each message is already
 * small when we count tokens for the drop decision, so the window pass makes
 * fewer, better cuts.
 */
export function buildConsultContext(input: BuildContextInput): FitResult {
	const stripped = stripInflightConsultCall(input.sessionMessages);
	const capped = applyCharCaps(stripped, input.budget);
	const maxInputTokens = deriveInputBudget(input.advisorContextWindow, input.budget);

	// Reserve room for the directive + closing marker before windowing, so the
	// window pass accounts for them. The directive is small but non-zero.
	const directiveTokens = input.directive ? estimateTokens(input.directive) + 8 : 0;
	const adjustedBudget = Math.max(1024, maxInputTokens - directiveTokens);

	const fit = fitToWindow(capped, input.budget, adjustedBudget);

	// Append the directive as a final user message (fresh evidence last — the
	// advisor's attention is strongest at the tail).
	let messages = fit.messages;
	if (input.directive) {
		const closing: UserMessage = { role: "user", content: input.directive, timestamp: Date.now() };
		messages = [...messages, closing];
	}

	return {
		messages,
		omittedCount: fit.omittedCount,
		estimatedTokens: sumTokens(messages),
		maxInputTokens,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textBlocks(content: TextContent[] | unknown): TextContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter((b): b is TextContent => b?.type === "text" && typeof b.text === "string");
}

function sumTokens(messages: Message[]): number {
	let total = 0;
	for (const m of messages) total += estimateMessageTokens(m);
	return total;
}

/** Constructor helper for tests / callers building a user message. */
export function userText(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

/** Constructor helper for tests building an assistant text message. */
export function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages" as never,
		provider: "anthropic" as never,
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Constructor helper for tests building a tool result message. */
export function toolResultText(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "test-call",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}
