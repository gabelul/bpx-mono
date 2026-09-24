import type { Message, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSeatBackend, type BpxConsultConfig } from "./config.js";
import { callCliAdvisor, cliContextWindow, type CliBackendConfig } from "./cli-backend.js";
import { callAdvisor, type ConsultCallResult, type ResolvedAdvisor } from "./advisor.js";

/** A seat's model and backend are independent; legacy model-key routing still applies. */
export interface RouteSeat {
	model?: string;
	backend?: unknown;
	cliModels?: Record<string, string>;
	cliWindows?: Record<string, number>;
	codexModel?: string;
}

export type ResolvedRoute =
	| { kind: "inline"; advisor: ResolvedAdvisor; contextWindow: number; label: string }
	| { kind: "cli"; backend: CliBackendConfig; contextWindow: number; label: string }
	| { kind: "error"; message: string };

/** Resolve backend first, avoiding a Pi-registry dependency for CLI-only models. */
export function resolveSeatRoute(
	config: BpxConsultConfig,
	seat: RouteSeat,
	resolveInline: (key: string | undefined) => ResolvedAdvisor | undefined,
): ResolvedRoute {
	const backend = resolveSeatBackend(config, seat);
	if (backend?.type === "cli") {
		const window = cliContextWindow(backend);
		if (!window) return { kind: "error", message: `CLI ${backend.command} has no known context window; set backend.contextWindow.` };
		const label = backend.model ? `cli:${backend.command}/${backend.model}` : `cli:${backend.command}`;
		return { kind: "cli", backend, contextWindow: window, label };
	}
	const advisor = resolveInline(seat.model);
	if (!advisor) return { kind: "error", message: `Could not resolve inline model ${seat.model ?? "(none)"}.` };
	return { kind: "inline", advisor, contextWindow: advisor.model.contextWindow, label: advisor.label };
}

/** Dispatch a fitted prompt through the selected CLI or Pi model. */
export async function callSeatRoute(input: {
	ctx: ExtensionContext;
	route: Exclude<ResolvedRoute, { kind: "error" }>;
	systemPrompt: string;
	messages: Message[];
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
	sessionId?: string;
	maxTokens?: number;
	onUsage?: (usage: Usage) => void;
}): Promise<ConsultCallResult> {
	const { ctx, route, systemPrompt, messages, thinkingLevel, signal, sessionId, maxTokens, onUsage } = input;
	if (route.kind === "inline") {
		return callAdvisor({ ctx, advisor: route.advisor, systemPrompt, messages, thinkingLevel, signal, sessionId, maxTokens, onUsage });
	}
	const result = await callCliAdvisor({ systemPrompt, messages, backend: route.backend, signal, cwd: ctx.cwd,
		responseReserveTokens: maxTokens });
	return {
		text: result.text,
		stopReason: result.timedOut ? "aborted" : result.text ? "stop" : "error",
		errorMessage: result.errorMessage,
		usage: undefined,
	};
}
