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
 *
 * ── §E.1 evidence-aware fit ────────────────────────────────────────────────
 * v1 fit was pure recency-slicing (first-2 + last-N) plus uniform char-caps.
 * That guarantees the window (§I) but optimizes for "don't error," not "keep the
 * evidence that decides the answer" — it char-truncates the exact artifact the
 * advisor needs and treats recency as a proxy for relevance. §E.1 replaces the
 * fit STRATEGY (not the helpers): classify every message by artifact type
 * (evidence.ts, deterministic), fill the window BY PRIORITY, then — and this is
 * the load-bearing part — assemble the EXACT final payload and re-check tokens on
 * that assembled string, reducing until it genuinely fits.
 *
 * Two hardened rules from a Codex design review, implemented exactly here:
 *   RULE A — validate on the FINAL assembled string, never per-bucket sums.
 *            Role headers, separators, markers, and the directive all add tokens
 *            AFTER the fill loop, so the fill math is provisional; only
 *            `sumTokens(assembled)` is authoritative. See `finalReduce`.
 *   RULE B — pinned = "retain a representation," not "keep verbatim." Precedence:
 *            global-window-fit > pinned-representation > bucket-cap >
 *            verbatim-fidelity. A pinned item degrades kept→compressed→clipped
 *            (anchors preserved) but NEVER to dropped. If even minimal pinned
 *            stubs can't fit, FAIL CLOSED (return an error, never an oversized
 *            payload). See `representPinned` + the fail-closed branch.
 *
 * The v1 helpers (estimateTokens, deriveInputBudget, clampText, clampSurvivor,
 * applyCharCaps, stripInflightConsultCall, fitToWindow) stay INTACT — they're
 * reused by the new strategy and still exported for the existing tests.
 */

import type { Message, UserMessage, AssistantMessage, ToolResultMessage, TextContent } from "@earendil-works/pi-ai";
import {
	classifyMessages,
	PINNED_TAGS,
	type ClassifiedMessage,
	type Disposition,
	type EvidenceLedgerEntry,
	type EvidenceTag,
} from "./evidence.js";

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
	/**
	 * Per-message audit ledger (§E.0): what was kept/compressed/clipped/dropped and
	 * why. The measurement instrument that makes a bad consult debuggable. Empty
	 * for callers that build a one-off synthesizer/debate prompt (no transcript).
	 */
	ledger: EvidenceLedgerEntry[];
	/**
	 * Set ONLY on the fail-closed path (§E.1 RULE B): even the minimal pinned
	 * stubs couldn't fit the window. `messages` is then a safe minimal payload (or
	 * empty) and the caller must surface this as a clean "couldn't fit advisor
	 * window" error rather than forwarding an oversized context (which reopens §P).
	 */
	error?: string;
}

/** Roll the ledger up to the compact counts surfaced in tool-result details. */
export interface LedgerSummary {
	kept: number;
	compressed: number;
	clipped: number;
	dropped: number;
}

