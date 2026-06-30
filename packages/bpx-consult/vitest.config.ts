import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		exclude: ["**/._*", "**/.DS_Store", "**/node_modules/**"],
	},
});
