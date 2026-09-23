import { describe, expect, it, vi } from "vitest";
import { showFilterablePicker } from "../src/picker.js";

describe("filterable model picker", () => {
	it("renders a preferred model beyond the first page before Enter selects it", async () => {
		let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
		const done = vi.fn();
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const ctx = { ui: { custom: async (factory: (...args: any[]) => any) => {
			component = factory({ requestRender: vi.fn() }, theme, {}, done);
			return null;
		} } };
		await showFilterablePicker(ctx as never, {
			title: "Choose model",
			items: Array.from({ length: 15 }, (_, i) => ({ value: `model-${i}`, label: `Model ${i}` })),
			preferredValue: "model-12",
		});
		const lines = component!.render(100).join("\n");
		expect(lines).toContain("❯ Model 12");
		expect(lines).toContain("showing 4–13 of 15");
		component!.handleInput("\r");
		expect(done).toHaveBeenCalledWith("model-12");
	});
});
