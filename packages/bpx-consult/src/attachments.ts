import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_ATTACHMENT_FILES = 5;
export const MAX_ATTACHMENT_BYTES = 32 * 1024;
export const MAX_ATTACHMENTS_BYTES = 96 * 1024;

export interface SelectedAttachment {
	path: string;
	text: string;
	bytes: number;
}

/** Accept exact paths only. A newline separates files; globs and directories are never expanded. */
export function parseAttachmentPaths(input: string): string[] {
	const paths = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (paths.length === 0 || paths.length > MAX_ATTACHMENT_FILES) throw new Error(`Choose 1–${MAX_ATTACHMENT_FILES} exact files, one path per line.`);
	if (new Set(paths).size !== paths.length) throw new Error("Choose each file once.");
	return paths;
}

/** Read only explicitly selected, regular UTF-8 files inside trusted project root. */
export async function readSelectedAttachments(cwd: string, paths: string[]): Promise<SelectedAttachment[]> {
	if (paths.length === 0 || paths.length > MAX_ATTACHMENT_FILES) throw new Error("Invalid file count.");
	const root = await realpath(cwd);
	const selected: SelectedAttachment[] = [];
	const seen = new Set<string>();
	let total = 0;
	for (const path of paths) {
		if (!path || path.includes("\0") || /[*?[\]{}]/.test(path)) throw new Error(`Not an exact path: ${path}`);
		const target = resolve(root, path);
		const local = relative(root, target);
		if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`Outside project: ${path}`);
		if (seen.has(local)) throw new Error(`Choose each file once: ${path}`);
		seen.add(local);
		const parts = local.split(sep);
		if (parts.includes("..") || parts.some((part) => part.toLowerCase() === ".git")) throw new Error(`Disallowed path: ${path}`);
		let cursor = root;
		let selectedIdentity: { dev: number; ino: number } | undefined;
		for (const [index, part] of parts.entries()) {
			cursor = resolve(cursor, part);
			const info = await lstat(cursor);
			if (info.isSymbolicLink()) throw new Error(`Symlink not allowed: ${path}`);
			if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`Not a directory: ${path}`);
			if (index === parts.length - 1) {
				if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
				selectedIdentity = { dev: info.dev, ino: info.ino };
			}
		}
		// O_NOFOLLOW protects the final component. Compare the opened inode to
		// the selected one so swapping a parent directory during open cannot
		// redirect the read to a different file outside the project.
		const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await handle.stat();
			if (!selectedIdentity || info.dev !== selectedIdentity.dev || info.ino !== selectedIdentity.ino) throw new Error(`Path changed while reading: ${path}`);
			if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) throw new Error(`File exceeds ${MAX_ATTACHMENT_BYTES} bytes or is not regular: ${path}`);
			if (total + info.size > MAX_ATTACHMENTS_BYTES) throw new Error(`Selection exceeds ${MAX_ATTACHMENTS_BYTES} bytes.`);
			if (await realpath(target) !== target) throw new Error(`Path changed while reading: ${path}`);
			const chunks: Buffer[] = [];
			let size = 0;
			while (true) {
				const chunk = Buffer.alloc(Math.min(8192, MAX_ATTACHMENT_BYTES + 1 - size));
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
				if (bytesRead === 0) break;
				size += bytesRead;
				if (size > MAX_ATTACHMENT_BYTES) throw new Error(`File exceeds ${MAX_ATTACHMENT_BYTES} bytes: ${path}`);
				chunks.push(chunk.subarray(0, bytesRead));
			}
			const bytes = Buffer.concat(chunks);
			if (bytes.includes(0)) throw new Error(`Binary file not allowed: ${path}`);
			let text: string;
			try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
			catch { throw new Error(`File is not valid UTF-8: ${path}`); }
			total += size;
			if (total > MAX_ATTACHMENTS_BYTES) throw new Error(`Selection exceeds ${MAX_ATTACHMENTS_BYTES} bytes.`);
			selected.push({ path: local, text, bytes: size });
		} finally {
			await handle.close();
		}
	}
	return selected;
}

/** Display exact paths and bounded excerpts before explicit provider consent. */
export function attachmentPreview(files: SelectedAttachment[]): string {
	return files.map((file) => {
		const excerpt = file.text.length > 240 ? `${file.text.slice(0, 240)}\n[preview only; full file will be sent]` : file.text;
		return `${file.path} (${file.bytes} bytes)\n${excerpt}`;
	}).join("\n\n");
}
