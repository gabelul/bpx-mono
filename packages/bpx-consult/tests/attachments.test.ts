import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { MAX_ATTACHMENT_BYTES, parseAttachmentPaths, readSelectedAttachments } from "../src/attachments.js";
import { buildConsultContext, estimateMessageTokens, type ContextBudget } from "../src/context-engine.js";

const temp: string[] = [];
afterEach(async () => { await Promise.all(temp.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "bpx-share-"));
	temp.push(root);
	return root;
}

const budget: ContextBudget = { userChars: 1600, assistantChars: 800, toolArgChars: 500, toolResultChars: 1200,
	keepFirst: 1, keepLast: 3, responseReserveTokens: 200 };
const inFlight: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", id: "pending", name: "consult", arguments: {} }],
	api: "anthropic-messages" as never, provider: "anthropic" as never, model: "test", stopReason: "toolUse", timestamp: 2,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const message = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

describe("explicit repository attachments", () => {
	it("reads exact UTF-8 bytes once and preserves them through the fitted payload", async () => {
		const root = await project();
		await writeFile(join(root, "change.diff"), "--- a/src/a.ts\n+++ b/src/a.ts\n+hello\n", "utf8");
		const [attachment] = await readSelectedAttachments(root, parseAttachmentPaths("change.diff"));
		expect(attachment).toEqual({ path: "change.diff", bytes: 37, text: "--- a/src/a.ts\n+++ b/src/a.ts\n+hello\n" });
		const fitted = buildConsultContext({
			sessionMessages: [message("Review the code"), inFlight],
			advisorContextWindow: 16_000, budget, attachments: [attachment],
		});
		expect(fitted.error).toBeUndefined();
		expect(fitted.messages.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall" && c.name === "consult"))).toBe(false);
		expect(fitted.messages.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(attachment.text))).toHaveLength(1);
		expect(fitted.estimatedTokens).toBe(fitted.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0));
		expect(fitted.ledger).toContainEqual(expect.objectContaining({ reason: "explicit user-selected file (verbatim)", disposition: "kept" }));
	});

	it("preserves UTF-8 BOM bytes in the approved evidence", async () => {
		const root = await project();
		const original = Buffer.from([0xef, 0xbb, 0xbf, 0x2b, 0x68, 0x69, 0x0a]);
		await writeFile(join(root, "bom.diff"), original);
		const [file] = await readSelectedAttachments(root, ["bom.diff"]);
		expect(file.bytes).toBe(original.length);
		expect(Buffer.from(file.text, "utf8")).toEqual(original);
	});

	it("fails closed instead of clipping a selected file to fit a small window", async () => {
		const root = await project();
		await writeFile(join(root, "big.txt"), "x".repeat(8000));
		const files = await readSelectedAttachments(root, ["big.txt"]);
		const fit = buildConsultContext({ sessionMessages: [message("Task")], advisorContextWindow: 1200, budget, attachments: files });
		expect(fit.error).toMatch(/Selected files cannot fit verbatim/);
		expect(fit.messages).toEqual([]);
	});

	it("rejects traversal, symlinks, directories, binary and oversized files", async () => {
		const root = await project();
		await mkdir(join(root, "folder"));
		await writeFile(join(root, "folder", "safe.txt"), "hello");
		await symlink("folder", join(root, "alias"));
		await symlink("folder/safe.txt", join(root, "shortcut"));
		await writeFile(join(root, "binary"), Buffer.from([65, 0, 66]));
		await writeFile(join(root, "invalid"), Buffer.from([0xff]));
		await writeFile(join(root, "huge"), "a".repeat(MAX_ATTACHMENT_BYTES + 1));
		await mkdir(join(root, ".git"));
		await writeFile(join(root, ".git", "config"), "private");
		for (const path of ["../outside", "folder", "alias/safe.txt", "shortcut", "binary", "invalid", "huge", ".git/config", ".GIT/config", "*.txt"]) {
			await expect(readSelectedAttachments(root, [path]), path).rejects.toThrow();
		}
		expect(parseAttachmentPaths("folder/safe.txt\n")).toEqual(["folder/safe.txt"]);
		expect(() => parseAttachmentPaths("same\nsame")).toThrow();
	});
});
