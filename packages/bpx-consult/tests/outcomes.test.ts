import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
	consultationOrigin,
	isCurrentOrigin,
	listConsultations,
	OUTCOME_ENTRY_TYPE,
	parseLabels,
} from "../src/outcomes.js";

const mocks = vi.hoisted(() => ({ solo: vi.fn(), load: vi.fn() }));
vi.mock("../src/solo.js", () => ({ executeSolo: mocks.solo }));
vi.mock("../src/config.js", async (original) => ({
	...await original<typeof import("../src/config.js")>(), loadConfig: mocks.load,
}));
vi.mock("../src/triggers.js", () => ({ registerTriggers: vi.fn() }));
vi.mock("../src/deliver.js", async (original) => ({
	...await original<typeof import("../src/deliver.js")>(), registerConsultRenderer: vi.fn(),
}));
const { default: extension } = await import("../index.js");

const toolEntry = (id: string, mode = "solo") => ({
	type: "message", id: `entry-${id}`, message: { role: "toolResult", toolName: "consult", details: { consultationId: id, mode } },
}) as SessionEntry;
const customEntry = (id: string, data: object) => ({ type: "custom", id, customType: OUTCOME_ENTRY_TYPE, data }) as SessionEntry;

function setup() {
	mocks.load.mockReturnValue(structuredClone(DEFAULT_CONFIG));
	mocks.solo.mockResolvedValue({
		content: [{ type: "text", text: "advice" }], details: { mode: "solo" },
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } },
	});
	let execute!: (...args: unknown[]) => Promise<any>;
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const appendEntry = vi.fn();
	const notify = vi.fn();
	const pi = {
		on: vi.fn(), appendEntry, registerEntryRenderer: vi.fn(),
		registerTool: vi.fn((tool: { execute: typeof execute }) => { execute = tool.execute; }),
		registerCommand: vi.fn((_name: string, options: { handler: typeof command }) => { command = options.handler; }),
	} as unknown as ExtensionAPI;
	extension(pi);
	let branch: SessionEntry[] = [];
	const ctx = {
		cwd: "/tmp", isProjectTrusted: () => true,
		sessionManager: { getBranch: () => branch }, ui: { notify },
	} as unknown as ExtensionContext;
	return { execute, command, appendEntry, notify, ctx, pi, setBranch: (entries: SessionEntry[]) => { branch = entries; } };
}

