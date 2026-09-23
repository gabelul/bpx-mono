import { spawn } from "node:child_process";
import { listCodexModels, type CodexModel } from "./codex-models.js";

/** Models advertised by a supported CLI; Claude has no stable list command. */
export async function listCliModels(command: string, cwd?: string, signal?: AbortSignal, executable?: string): Promise<CodexModel[]> {
	if (command === "codex") return listCodexModels(cwd, signal, executable);
	if (command !== "opencode") return [];
	return listOpenCodeModels(cwd, signal, executable);
}

/** Read `opencode models` without trusting its catalog as account entitlement. */
async function listOpenCodeModels(cwd?: string, parentSignal?: AbortSignal, executable = "opencode"): Promise<CodexModel[]> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) onAbort();
	else parentSignal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("OpenCode model discovery timed out")), 10_000);
	const child = spawn(executable, ["models", "--verbose"], { cwd, signal: controller.signal, stdio: ["ignore", "pipe", "pipe"] });
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	let output = "";
	let stderr = "";
	let bytes = 0;
	try {
		await new Promise<void>((resolve, reject) => {
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				bytes += Buffer.byteLength(chunk, "utf8");
				if (bytes > 1_000_000) return reject(new Error("OpenCode model list exceeded output limit"));
				output += chunk;
			});
			child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
			child.on("error", reject);
			child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`OpenCode model discovery exited ${code ?? "unknown"}: ${stderr}`)));
		});
		const models = new Map<string, CodexModel>();
		for (const match of output.matchAll(/^([^\s/]+\/[^\s]+)\r?\n(\{[\s\S]*?^\})/gm)) {
			const id = match[1]!;
			let contextWindow: number | undefined;
			try {
				const info = JSON.parse(match[2]!) as { limit?: { context?: number; input?: number } };
				const limit = info.limit;
				const cap = Math.min(limit?.context ?? Infinity, limit?.input ?? Infinity);
				if (Number.isFinite(cap) && cap > 0) contextWindow = cap;
			} catch { /* Keep ID; an unknown window must be entered explicitly. */ }
			models.set(id, { id, displayName: id, ...(contextWindow ? { contextWindow } : {}) });
		}
		if (!models.size) throw new Error("OpenCode returned no model metadata");
		return [...models.values()];
	} catch (error) {
		if (controller.signal.aborted && !parentSignal?.aborted) throw new Error("OpenCode model discovery timed out", { cause: error });
		throw error;
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onAbort);
		if (child.exitCode === null) child.kill();
		const killTimer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000);
		try { await closed; } finally { clearTimeout(killTimer); }
	}
}