/** Summarise a ledger to {kept, compressed, clipped, dropped} counts for telemetry. */
export function summarizeLedger(ledger: EvidenceLedgerEntry[]): LedgerSummary {
	const summary: LedgerSummary = { kept: 0, compressed: 0, clipped: 0, dropped: 0 };
	for (const entry of ledger) summary[entry.disposition]++;
	return summary;
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
/**
 * Repair tool_use / tool_result pairing after window-fit truncation.
 *
 * The sliding window keeps first-N + last-M and drops the middle. That can
 * split a pair: a toolCall in the dropped middle with its toolResult in the
 * kept tail (orphan result), or a toolCall in the kept head/tail with its
 * toolResult dropped (dangling call). Anthropic and other strict providers
 * reject both with a 400 ("unexpected tool_use_id" / missing tool_result) —
 * the exact §P failure the extension exists to prevent. Truncation reopened
 * it; this closes it again.
 *
 * Bidirectional: drop any toolResult whose call isn't in the kept window, and
 * drop any toolCall whose result isn't either. An assistant message emptied by
 * call-dropping is removed whole. Idempotent.
 */
export function repairToolPairing(messages: Message[]): Message[] {
	// Call ids present in kept assistant messages.
	const presentCallIds = new Set<string>();
	for (const m of messages) {
		if (m.role === "assistant") {
			for (const b of m.content) {
				if (b.type === "toolCall" && typeof b.id === "string") presentCallIds.add(b.id);
			}
		}
	}
	// Call ids that still have a kept tool-result.
	const resolvedCallIds = new Set<string>();
	for (const m of messages) {
		if (m.role === "toolResult" && typeof m.toolCallId === "string" && presentCallIds.has(m.toolCallId)) {
			resolvedCallIds.add(m.toolCallId);
		}
	}

	const repaired: Message[] = [];
	for (const m of messages) {
		if (m.role === "toolResult") {
			// Orphan result — its call was dropped. Drop the result too.
			if (!presentCallIds.has(m.toolCallId)) continue;
			repaired.push(m);
			continue;
		}
		if (m.role === "assistant") {
			// Drop toolCall blocks whose result was cut (dangling call). Text and
			// thinking blocks survive — only the orphan call goes.
			const kept = m.content.filter(
				(b) => !(b.type === "toolCall" && typeof b.id === "string" && !resolvedCallIds.has(b.id)),
			);
			if (kept.length === 0) continue; // assistant now empty — drop the message
			repaired.push(kept.length === m.content.length ? m : { ...m, content: kept });
			continue;
		}
		repaired.push(m);
	}
	return repaired;
}

export function fitToWindow(messages: Message[], budget: ContextBudget, maxInputTokens: number): FitResult {
	if (messages.length === 0) {
		return { messages: [], omittedCount: 0, estimatedTokens: 0, maxInputTokens, ledger: [] };
	}

	// Quick path: already fits.
	const whole = sumTokens(messages);
	if (whole <= maxInputTokens) {
		return { messages, omittedCount: 0, estimatedTokens: whole, maxInputTokens, ledger: [] };
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
		// Repair tool_use/tool_result pairing across the head+tail boundary —
		// truncation can orphan a result whose call was dropped (or dangle a call
		// whose result was dropped), which Anthropic rejects. See repairToolPairing.
		const repaired = repairToolPairing([...head, ...tail]);
		const candidate = [...repaired.slice(0, head.length), marker, ...repaired.slice(head.length)];
		if (sumTokens(candidate) <= maxInputTokens) {
			return { messages: candidate, omittedCount: omittedCount + (head.length + tail.length - repaired.length), estimatedTokens: sumTokens(candidate), maxInputTokens, ledger: [] };
		}
		keepLast--;
	}

	// Last resort: keep only the final message, capped. The cap pass already ran
	// but re-clamp the survivor aggressively to whatever budget remains.
	const only = messages[messages.length - 1];
	const omittedCount = messages.length - 1;
	const marker = omittedMarker(omittedCount);
	const survivor = clampSurvivor(only, maxInputTokens - sumTokens([marker]));
	// A lone surviving toolResult would be an orphan (no call in-window) — repair
	// drops it; if that leaves nothing, send the marker alone rather than crash.
	const repairedLast = repairToolPairing([survivor]);
	const candidate = repairedLast.length > 0 ? [marker, ...repairedLast] : [marker];
	return { messages: candidate, omittedCount, estimatedTokens: sumTokens(candidate), maxInputTokens, ledger: [] };
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
 * Run the full evidence-aware re-fit pipeline (§E.1). Returns messages guaranteed
 * to fit the advisor's window (§I: the advisor call always fits), plus the audit
 * ledger (§E.0) recording what happened to every message.
 *
 * The pipeline:
 *   1. strip the in-flight consult() call (never budget for our own call)
 *   2. classify every message by artifact type (evidence.ts, deterministic)
 *   3. priority-fill PROVISIONALLY — select highest-priority first, track a
 *      running budget, but treat those per-message sums as estimates only
 *   4. assemble the EXACT final Message[] (kept re-sorted chronological +
 *      directive + all markers), then run the FINAL re-check (RULE A) and a
 *      deterministic reduce loop until sumTokens(assembled) genuinely fits
 *   5. pinned items degrade kept→compressed→clipped, never dropped (RULE B); if
 *      even minimal pinned stubs can't fit, FAIL CLOSED with an error signal
 *
 * The v1 recency path (`fitToWindow`) is kept for the empty-transcript quick exit
 * and remains exported for the existing tests, but the transcript fit now flows
 * through the priority strategy below.
 */
export function buildConsultContext(input: BuildContextInput): FitResult {
	const stripped = stripInflightConsultCall(input.sessionMessages);
	const maxInputTokens = deriveInputBudget(input.advisorContextWindow, input.budget);

	// Reserve room for the directive + a fixed marker/metadata reserve off the top
	// (§E.1 ladder step 1). The directive is appended last (freshest evidence at the
	// tail); the marker reserve covers omission/compression/clip markers we add
	// during assembly. Both are subtracted BEFORE the fill so the provisional math
	// starts honest — RULE A still re-checks the assembled string regardless.
	const directive = input.directive?.trim() || undefined;
	const directiveTokens = directive ? estimateTokens(directive) + 8 : 0;
	const markerReserve = MARKER_RESERVE_TOKENS;
	const fillBudget = Math.max(256, maxInputTokens - directiveTokens - markerReserve);

	// Empty transcript: nothing to fit but the directive. Assemble + final-check it.
	if (stripped.length === 0) {
		const empty = assembleAndReduce([], [], directive, maxInputTokens, input.budget);
		return { ...empty, messages: repairToolPairing(empty.messages) };
	}

	// 2. Classify. Deterministic tags drive priority — no model judgment (§E.0).
	const classified = classifyMessages(stripped);

	// 3. Priority-fill (PROVISIONAL). Returns a per-index plan of dispositions,
	//    plus the kept/compressed/clipped items (already representation-degraded
	//    for pinned overflows per RULE B).
	const plan = priorityFill(classified, input.budget, fillBudget);

	// 4. Assemble the EXACT final payload (kept re-sorted chronological + markers +
	//    directive) and run RULE A: re-check on the assembled string, reduce until
	//    it genuinely fits. RULE B / fail-closed live inside assembleAndReduce.
	const assembled = assembleAndReduce(plan.selected, plan.ledger, directive, maxInputTokens, input.budget);
	// 5. Repair tool_use/tool_result pairing unconditionally. The priority-fill /
	//    assemble steps can drop a message from one half of a pair (a toolCall's
	//    assistant turn, or a toolResult) without dropping the other — leaving an
	//    orphan that strict providers (Anthropic) reject with a 400. This is the
	//    §P failure the extension exists to prevent; truncation reopens it, so we
	//    close it at the boundary, on every build, regardless of which path ran.
	//    Idempotent and marker/directive-safe (it only touches tool blocks/results).
	return { ...assembled, messages: repairToolPairing(assembled.messages) };
}

// ---------------------------------------------------------------------------
// §E.1 — evidence-aware priority fit
// ---------------------------------------------------------------------------

/**
 * Fixed reserve (tokens) held back for the omission/compression/clip markers and
 * role separators that assembly adds AFTER the fill loop. RULE A re-checks the
 * assembled string anyway, so this is belt-and-braces: it just makes the first
 * assembly land under budget more often, cutting reduce-loop iterations.
 */
const MARKER_RESERVE_TOKENS = 96;

/**
 * A selected item on its way to assembly: the original classified message, the
 * disposition the fill chose, and (for compressed/clipped) the text to render.
 */
interface SelectedItem {
	classified: ClassifiedMessage;
	disposition: Exclude<Disposition, "dropped">;
	/** Rendered text for compressed/clipped; undefined means "keep the message verbatim". */
	rendered?: string;
}

/**
 * Priority order for the fill (§E.1 ladder). Lower number = filled first =
 * dropped last. Pinned tags occupy the top tiers; the recent tail is verbatim
 * while budget allows; older transcript compresses to signals; the rest drops.
 */
function priorityOf(tag: EvidenceTag): number {
	switch (tag) {
		case "question":
			return 0; // the ask itself
		case "directive":
		case "acceptance":
			return 1; // task framing (pinned)
		case "failing-output":
		case "stack-trace":
		case "diff":
			return 2; // the payload — latest failure + latest diff (pinned when latest)
		case "reviewer-finding":
		case "repeated-failure":
			return 3; // other pinned artifacts
		case "test":
		case "edited-file":
			return 4; // recent evidence of what was tried
		case "exploration":
			return 5; // reads/searches — compressible path
		case "other":
		default:
			return 6; // assistant chatter — compress/drop first
	}
}

/**
 * The provisional priority-fill. Selects items highest-priority-first under a
 * running token budget. Pinned items are ALWAYS selected — if a pinned item won't
 * fit verbatim it's degraded (kept→compressed→clipped, RULE B) rather than
 * skipped. Non-pinned items are kept verbatim while budget allows; once the
 * budget tightens, recent-tail non-pinned items compress to their signal
 * one-liner, and the rest are dropped. Every message gets a ledger row.
 *
 * "Provisional" is the operative word: the budget math here uses per-message
 * estimates and does NOT count assembly overhead. RULE A (assembleAndReduce) is
 * what makes the fit real.
 */
function priorityFill(
	classified: ClassifiedMessage[],
	budget: ContextBudget,
	fillBudget: number,
): { selected: SelectedItem[]; ledger: EvidenceLedgerEntry[] } {
	// The recent tail is kept verbatim by preference — freshest evidence. We treat
	// the last `keepLast` messages as "recent" for the verbatim-vs-compress call.
	const recentThreshold = classified.length - budget.keepLast;

	// Order the fill by priority, then by recency within a tier (newest first, so
	// the latest payload wins ties). Stable-ish: map to (priority, -index).
	const order = [...classified].sort((a, b) => {
		const pa = priorityOf(a.tag);
		const pb = priorityOf(b.tag);
		if (pa !== pb) return pa - pb;
		return b.index - a.index; // newer first within a tier
	});

	const selectedByIndex = new Map<number, SelectedItem>();
	const ledgerByIndex = new Map<number, EvidenceLedgerEntry>();
	let used = 0;

	for (const c of order) {
		const verbatimTokens = estimateMessageTokens(c.message);
		const isPinned = c.pinned;
		const isRecent = c.index >= recentThreshold;
		const remaining = fillBudget - used;

		if (isPinned) {
			// RULE B: pinned always retains a representation. Try verbatim, then
			// compressed (signal), then clipped (anchors). Never dropped here.
			if (verbatimTokens <= remaining) {
				selectedByIndex.set(c.index, { classified: c, disposition: "kept" });
				ledgerByIndex.set(c.index, row(c, "kept", `pinned ${c.tag}: fits verbatim`));
				used += verbatimTokens;
				continue;
			}
			const compressed = c.signal;
			const compressedTokens = estimateTokens(compressed);
			if (compressedTokens <= remaining) {
				selectedByIndex.set(c.index, { classified: c, disposition: "compressed", rendered: compressed });
				ledgerByIndex.set(c.index, row(c, "compressed", `pinned ${c.tag}: over budget, kept signal`));
				used += compressedTokens;
				continue;
			}
			// Clip to an anchored stub sized to whatever budget is left (or a floor —
			// assembleAndReduce's final reduce is the real guarantee, so a small
			// overshoot here is corrected there).
			const clipBudget = Math.max(MIN_PINNED_STUB_TOKENS, remaining);
			const clipped = clipWithAnchors(c, clipBudget);
			const clippedTokens = estimateTokens(clipped);
			selectedByIndex.set(c.index, { classified: c, disposition: "clipped", rendered: clipped });
			ledgerByIndex.set(c.index, row(c, "clipped", `pinned ${c.tag}: clipped to anchors`));
			used += clippedTokens;
			continue;
		}

		// Non-pinned. Keep verbatim while there's comfortable room.
		if (verbatimTokens <= remaining) {
			selectedByIndex.set(c.index, { classified: c, disposition: "kept" });
			ledgerByIndex.set(c.index, row(c, "kept", `${c.tag}: fits verbatim`));
			used += verbatimTokens;
			continue;
		}

		// Budget tightening. Recent non-pinned items compress to their signal so the
		// path stays visible; older ones drop (§E.1: compress the path, preserve the
		// payload). Exploration always prefers compression to a bare drop when recent.
		if (isRecent) {
			const compressed = c.signal;
			const compressedTokens = estimateTokens(compressed);
			if (compressedTokens <= remaining) {
				selectedByIndex.set(c.index, { classified: c, disposition: "compressed", rendered: compressed });
				ledgerByIndex.set(c.index, row(c, "compressed", `${c.tag}: recent tail, compressed to signal`));
				used += compressedTokens;
				continue;
			}
		}

		// No room (or older): drop, but never silently — the ledger records it.
		ledgerByIndex.set(c.index, row(c, "dropped", `${c.tag}: over budget, dropped`));
	}

	// Emit selected + ledger in chronological order (re-sort — §E.1 reassembly:
	// the advisor should read a coherent timeline, not a priority-ordered jumble).
	const selected = [...selectedByIndex.values()].sort((a, b) => a.classified.index - b.classified.index);
	const ledger = [...ledgerByIndex.values()].sort((a, b) => a.index - b.index);
	return { selected, ledger };
}

/** Minimum token floor for a clipped pinned stub — enough to carry the anchors. */
const MIN_PINNED_STUB_TOKENS = 48;

function row(c: ClassifiedMessage, disposition: Disposition, reason: string): EvidenceLedgerEntry {
	return { index: c.index, tag: c.tag, disposition, reason };
}

/**
 * Clip a pinned item to its ANCHORS with explicit markers (§E.1 RULE B / last
 * resort). The anchor depends on the artifact:
 *   - directive/question/acceptance → head + tail (the ask survives even clipped)
 *   - failure/stack-trace           → command/exit + error head + tail
 *   - diff                          → file headers + nearest changed hunks
 *   - other                         → head + tail
 * Always marked so the advisor knows content was cut. Sized to `budgetTokens`.
 */
function clipWithAnchors(c: ClassifiedMessage, budgetTokens: number): string {
	const full = stringifyMessageForEstimate(c.message);
	const maxChars = Math.max(MIN_PINNED_STUB_TOKENS * CHARS_PER_TOKEN, Math.floor((budgetTokens * CHARS_PER_TOKEN) / SAFETY_FACTOR));
	if (full.length <= maxChars) return full;

	// Split the char budget between a head and a tail so both anchors survive.
	const half = Math.max(24, Math.floor(maxChars / 2) - 16);
	const head = full.slice(0, half).trimEnd();
	const tail = full.slice(-half).trimStart();

	if (c.tag === "diff") {
		// Diff anchor: keep any file-header lines (+++/---/@@) up front, then the
		// nearest hunk head+tail. The headers tell the advisor WHICH file changed
		// even when the body is clipped.
		const headers = full
			.split("\n")
			.filter((l) => l.startsWith("+++") || l.startsWith("---") || l.startsWith("@@"))
			.slice(0, 6)
			.join("\n");
		return `[clipped diff — file headers + nearest hunks]\n${headers}\n…\n${head}\n…[hunk clipped]…\n${tail}`;
	}

	if (c.tag === "failing-output" || c.tag === "stack-trace" || c.tag === "repeated-failure") {
		// Failure anchor: the signal one-liner already carries command/exit; keep it
		// as the header, then head+tail of the error body (top frame + final message).
		return `[clipped ${c.tag} — ${c.signal}]\n${head}\n…[middle clipped]…\n${tail}`;
	}

	// directive / question / acceptance / other: head + tail of the text.
	return `[clipped ${c.tag} — head+tail preserved]\n${head}\n…[middle clipped]…\n${tail}`;
}

// ---------------------------------------------------------------------------
// §E.1 — assemble the EXACT final payload + RULE A final re-check
// ---------------------------------------------------------------------------

/**
 * Turn selected items + directive into the final Message[], then RULE A: estimate
 * tokens over the FULL assembled payload and, if it exceeds the window, run a
 * deterministic reduce loop until it genuinely fits. This is the §I guarantee —
 * we NEVER return before this final check passes.
 *
 * Reduce order (lowest-priority first): drop non-pinned dropped-eligible items,
 * then compress non-pinned kept items to signals, then degrade pinned
 * kept→compressed→clipped. If even the minimal pinned stubs + directive can't fit,
 * FAIL CLOSED (RULE B): return an error signal with a safe minimal payload — never
 * an oversized context.
 */
function assembleAndReduce(
	selected: SelectedItem[],
	ledger: EvidenceLedgerEntry[],
	directive: string | undefined,
	maxInputTokens: number,
	budget: ContextBudget,
): FitResult {
	// Working copy of dispositions we can mutate during reduce. Keyed by index.
	const work = new Map<number, SelectedItem>();
	for (const s of selected) work.set(s.classified.index, s);
	const ledgerMap = new Map<number, EvidenceLedgerEntry>();
	for (const e of ledger) ledgerMap.set(e.index, e);

	const droppedInFill = ledger.filter((e) => e.disposition === "dropped").length;

	// Deterministic reduce loop. Each pass: assemble, check, and if still over,
	// degrade the single highest-cost lowest-priority item one step. Bounded by the
	// number of items × 3 degradation steps, so it always terminates.
	const maxPasses = selected.length * 3 + 4;
	for (let pass = 0; pass <= maxPasses; pass++) {
		const items = [...work.values()].sort((a, b) => a.classified.index - b.classified.index);
		const { messages, omittedCount } = renderMessages(items, directive, droppedInFill);
		const tokens = sumTokens(messages);

		if (tokens <= maxInputTokens) {
			return {
				messages,
				omittedCount,
				estimatedTokens: tokens,
				maxInputTokens,
				ledger: finalizeLedger(ledgerMap, work),
			};
		}

		// Over budget. Pick the lowest-priority, most-expensive item to degrade.
		const victim = pickReduceVictim(items);
		if (!victim) break; // nothing left to degrade → fail-closed below

		degradeOneStep(victim, ledgerMap, budget);
	}

	// FAIL CLOSED (§E.1 RULE B). We degraded everything degradable and still don't
	// fit — the near-impossible case (a window too small for even the minimal
	// pinned stubs + directive). Return an error signal with a SAFE minimal payload
	// (the directive alone, itself clamped) so solo.ts can emit a clean
	// "couldn't fit advisor window" error rather than overflow (which reopens §P).
	const minimal = failClosedPayload(directive, maxInputTokens);
	return {
		messages: minimal,
		omittedCount: selected.length,
		estimatedTokens: sumTokens(minimal),
		maxInputTokens,
		ledger: finalizeLedger(ledgerMap, work),
		error: "couldn't fit advisor window: even the minimal pinned evidence exceeds the target model's context",
	};
}

/**
 * Render selected items (chronological) + directive into a Message[], inserting a
 * single omission marker if anything was dropped. Compressed/clipped items become
 * a user text message carrying their rendered signal/stub; kept items pass
 * through verbatim.
 */
function renderMessages(
	items: SelectedItem[],
	directive: string | undefined,
	droppedCount: number,
): { messages: Message[]; omittedCount: number } {
	const out: Message[] = [];
	let renderedOmissionMarker = false;
	let dropped = droppedCount;

	// If items were dropped, lead with one omission marker so the advisor knows the
	// timeline has gaps (no silent drops — §E.5).
	if (dropped > 0) {
		out.push(omittedMarker(dropped));
		renderedOmissionMarker = true;
	}

	for (const item of items) {
		if (item.disposition === "kept") {
			out.push(item.classified.message);
		} else {
			// compressed / clipped → a user text message carrying the rendered text,
			// prefixed so the advisor sees it's a signal, not verbatim content.
			const prefix = item.disposition === "compressed" ? "[signal]" : "[clipped]";
			out.push({
				role: "user",
				content: `${prefix} ${item.rendered ?? item.classified.signal}`,
				timestamp: messageTimestamp(item.classified.message),
			});
		}
	}

	if (directive) {
		out.push({ role: "user", content: directive, timestamp: Date.now() });
	}

	// omittedCount reported = items dropped in fill (+ any dropped during reduce,
	// which are already reflected because they're absent from `items`).
	void renderedOmissionMarker;
	return { messages: out, omittedCount: dropped };
}

/** The lowest-priority, most-expensive still-degradable item, or undefined. */
function pickReduceVictim(items: SelectedItem[]): SelectedItem | undefined {
	// Degradable = not already clipped (clipped is the terminal representation).
	// Prefer non-pinned over pinned, higher priority-number (lower value) first,
	// then larger current footprint.
	const degradable = items.filter((i) => i.disposition !== "clipped");
	if (degradable.length === 0) return undefined;
	return degradable
		.map((i) => ({
			i,
			pinned: i.classified.pinned ? 1 : 0,
			prio: priorityOf(i.classified.tag),
			cost: currentTokens(i),
		}))
		.sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned - b.pinned; // non-pinned first
			if (a.prio !== b.prio) return b.prio - a.prio; // lowest priority (highest number) first
			return b.cost - a.cost; // most expensive first
		})[0].i;
}

