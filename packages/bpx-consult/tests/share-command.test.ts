import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

const mocks = vi.hoisted(() => ({ solo: vi.fn(), council: vi.fn(), debate: vi.fn(), route: vi.fn(), load: vi.fn() }));
vi.mock("../src/solo.js", () => ({ executeSolo: mocks.solo }));
vi.mock("../src/council.js", () => ({ executeCouncil: mocks.council, resolveCouncilMembers: vi.fn() }));
vi.mock("../src/debate.js", () => ({ executeDebate: mocks.debate }));
vi.mock("../src/route.js", () => ({ resolveSeatRoute: mocks.route }));
vi.mock("../src/config.js", async (original) => ({ ...await original<typeof import("../src/config.js")>(), loadConfig: mocks.load }));
const { runShareCommand, SHARE_RESULT_TYPE } = await import("../src/share.js");
const { registerConsultationNavigation } = await import("../src/outcomes.js");

const temp: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(temp.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup() {
	const cwd = await mkdtemp(join(tmpdir(), "bpx-consent-"));
	temp.push(cwd);
	const notify = vi.fn();
	const select = vi.fn().mockResolvedValue("solo");
	const input = vi.fn().mockResolvedValue("Review selected file");
	const editor = vi.fn().mockResolvedValue("selected.diff");
	const confirm = vi.fn().mockResolvedValue(true);
	const appendEntry = vi.fn();
	let sessionId = "session-1";
	let branch: SessionEntry[] = [{ id: "anchor", type: "custom" } as SessionEntry];
	const ctx = { cwd, hasUI: true, isProjectTrusted: () => true, signal: undefined,
		ui: { notify, select, input, editor, confirm },
		sessionManager: { getSessionId: () => sessionId, getLeafId: () => "anchor", getBranch: () => branch },
	} as unknown as ExtensionCommandContext;
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const pi = { appendEntry, on: vi.fn((name: string, handler: (...args: unknown[]) => void) => { handlers.set(name, handler); }) } as unknown as ExtensionAPI;
	registerConsultationNavigation(pi);
	mocks.load.mockReturnValue(structuredClone(DEFAULT_CONFIG));
	mocks.route.mockReturnValue({ kind: "inline", label: "inline/model", advisor: {}, contextWindow: 10_000 });
	mocks.solo.mockResolvedValue({ content: [{ type: "text", text: "advice" }], details: { mode: "solo" } });
	return { cwd, ctx, pi, notify, select, input, editor, confirm, appendEntry,
		changeSession: () => { sessionId = "session-2"; }, changeBranch: () => { branch = [{ id: "other", type: "custom" } as SessionEntry]; },
		invalidateContext: () => { Object.defineProperty(ctx, "sessionManager", { get: () => { throw new Error("stale context"); } }); },
		navigateSibling: () => {
			handlers.get("session_before_tree")?.({ type: "session_before_tree" }, ctx);
			branch = [{ id: "anchor", type: "custom" }, { id: "new-child", type: "custom" }] as SessionEntry[];
		} };
}

describe("user-only consented share command", () => {
	it("sends only selected frozen bytes after confirmation and records content-free ID", async () => {
		const h = await setup();
		const text = "--- old\n+++ new\n+private change\n";
		await writeFile(join(h.cwd, "selected.diff"), text);
		h.confirm.mockImplementation(async (_title: string, preview: string) => {
			expect(preview).toContain("selected.diff");
			expect(preview).toContain("inline/model");
			await writeFile(join(h.cwd, "selected.diff"), "changed after approval");
			return true;
		});
		await runShareCommand(h.pi, h.ctx, "solo");
		expect(mocks.solo).toHaveBeenCalledOnce();
		expect(mocks.solo.mock.calls[0]![0].attachments).toEqual([{ path: "selected.diff", text, bytes: Buffer.byteLength(text) }]);
		expect(h.appendEntry).toHaveBeenCalledWith("bpx-consult-outcome", expect.objectContaining({ kind: "consultation", mode: "solo", source: "share" }));
		expect(h.appendEntry).toHaveBeenCalledWith(SHARE_RESULT_TYPE, expect.objectContaining({ text: "advice" }));
		expect(JSON.stringify(h.appendEntry.mock.calls.find(([kind]) => kind === "bpx-consult-outcome"))).not.toContain("private change");
	});

	it("reports no-call fit failure without recording a successful selected-file consult", async () => {
		const h = await setup();
		await writeFile(join(h.cwd, "selected.diff"), "+private change\n");
		mocks.solo.mockResolvedValueOnce({
			content: [{ type: "text", text: "Couldn't fit the advisor window: selected evidence too large" }],
			details: { mode: "solo", errorMessage: "selected evidence too large" },
		});
		await runShareCommand(h.pi, h.ctx, "solo");
		expect(mocks.solo).toHaveBeenCalledOnce();
		expect(h.appendEntry).not.toHaveBeenCalledWith("bpx-consult-outcome", expect.anything());
		expect(h.appendEntry).toHaveBeenCalledWith(SHARE_RESULT_TYPE, expect.objectContaining({
			text: "Couldn't fit the advisor window: selected evidence too large",
			errorMessage: "selected evidence too large",
		}));
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Selected-file consult failed"), "error");
		expect(h.notify).not.toHaveBeenCalledWith(expect.anything(), "info");
		expect(JSON.stringify(h.appendEntry.mock.calls)).not.toContain("private change");
	});

	it("keeps partial provider output but reports advisor failure, not success", async () => {
		const h = await setup();
		await writeFile(join(h.cwd, "selected.diff"), "+private change\n");
		mocks.solo.mockResolvedValueOnce({
			content: [{ type: "text", text: "provider timed out\n\nPartial answer before timeout" }],
			details: { mode: "solo", stopReason: "error", errorMessage: "provider timed out" },
		});
		await runShareCommand(h.pi, h.ctx, "solo");
		expect(h.appendEntry).not.toHaveBeenCalledWith("bpx-consult-outcome", expect.anything());
		expect(h.appendEntry).toHaveBeenCalledWith(SHARE_RESULT_TYPE, expect.objectContaining({
			text: "provider timed out\n\nPartial answer before timeout", errorMessage: "provider timed out",
		}));
		expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/Selected-file consult failed[\s\S]*provider timed out[\s\S]*Partial answer before timeout/), "error");
		expect(h.notify).not.toHaveBeenCalledWith(expect.anything(), "info");
	});

	it.each(["gut-check", "council", "debate"] as const)("passes the frozen selection to %s without re-reading", async (mode) => {
		const h = await setup();
		await writeFile(join(h.cwd, "selected.diff"), "+approved evidence\n");
		const config = structuredClone(DEFAULT_CONFIG);
		config.modes!.council!.members = ["architect"];
		mocks.load.mockReturnValue(config);
		// The configured council member sees raw files; the synthesizer sees only the response.
		vi.mocked((await import("../src/council.js")).resolveCouncilMembers).mockReturnValue({
			resolved: [{ persona: { name: "architect" }, modelLabel: "member-model" }], preFailed: [],
		} as never);
		const executor = mode === "council" ? mocks.council : mode === "debate" ? mocks.debate : mocks.solo;
		executor.mockResolvedValue({ content: [{ type: "text", text: "advice" }], details: { mode } });
		await runShareCommand(h.pi, h.ctx, mode);
		expect(executor).toHaveBeenCalledOnce();
		expect(executor.mock.calls[0]![0].attachments[0].text).toBe("+approved evidence\n");
		expect(h.confirm.mock.calls[0]![1]).toContain(mode === "council" ? "member-model (file contents)" : "inline/model");
	});

	it("stores shared-file advice outside Pi model context", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "ordinary task", timestamp: 1 });
		session.appendCustomEntry(SHARE_RESULT_TYPE, { id: "id", text: "SECRET_QUOTED_IN_ADVICE" });
		const context = buildSessionContext(session.getEntries(), session.getLeafId());
		expect(JSON.stringify(convertToLlm(context.messages))).not.toContain("SECRET_QUOTED_IN_ADVICE");
		expect(JSON.stringify(convertToLlm(context.messages))).toContain("ordinary task");
	});

	it("blocks CLI routes before reading selected files", async () => {
		const h = await setup();
		h.editor.mockResolvedValue("missing.diff");
		mocks.route.mockReturnValue({ kind: "cli", label: "unsafe-cli", backend: {}, contextWindow: 10_000 });
		await runShareCommand(h.pi, h.ctx, "solo");
		expect(h.editor).not.toHaveBeenCalled();
		expect(h.confirm).not.toHaveBeenCalled();
		expect(mocks.solo).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/requires inline advisor routes/), "error");
	});

	it("blocks mixed Council and Debate CLI seats before reading", async () => {
		const council = await setup();
		const config = structuredClone(DEFAULT_CONFIG);
		config.modes!.council!.members = ["architect"];
		mocks.load.mockReturnValue(config);
		vi.mocked((await import("../src/council.js")).resolveCouncilMembers).mockReturnValue({
			resolved: [{ kind: "cli", persona: { name: "architect" }, modelLabel: "external" }], preFailed: [],
		} as never);
		await runShareCommand(council.pi, council.ctx, "council");
		expect(council.editor).not.toHaveBeenCalled();
		mocks.route.mockReturnValueOnce({ kind: "inline", label: "advocate" })
			.mockReturnValueOnce({ kind: "inline", label: "critic" })
			.mockReturnValueOnce({ kind: "cli", label: "synthesizer" });
		await runShareCommand(council.pi, council.ctx, "debate");
		expect(council.editor).not.toHaveBeenCalled();
		expect(mocks.council).not.toHaveBeenCalled();
		expect(mocks.debate).not.toHaveBeenCalled();
	});

	it("uses the same solo fallback for Debate synthesis preview", async () => {
		const h = await setup();
		const config = structuredClone(DEFAULT_CONFIG);
		config.modes!.council!.synthesizer = undefined;
		config.modes!.solo!.model = "pi/fallback";
		mocks.load.mockReturnValue(config);
		mocks.debate.mockResolvedValue({ content: [{ type: "text", text: "advice" }], details: { mode: "debate" } });
		await writeFile(join(h.cwd, "selected.diff"), "+change\n");
		await runShareCommand(h.pi, h.ctx, "debate");
		expect(mocks.route.mock.calls.at(-1)?.[1]).toMatchObject({ model: "pi/fallback" });
		expect(mocks.debate).toHaveBeenCalledOnce();
	});

	it("drops late file-sharing advice after navigation to a sibling branch", async () => {
		const h = await setup();
		await writeFile(join(h.cwd, "selected.diff"), "+sensitive\n");
		let finish!: (value: unknown) => void;
		mocks.solo.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		const pending = runShareCommand(h.pi, h.ctx, "solo");
		await vi.waitFor(() => expect(mocks.solo).toHaveBeenCalledOnce());
		h.navigateSibling();
		finish({ content: [{ type: "text", text: "SIBLING_FILE_ADVICE" }], details: { mode: "solo" } });
		await pending;
		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("SIBLING_FILE_ADVICE"), "info");
	});

	it("does not notify through stale UI if mode picker resolves after session replacement", async () => {
		const h = await setup();
		let choose!: (value: string) => void;
		h.select.mockReturnValueOnce(new Promise((resolve) => { choose = resolve; }));
		const pending = runShareCommand(h.pi, h.ctx, "");
		h.invalidateContext();
		choose("unsupported");
		await pending;
		expect(h.notify).not.toHaveBeenCalled();
		expect(mocks.solo).not.toHaveBeenCalled();
	});

	it("drops advice when Pi invalidates command context during the advisor call", async () => {
		const h = await setup();
		await writeFile(join(h.cwd, "selected.diff"), "+sensitive\n");
		let finish!: (value: unknown) => void;
		mocks.solo.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		const pending = runShareCommand(h.pi, h.ctx, "solo");
		await vi.waitFor(() => expect(mocks.solo).toHaveBeenCalledOnce());
		h.invalidateContext();
		finish({ content: [{ type: "text", text: "stale advice" }], details: { mode: "solo" } });
		await pending;
		expect(h.appendEntry).not.toHaveBeenCalled();
	});

	it("never dispatches without affirmative consent or live originating branch", async () => {
		const h = await setup();
		await writeFile(join(h.cwd, "selected.diff"), "private");
		h.confirm.mockResolvedValueOnce(false);
		await runShareCommand(h.pi, h.ctx, "solo");
		h.confirm.mockImplementationOnce(async () => { h.changeBranch(); return true; });
		await runShareCommand(h.pi, h.ctx, "solo");
		expect(mocks.solo).not.toHaveBeenCalled();
		expect(h.appendEntry).not.toHaveBeenCalled();
	});

	it("does not store or show late advice after a session switch", async () => {
		const h = await setup();
		await writeFile(join(h.cwd, "selected.diff"), "+sensitive\n");
		mocks.solo.mockImplementationOnce(async () => { h.changeSession(); return { content: [{ type: "text", text: "late advice" }], details: { mode: "solo" } }; });
		await runShareCommand(h.pi, h.ctx, "solo");
		expect(mocks.solo).toHaveBeenCalledOnce();
		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("late advice"), "info");
	});

	it("does not read or dispatch on cancellation, headless mode or untrusted project", async () => {
		const h = await setup();
		h.editor.mockResolvedValueOnce(undefined);
		await runShareCommand(h.pi, h.ctx, "solo");
		const headless = { ...h.ctx, hasUI: false } as ExtensionCommandContext;
		await runShareCommand(h.pi, headless, "solo");
		const untrusted = { ...h.ctx, isProjectTrusted: () => false } as ExtensionCommandContext;
		await runShareCommand(h.pi, untrusted, "solo");
		expect(h.confirm).not.toHaveBeenCalled();
		expect(mocks.solo).not.toHaveBeenCalled();
		expect(h.appendEntry).not.toHaveBeenCalled();
	});
});