describe("manual consultation outcomes", () => {
	it("keeps usage while assigning stable ID only to attempted calls", async () => {
		const h = setup();
		const result = await h.execute("call-1", { mode: "solo" }, undefined, undefined, h.ctx);
		expect(result.details.consultationId).toMatch(/^[a-f0-9-]{36}$/);
		expect(result.usage.totalTokens).toBe(3);
		expect(result.details.reportedUsage).toEqual(result.usage);
		// Pi's renderer passes content/details but strips top-level usage.
		const uiResult = { content: result.content, details: result.details };
		expect(uiResult.details.reportedUsage.cost.total).toBe(3);
		expect(h.appendEntry).not.toHaveBeenCalled();

		const capConfig = structuredClone(DEFAULT_CONFIG);
		capConfig.maxConsultsPerTurn = 1;
		mocks.load.mockReturnValue(capConfig);
		const capped = await h.execute("call-2", {}, undefined, undefined, h.ctx);
		expect(capped.details.consultationId).toBeUndefined();
	});

	it("validates both labels atomically and never writes unknown IDs", async () => {
		const h = setup();
		h.setBranch([toolEntry("abc")]);
		await h.command("label abc used yes helped no", h.ctx);
		expect(h.appendEntry).toHaveBeenCalledWith(OUTCOME_ENTRY_TYPE, {
			version: 1, kind: "label", id: "abc", used: true, helped: false,
		});
		h.appendEntry.mockClear();
		for (const input of ["label missing used yes", "label abc used yes used no", "label abc used yes helped maybe", "label abc helped", "label abc used yes unexpected no"]) {
			await h.command(input, h.ctx);
		}
		expect(h.appendEntry).not.toHaveBeenCalled();
	});

	it("rebuilds latest independent labels from active branch and allows unknown reset", () => {
		const branch = [
			toolEntry("one"),
			customEntry("initial", { version: 1, kind: "label", id: "one", used: true, helped: false }),
			customEntry("reset", { version: 1, kind: "label", id: "one", helped: null }),
			customEntry("stray", { version: 1, kind: "label", id: "absent", used: true }),
			customEntry("phrase", { version: 1, kind: "consultation", id: "two", mode: "council", source: "phrase" }),
		];
		expect(listConsultations(branch)).toEqual([
			{ id: "one", mode: "solo", source: "tool", used: true, helped: null },
			{ id: "two", mode: "council", source: "phrase" },
		]);
		expect(listConsultations(branch.slice(0, 1))[0]?.helped).toBeUndefined();
		expect(parseLabels("one helped unknown")).toEqual({ id: "one", labels: { helped: null } });
	});

	it("filters historical show messages from registered executor context and actual Pi conversion", () => {
		const h = setup();
		const handlers = vi.mocked(h.pi.on).mock.calls as unknown as Array<[string, unknown]>;
		const handler = handlers.find(([name]) => name === "context")?.[1];
		expect(handler).toBeTypeOf("function");
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "ordinary task", timestamp: 1 });
		session.appendCustomMessageEntry("bpx-consult", "LEGACY_SECRET", true);
		session.appendCustomEntry("bpx-consult-local-result", { id: "new", text: "NEW_SECRET" });
		session.appendCustomMessageEntry("another-extension", "retain this", true);
		const messages = buildSessionContext(session.getEntries(), session.getLeafId()).messages;
		const filtered = (handler as (event: { type: "context"; messages: typeof messages }, ctx: ExtensionContext) => { messages: typeof messages })({ type: "context", messages }, h.ctx).messages;
		const llm = JSON.stringify(convertToLlm(filtered));
		expect(llm).not.toContain("LEGACY_SECRET");
		expect(llm).not.toContain("NEW_SECRET");
		expect(llm).toContain("retain this");
		expect(llm).toContain("ordinary task");
	});

	it("retrieves local-only show and share results only on the active branch", async () => {
		const h = setup();
		h.setBranch([
			customEntry("share", { version: 1, kind: "consultation", id: "share-1", mode: "solo", source: "share" }),
			{ type: "custom", id: "result", customType: "bpx-consult-share-result", data: { id: "share-1", text: "PRIVATE ADVICE" } } as SessionEntry,
			{ type: "custom", id: "show", customType: "bpx-consult-local-result", data: { id: "show-1", text: "LOCAL ADVICE" } } as SessionEntry,
			{ type: "custom", id: "failed", customType: "bpx-consult-share-result", data: { id: "failed-1", text: "PARTIAL ADVICE", errorMessage: "advisor timed out" } } as SessionEntry,
		]);
		await h.command("result share-1", h.ctx);
		expect(h.notify).toHaveBeenCalledWith("PRIVATE ADVICE", "info");
		await h.command("result show-1", h.ctx);
		expect(h.notify).toHaveBeenCalledWith("LOCAL ADVICE", "info");
		await h.command("result failed-1", h.ctx);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("PARTIAL ADVICE"), "error");
		h.setBranch([]);
		await h.command("result share-1", h.ctx);
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("not found"), "error");
	});

	it("accepts ordinary descendants but invalidates a sibling-branch navigation", () => {
		const h = setup();
		let branch: SessionEntry[] = [{ id: "anchor", type: "custom" } as SessionEntry];
		const ctx = { sessionManager: { getSessionId: () => "same", getLeafId: () => "anchor", getBranch: () => branch } } as ExtensionContext;
		const origin = consultationOrigin(ctx);
		branch = [...branch, { id: "old-child", type: "custom" } as SessionEntry];
		expect(isCurrentOrigin(ctx, origin)).toBe(true);
		const handlers = vi.mocked(h.pi.on).mock.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		handlers.find(([name]) => name === "session_before_tree")![1]({ type: "session_before_tree" }, ctx);
		branch = [{ id: "anchor", type: "custom" } as SessionEntry, { id: "new-child", type: "custom" } as SessionEntry];
		expect(isCurrentOrigin(ctx, origin)).toBe(false);
	});

	it("does not deliver a detached consultation into a switched branch or session", () => {
		let sessionId = "session-1";
		let branch: SessionEntry[] = [{ id: "anchor", type: "custom" } as SessionEntry];
		const ctx = { sessionManager: { getSessionId: () => sessionId, getLeafId: () => "anchor", getBranch: () => branch } } as ExtensionContext;
		const origin = consultationOrigin(ctx);
		branch = [...branch, { id: "later", type: "custom" } as SessionEntry];
		expect(isCurrentOrigin(ctx, origin)).toBe(true);
		branch = [{ id: "other", type: "custom" } as SessionEntry];
		expect(isCurrentOrigin(ctx, origin)).toBe(false);
		branch = [{ id: "anchor", type: "custom" } as SessionEntry];
		sessionId = "session-2";
		expect(isCurrentOrigin(ctx, origin)).toBe(false);
	});
});