/** Degrade one item one step: kept→compressed→clipped, updating its ledger row. */
function degradeOneStep(item: SelectedItem, ledgerMap: Map<number, EvidenceLedgerEntry>, _budget: ContextBudget): void {
	const c = item.classified;
	if (item.disposition === "kept") {
		item.disposition = "compressed";
		item.rendered = c.signal;
		setLedger(ledgerMap, c, "compressed", `${c.tag}: reduced to signal on final re-check`);
		return;
	}
	if (item.disposition === "compressed") {
		item.disposition = "clipped";
		item.rendered = clipWithAnchors(c, MIN_PINNED_STUB_TOKENS);
		setLedger(ledgerMap, c, "clipped", `${c.tag}: clipped to anchors on final re-check`);
		return;
	}
	// Already clipped — nothing more to do (pinned can't drop; pickReduceVictim
	// won't return clipped items anyway).
}

/** Tokens the item currently costs in its chosen representation. */
function currentTokens(item: SelectedItem): number {
	if (item.disposition === "kept") return estimateMessageTokens(item.classified.message);
	return estimateTokens(item.rendered ?? item.classified.signal);
}

function setLedger(ledgerMap: Map<number, EvidenceLedgerEntry>, c: ClassifiedMessage, disposition: Disposition, reason: string): void {
	ledgerMap.set(c.index, { index: c.index, tag: c.tag, disposition, reason });
}

