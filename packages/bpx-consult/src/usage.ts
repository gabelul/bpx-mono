import type { Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Collect provider-reported usage from one consultation, including failed replies and retries. */
export class ConsultUsage {
	private total: Usage | undefined;
	private sealed = false;

	/** Add one completed inline provider response; CLI calls without usage stay unknown. */
	record = (usage: Usage): void => {
		if (this.sealed) return; // A timed-out provider may finish after the tool has returned.
		if (!this.total) {
			this.total = { ...usage, cost: { ...usage.cost } };
			return;
		}
		const total = this.total;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
			total.cost[key] += usage.cost[key];
		}
		if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
		const reportedReasoning = (usage as Usage & { reasoning?: number }).reasoning;
		if (reportedReasoning !== undefined) {
			const sum = total as Usage & { reasoning?: number };
			sum.reasoning = (sum.reasoning ?? 0) + reportedReasoning;
		}
	};

	/** Publish one aggregate on a tool result, without creating a separate usage entry. */
	attach<T extends { usage?: { input: number; output: number; total: number } }>(result: AgentToolResult<T>): AgentToolResult<T> & { usage?: Usage } {
		this.sealed = true;
		if (!this.total) return result;
		const usage = this.total;
		// Pi 0.87+ reads top-level usage; older Pi versions ignore the extra field.
		return {
			...result,
			usage,
			details: { ...result.details, usage: { input: usage.input, output: usage.output, total: usage.totalTokens } } as T,
		};
	}
}
