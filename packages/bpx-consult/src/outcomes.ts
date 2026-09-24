import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const OUTCOME_ENTRY_TYPE = "bpx-consult-outcome";
let navigationGeneration = 0;

/** Invalidate detached advice as soon as session navigation starts. */
export function registerConsultationNavigation(pi: ExtensionAPI): void {
	navigationGeneration++;
	const invalidate = () => { navigationGeneration++; };
	pi.on("session_before_tree", invalidate);
	pi.on("session_tree", invalidate);
	pi.on("session_before_switch", invalidate);
	pi.on("session_before_fork", invalidate);
	pi.on("session_shutdown", invalidate);
	pi.on("session_start", invalidate);
}

type OutcomeField = "used" | "helped";
type LabelValue = boolean | null;

export interface ConsultationRecord {
	id: string;
	mode: string;
	source: "tool" | "phrase" | "auto" | "share";
	used?: LabelValue;
	helped?: LabelValue;
}

interface ConsultationEntry {
	version: 1;
	kind: "consultation";
	id: string;
	mode: string;
	source: "phrase" | "auto" | "share";
}

interface LabelEntry {
	version: 1;
	kind: "label";
	id: string;
	used?: LabelValue;
	helped?: LabelValue;
}

/** Create a non-content-bearing identifier for one advisor invocation. */
export function newConsultationId(): string {
	return randomUUID();
}

/** Capture the active branch before an asynchronous consultation starts. */
export function consultationOrigin(ctx: ExtensionContext): { sessionId: string; anchor: string | null; generation: number } {
	return { sessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), generation: navigationGeneration };
}

/** Prevent late advice and metadata from leaking into a different session or branch. */
export function isCurrentOrigin(ctx: ExtensionContext, origin: ReturnType<typeof consultationOrigin>): boolean {
	try {
		return navigationGeneration === origin.generation && ctx.sessionManager.getSessionId() === origin.sessionId &&
			(origin.anchor === null || ctx.sessionManager.getBranch().some((entry) => entry.id === origin.anchor));
	} catch {
		// Pi invalidates old context getters after session replacement.
		return false;
	}
}

/** Persist only ID, mode, and source for non-tool consults; never advice or question text. */
export function recordConsultation(pi: ExtensionAPI, id: string, mode: string, source: ConsultationEntry["source"]): void {
	pi.appendEntry(OUTCOME_ENTRY_TYPE, { version: 1, kind: "consultation", id, mode, source } satisfies ConsultationEntry);
}

/** Reconstruct visible consultations and user labels from the active session branch. */
export function listConsultations(entries: SessionEntry[]): ConsultationRecord[] {
	const records = new Map<string, ConsultationRecord>();
	const labels: LabelEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "consult") {
			const details = entry.message.details as { consultationId?: unknown; mode?: unknown; requestedMode?: unknown } | undefined;
			if (typeof details?.consultationId === "string" && details.consultationId && typeof details.mode === "string") {
				records.set(details.consultationId, { id: details.consultationId,
					mode: typeof details.requestedMode === "string" ? details.requestedMode : details.mode, source: "tool" });
			}
		}
		if (entry.type !== "custom" || entry.customType !== OUTCOME_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as Record<string, unknown>;
		if (data.version !== 1 || typeof data.id !== "string" || !data.id) continue;
		if (data.kind === "consultation" && typeof data.mode === "string" &&
			(data.source === "phrase" || data.source === "auto" || data.source === "share")) {
			records.set(data.id, { id: data.id, mode: data.mode, source: data.source });
		} else if (data.kind === "label") {
			const label: LabelEntry = { version: 1, kind: "label", id: data.id };
			if (typeof data.used === "boolean" || data.used === null) label.used = data.used;
			if (typeof data.helped === "boolean" || data.helped === null) label.helped = data.helped;
			labels.push(label);
		}
	}
	for (const label of labels) {
		const record = records.get(label.id);
		if (!record) continue;
		for (const field of ["used", "helped"] as const) {
			if (Object.hasOwn(label, field) && (typeof label[field] === "boolean" || label[field] === null)) record[field] = label[field];
		}
	}
	return [...records.values()];
}

/** Parse a full user-authored label command before any persistence happens. */
export function parseLabels(args: string): { id: string; labels: Partial<Record<OutcomeField, LabelValue>> } | undefined {
	const parts = args.trim().split(/\s+/);
	if (parts.length !== 3 && parts.length !== 5) return undefined;
	const [id, ...pairs] = parts;
	if (!id) return undefined;
	const labels: Partial<Record<OutcomeField, LabelValue>> = {};
	for (let i = 0; i < pairs.length; i += 2) {
		const field = pairs[i];
		const value = pairs[i + 1];
		if ((field !== "used" && field !== "helped") || Object.hasOwn(labels, field)) return undefined;
		if (value !== "yes" && value !== "no" && value !== "unknown") return undefined;
		labels[field] = value === "unknown" ? null : value === "yes";
	}
	return { id, labels };
}

/** Save explicit human-reported labels; unknown clears one field without erasing history. */
export function recordLabels(pi: ExtensionAPI, id: string, labels: Partial<Record<OutcomeField, LabelValue>>): void {
	pi.appendEntry(OUTCOME_ENTRY_TYPE, { version: 1, kind: "label", id, ...labels } satisfies LabelEntry);
}