/**
 * Merge the working dispositions back into the ledger. `work` holds the final
 * disposition of every SELECTED item; `ledgerMap` also carries the dropped rows.
 * Items that were selected but then dropped during reduce aren't in `work`, so
 * their ledger row (last written by degrade/drop) already reflects reality.
 */
function finalizeLedger(ledgerMap: Map<number, EvidenceLedgerEntry>, work: Map<number, SelectedItem>): EvidenceLedgerEntry[] {
	for (const [index, item] of work) {
		const existing = ledgerMap.get(index);
		// Keep the richer reason if the disposition still matches; otherwise sync.
		if (!existing || existing.disposition !== item.disposition) {
			ledgerMap.set(index, {
				index,
				tag: item.classified.tag,
				disposition: item.disposition,
				reason: existing?.reason ?? `${item.classified.tag}: ${item.disposition}`,
			});
		}
	}
	return [...ledgerMap.values()].sort((a, b) => a.index - b.index);
}

/**
 * The fail-closed minimal payload: the directive alone, clamped to fit. If there's
 * no directive, an empty payload — the caller sees `error` set and surfaces it.
 */
function failClosedPayload(directive: string | undefined, maxInputTokens: number): Message[] {
	if (!directive) return [];
	const survivor = clampSurvivor({ role: "user", content: directive, timestamp: Date.now() }, maxInputTokens);
	return [survivor];
}

function messageTimestamp(msg: Message): number {
	return "timestamp" in msg && typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
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
