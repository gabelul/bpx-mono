import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

const mocks = vi.hoisted(() => ({ solo: vi.fn(), load: vi.fn(), feedback: vi.fn() }));
vi.mock("../src/solo.js", () => ({ executeSolo: mocks.solo }));
vi.mock("../src/config.js", async (original) => ({
	...await original<typeof import("../src/config.js")>(),
	loadConfig: mocks.load, resolveFeedbackMode: mocks.feedback,
}));
const { registerTriggers } = await import("../src/triggers.js");
const { registerConsultationNavigation } = await import("../src/outcomes.js");

/** Mount registered event handlers with a branch that can change during an advisor call. */
function setup(hasUI = true, mode: "tui" | "rpc" = "rpc") {
	mocks.load.mockReturnValue(structuredClone(DEFAULT_CONFIG));
	mocks.feedback.mockReturnValue("show");
	mocks.solo.mockReset();
	mocks.solo.mockResolvedValue({ content: [{ type: "text", text: "private advice" }], details: { mode: "solo" } });
	const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
	const appendEntry = vi.fn();
	const sendMessage = vi.fn();
	const sendUserMessage = vi.fn();
	const notify = vi.fn();
	const setStatus = vi.fn();
	const pi = {
		on: vi.fn((name: string, handler: (...args: any[]) => Promise<unknown>) => { handlers.set(name, handler); }),
		appendEntry, sendMessage, sendUserMessage,
	} as unknown as ExtensionAPI;
	let sessionId = "original";
	let branch = [{ id: "anchor", type: "custom" }] as SessionEntry[];
	const ctx = {
		cwd: "/tmp", hasUI, mode, signal: undefined, isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => sessionId, getLeafId: () => "anchor", getBranch: () => branch },
		ui: { notify, setStatus },
	} as unknown as ExtensionContext;
	registerConsultationNavigation(pi);
	registerTriggers(pi);
	return {
		input: (text = "ask the advisor") => handlers.get("input")!({ source: "interactive", text }, ctx),
		appendEntry, sendMessage, sendUserMessage, notify, setStatus,
		switchSession: () => { sessionId = "other"; branch = [{ id: "other", type: "custom" } as SessionEntry]; },
		invalidateContext: () => {
			Object.defineProperty(ctx, "mode", { get: () => { throw new Error("stale context"); } });
			Object.defineProperty(ctx, "sessionManager", { get: () => { throw new Error("stale context"); } });
		},
		navigateSibling: async () => {
			await handlers.get("session_before_tree")!({ type: "session_before_tree" }, ctx);
			branch = [{ id: "anchor", type: "custom" }, { id: "new-child", type: "custom" }] as SessionEntry[];
		},
	};
}

describe("show feedback isolation", () => {
	it("persists a local result without a model-facing message", async () => {
		const h = setup();
		expect(await h.input()).toEqual({ action: "handled" });
		expect(h.appendEntry).toHaveBeenCalledWith("bpx-consult-local-result", expect.objectContaining({ text: "private advice", id: expect.any(String) }));
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("private advice"), "info");
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});

	it("consumes show-only input without calling advisor or executor when UI is unavailable", async () => {
		const h = setup(false);
		expect(await h.input()).toEqual({ action: "handled" });
		expect(mocks.solo).not.toHaveBeenCalled();
		expect(h.appendEntry).toHaveBeenCalledWith("bpx-consult-show-unavailable", expect.objectContaining({ mode: "solo" }));
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not hand a disabled show-only request to the executor", async () => {
		const h = setup();
		mocks.load.mockReturnValue({ ...DEFAULT_CONFIG, enabled: false });
		expect(await h.input()).toEqual({ action: "handled" });
		expect(mocks.solo).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("wasn't sent"), "warning");
	});

	it("consumes a show-only phrase while another consultation is running", async () => {
		const h = setup();
		mocks.feedback.mockReturnValueOnce("steer").mockReturnValueOnce("show");
		let finish!: (value: unknown) => void;
		mocks.solo.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		expect(await h.input()).toEqual({ action: "continue" });
		expect(await h.input()).toEqual({ action: "handled" });
		expect(mocks.solo).toHaveBeenCalledTimes(1);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("already running"), "warning");
		finish({ content: [{ type: "text", text: "first advice" }], details: { mode: "solo" } });
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledTimes(1));
	});

	it("shows transient phase updates without another model message", async () => {
		const h = setup(true, "tui");
		mocks.solo.mockImplementationOnce(async (input) => {
			input.onUpdate?.({ content: [{ type: "text", text: "Council: 2/3 seats finished" }], details: { mode: "council" } });
			return { content: [{ type: "text", text: "private advice" }], details: { mode: "solo" } };
		});
		await h.input();
		const key = h.setStatus.mock.calls[0]?.[0] as string;
		expect(key).toMatch(/^bpx-consult-progress-/);
		expect(h.setStatus).toHaveBeenCalledWith(key, "Council: 2/3 seats finished");
		expect(h.setStatus).toHaveBeenLastCalledWith(key, undefined);
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("drops late show and steer advice after navigation to a sibling branch", async () => {
		let finish!: (value: unknown) => void;
		const h = setup();
		mocks.solo.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		const pending = h.input();
		await h.navigateSibling();
		finish({ content: [{ type: "text", text: "SIBLING_SECRET" }], details: { mode: "solo" } });
		expect(await pending).toEqual({ action: "handled" });
		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("SIBLING_SECRET"), "info");

		const steered = setup();
		mocks.feedback.mockReturnValue("steer");
		mocks.solo.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		await steered.input();
		await steered.navigateSibling();
		finish({ content: [{ type: "text", text: "SIBLING_STEER" }], details: { mode: "solo" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(steered.sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not reject a detached consultation when Pi invalidates its context", async () => {
		let finish!: (value: unknown) => void;
		const h = setup(true, "tui");
		mocks.feedback.mockReturnValue("steer");
		mocks.solo.mockImplementationOnce(async (input) => {
			const advice = await new Promise((resolve) => { finish = resolve; });
			input.onUpdate?.({ content: [{ type: "text", text: "late status" }], details: { mode: "solo" } });
			return advice;
		});
		expect(await h.input()).toEqual({ action: "continue" });
		h.invalidateContext();
		finish({ content: [{ type: "text", text: "stale advice" }], details: { mode: "solo" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		expect(h.appendEntry).not.toHaveBeenCalled();
	});

	it("drops late advice after a session switch", async () => {
		let finish!: (value: unknown) => void;
		const h = setup();
		mocks.solo.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		const pending = h.input();
		h.switchSession();
		finish({ content: [{ type: "text", text: "late private advice" }], details: { mode: "solo" } });
		expect(await pending).toEqual({ action: "handled" });
		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("late private advice"), "info");
	});
});
