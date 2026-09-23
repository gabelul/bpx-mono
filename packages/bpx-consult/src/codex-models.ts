import { spawn } from "node:child_process";

/** A model advertised by the Codex CLI, not pi's model registry. */
export interface CodexModel {
	id: string;
	displayName: string;
	/** Verified input-capacity ceiling when the CLI publishes one. */
	contextWindow?: number;
}

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_PAGES = 20;
const MAX_OUTPUT_BYTES = 1_000_000;

/** List Codex models through this installation's app-server protocol. */
export async function listCodexModels(cwd?: string, parentSignal?: AbortSignal, executable = "codex"): Promise<CodexModel[]> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) onAbort();
	else parentSignal?.addEventListener("abort", onAbort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, DISCOVERY_TIMEOUT_MS);
	try {
		return await queryCodexModels(cwd, controller.signal, executable);
	} catch (error) {
		if (timedOut) throw new Error("Codex model discovery timed out", { cause: error });
		throw error;
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onAbort);
	}
}

/** Run an isolated app-server, page through model/list, then close only that process. */
async function queryCodexModels(cwd: string | undefined, signal: AbortSignal, executable: string): Promise<CodexModel[]> {
	const child = spawn(executable, ["app-server", "--stdio"], { cwd, signal, stdio: ["pipe", "pipe", "pipe"] });
	child.stdout.setEncoding("utf8");
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000); });

	try {
		return await new Promise<CodexModel[]>((resolve, reject) => {
			let buffer = "";
			let totalBytes = 0;
			let requestId = 1;
			let pages = 0;
			let settled = false;
			const models = new Map<string, CodexModel>();
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

			child.on("error", (error) => fail(error));
			child.stdin.on("error", (error) => fail(error));
			child.on("close", (code) => fail(new Error(`Codex app-server exited (${code ?? "unknown"}) before model/list completed${stderr ? `: ${stderr}` : ""}`)));
			child.stdout.on("data", (chunk: string) => {
				if (settled) return;
				totalBytes += Buffer.byteLength(chunk, "utf8");
				if (totalBytes > MAX_OUTPUT_BYTES) return fail(new Error("Codex model list exceeded output limit"));
				buffer += chunk;
				let end: number;
				while ((end = buffer.indexOf("\n")) !== -1 && !settled) {
					const line = buffer.slice(0, end).trim();
					buffer = buffer.slice(end + 1);
					if (!line) continue;
					let response: unknown;
					try { response = JSON.parse(line); }
					catch { return fail(new Error("Codex app-server returned invalid JSON")); }
					if (!response || typeof response !== "object" || Array.isArray(response)) {
						return fail(new Error("Codex app-server returned an invalid response"));
					}
					const message = response as Record<string, unknown>;
					if (message.id !== requestId) continue; // Notifications and other requests aren't this response.
					if (message.error) return fail(new Error(`Codex model discovery failed: ${JSON.stringify(message.error).slice(0, 300)}`));
					const result = message.result as Record<string, unknown> | undefined;
					if (!result || typeof result !== "object") return fail(new Error("Codex app-server returned no result"));
					if (requestId === 1) {
						send({ method: "initialized", params: {} });
						requestId = 2;
						send({ id: requestId, method: "model/list", params: { limit: 100, includeHidden: false } });
						continue;
					}
					if (!Array.isArray(result.data)) return fail(new Error("Codex app-server returned an invalid model list"));
					for (const item of result.data) {
						if (!item || typeof item.model !== "string" || !item.model || typeof item.displayName !== "string") {
							return fail(new Error("Codex app-server returned an invalid model"));
						}
						if (!item.hidden) models.set(item.model, { id: item.model, displayName: item.displayName });
					}
					if (result.nextCursor == null) {
						settled = true;
						resolve([...models.values()]);
						return;
					}
					if (typeof result.nextCursor !== "string" || ++pages >= MAX_PAGES) {
						return fail(new Error("Codex model list pagination failed"));
					}
					requestId++;
					send({ id: requestId, method: "model/list", params: { limit: 100, includeHidden: false, cursor: result.nextCursor } });
				}
			});
			send({ id: requestId, method: "initialize", params: { clientInfo: { name: "bpx-consult", version: "0.10.2" }, capabilities: {} } });
		});
	} finally {
		if (child.exitCode === null) child.kill();
		const killTimer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000);
		try { await closed; } finally { clearTimeout(killTimer); }
	}
}
