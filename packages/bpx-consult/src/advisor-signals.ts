/**
 * advisor-signals — pure signal-compression helpers, ported from
 * pi-external-advisor/src/advisor-signals.ts.
 *
 * These are the deterministic bits evidence.ts leans on: count the lines a patch
 * touched, pull a bash exit code out of tool output, and recognise a verification
 * command. Kept pi-free (no message types, no session) so they stay trivially
 * unit-testable and reusable across the classifier and any future signal block.
 *
 * `summarizeToolResult` from the original source is NOT here — it assumed the
 * command/path sat on the tool event, which isn't how pi shapes a toolResult
 * (the input lives on the matching ToolCall). evidence.ts re-implements it
 * against pi's real types and reuses the three primitives below.
 */

/**
 * Pull a bash exit code out of tool output text. Pi's bash tool reports failures
 * as "Command exited with code N" (and variants), so we match that shape and
 * return the number, or undefined when there's no code to read.
 *
 * @param text - the tool result text
 * @returns the parsed exit code, or undefined if none is present
 */
export function extractBashExitCode(text: string): number | undefined {
	const match = text.match(/exit(?:ed)?\s+(?:with\s+)?code:?\s*(\d+)/i);
	if (!match) return undefined;
	const code = Number.parseInt(match[1], 10);
	return Number.isNaN(code) ? undefined : code;
}

/**
 * Count added/removed lines in a unified diff. Skips the `+++`/`---` file headers
 * so they don't inflate the count. Used to render "(+30/-5)" in an edit's signal
 * one-liner.
 *
 * @param patch - a unified-diff string
 * @returns the added/removed line counts
 */
export function countPatchChanges(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

// The leading-token patterns that mark a command as a verification run. Matched
// per pipeline segment (see isVerificationCommand) so a `cat tests/foo.test.ts`
// doesn't register as a test just because "test" appears in the path.
const VERIFICATION_SEGMENT_PATTERNS: RegExp[] = [
	/^(?:npx\s+|bunx\s+)?(?:jest|vitest|pytest|rspec|tsc|eslint|biome|mocha|ava)\b/,
	/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|check|lint|typecheck|build)\b/,
	/^cargo\s+(?:test|check|clippy|build)\b/,
	/^go\s+(?:test|vet|build)\b/,
	/^make\s+(?:test|check|lint|build)\b/,
	/^node\s+--test\b/,
	/^python3?\s+-m\s+pytest\b/,
];

/**
 * Is this a verification command (test/lint/typecheck/build)? Splits on pipeline
 * operators and matches each segment's leading token, so `A && vitest` counts but
 * `cat tests/x.test.ts` does not. Leading `VAR=val` env assignments are stripped
 * before matching so `CI=1 vitest` still registers.
 *
 * @param command - the bash command string (undefined → false)
 * @returns true when any pipeline segment is a verification run
 */
export function isVerificationCommand(command?: string): boolean {
	if (!command) return false;
	return command.split(/&&|\|\||;|\|/).some((segment) => {
		const normalized = segment.trim().replace(/^(?:\w+=\S+\s+)+/, "");
		return VERIFICATION_SEGMENT_PATTERNS.some((pattern) => pattern.test(normalized));
	});
}
