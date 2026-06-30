/**
 * messages — constants: tool name, labels, and the error/advisory strings.
 *
 * Kept in one place so the tool description, error results, and UI labels all
 * reference the same source. The tone matches the persona: direct, no slop.
 */

export const CONSULT_TOOL_NAME = "consult";
export const TOOL_LABEL = "consult";

export const CONSULT_DESCRIPTION =
	"Escalate to an advisor model for guidance. When you need stronger judgment — " +
	"a complex decision, an ambiguous failure, a problem you're circling without progress — " +
	"call consult() and the conversation is forwarded to a reviewer model. " +
	"Takes optional { mode, persona, question }. No args → solo (one advisor model). " +
	"Use mode: \"council\" for a multi-model consensus, \"debate\" for adversarial, " +
	"\"gut-check\" for a fast cheap read. The advisor sees the task and every tool call you've made.";

export const DEFAULT_PROMPT_SNIPPET =
	"Escalate to an advisor model for guidance when stuck, before substantive work, or before declaring done";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Call `consult` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (finding files, fetching a source, seeing what's there) is not substantive work; writing, editing, and declaring an answer are.",
	"Also call `consult` when you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.",
	"Also call `consult` when stuck — errors recurring, approach not converging, results that don't fit — or when considering a change of approach.",
	"On tasks longer than a few steps, call `consult` at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling.",
	"Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt — a passing self-test is not evidence the advice is wrong, it's evidence your test doesn't check what the advice is checking.",
];

// --- Error / advisory text (returned to the executor as tool result text) ---

export const ERR_NO_MODEL = "No advisor model configured. Run /consult to pick one.";
export const ERR_NO_MODEL_DETAIL = "No advisor model is set. Open the picker with /consult, or set modes.solo.model in ~/.pi/agent/bpx-consult.json.";
export const ERR_NO_API_KEY = (label: string) => `No API key for ${label}. Check ~/.pi/agent/auth.json or run /login.`;
export const ERR_NO_API_KEY_DETAIL = (provider: string) => `Provider ${provider} has no configured auth. Add a key via /login or models.json.`;
export const ERR_CALL_ABORTED = "Advisor call aborted.";
export const ERR_ABORTED_DETAIL = "The advisor call was aborted (user cancel or session end).";
export const ERR_EMPTY_RESPONSE = "Advisor returned no usable text.";
export const ERR_EMPTY_RESPONSE_DETAIL = "The advisor replied with no text content (reasoning-only or empty). Retry, or pick a different advisor model.";
export const errCallFailed = (detail?: string) => `Advisor call failed${detail ? `: ${detail}` : "."}`;
export const errCallThrew = (detail: string) => `Advisor call threw: ${detail}`;
export const errMisconfigured = (label: string, detail?: string) =>
	`Advisor ${label} is misconfigured${detail ? ` (${detail})` : ""}. Fix in /consult or the config file.`;

// --- UI status text ---

export const msgConsulting = (label: string) => `Consulting ${label}…`;
export const msgAdvisorEnabled = (label: string) => `consult on — ${label}`;
export const msgAdvisorDisabled = "consult off";
