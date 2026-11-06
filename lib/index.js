/**
 * Workspace download routes.
 *
 * Two authenticated routes on the connection service:
 *
 * - `GET/HEAD /api/download?path=<absolute file>` streams one file with
 *   `Range` support, so multi-GB artifacts download without being buffered in
 *   memory. The existing `/api/file` route reads whole files through
 *   `fs.readBytes(..., maxBytes)` and therefore caps out at the attachment
 *   image limit; this route never buffers.
 * - `GET/HEAD /api/download.zip?path=<absolute directory>` streams a
 *   store-only ZIP of a whole directory tree, byte-for-byte from disk, with an
 *   exact `Content-Length` computed before the first byte is sent.
 *
 * Authentication is the connection service's job, exactly like `/api/file`:
 * the handler receives only already-authenticated requests.
 *
 * @module dsh-workspace-download
 */
import { createReadStream } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";

export const name = "workspace-download";
export const inject = ["connection"];

/** Route path of the single-file download endpoint. */
export const DOWNLOAD_PATH = "/api/download";
/** Route path of the directory ZIP endpoint. */
export const DOWNLOAD_ZIP_PATH = "/api/download.zip";

/** Headers shared by every response this plugin produces. */
const BASE_HEADERS = {
	"Cache-Control": "private, no-store",
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": "sandbox; default-src 'none'",
};

/** Hard stop for pathological directory trees. */
export const MAX_ZIP_ENTRIES = 200_000;
/** Store-only ZIP32 addresses offsets with 32 bits; keep a safety margin. */
export const MAX_ZIP_BYTES = 4 * 1024 * 1024 * 1024 - 64 * 1024 * 1024;

const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_STORE = 0;
const LOCAL_HEADER_BYTES = 30;
const DATA_DESCRIPTOR_BYTES = 16;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;

/** Extension → media type table; anything else falls back to octet-stream. */
const MEDIA_TYPES = new Map([
	[".7z", "application/x-7z-compressed"],
	[".avi", "video/x-msvideo"],
	[".bin", "application/octet-stream"],
	[".bmp", "image/bmp"],
	[".bz2", "application/x-bzip2"],
	[".csv", "text/csv; charset=utf-8"],
	[".doc", "application/msword"],
	[".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	[".gz", "application/gzip"],
	[".gif", "image/gif"],
	[".html", "text/html; charset=utf-8"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".json", "application/json"],
	[".log", "text/plain; charset=utf-8"],
	[".md", "text/markdown; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".mov", "video/quicktime"],
	[".mp3", "audio/mpeg"],
	[".mp4", "video/mp4"],
	[".pdf", "application/pdf"],
	[".png", "image/png"],
	[".ppt", "application/vnd.ms-powerpoint"],
	[".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
	[".py", "text/x-python; charset=utf-8"],
	[".rar", "application/vnd.rar"],
	[".sh", "text/x-shellscript; charset=utf-8"],
	[".tar", "application/x-tar"],
	[".tgz", "application/gzip"],
	[".tsv", "text/tab-separated-values; charset=utf-8"],
	[".txt", "text/plain; charset=utf-8"],
	[".webp", "image/webp"],
	[".xls", "application/vnd.ms-excel"],
	[".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	[".xml", "application/xml"],
	[".zip", "application/zip"],
]);

/**
 * Derive a media type from a file name.
 * @param file - absolute or relative file name.
 * @returns the media type to advertise.
 */
function mediaTypeOf(file) {
	return MEDIA_TYPES.get(path.extname(file).toLowerCase()) ?? "application/octet-stream";
}

/**
 * Build a `Content-Disposition` value that survives non-ASCII names.
 * @param filename - the suggested download name.
 * @returns an attachment disposition with an ASCII fallback and `filename*`.
 */
function contentDisposition(filename) {
	const fallback = filename.replace(/[^\u0020-\u007e]/gu, "_").replace(/["\\]/gu, "_");
	const encoded = encodeURIComponent(filename).replace(/'/gu, "%27");
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Parse one `Range` header against a known size.
 * @param header - raw header value.
 * @param size - file size in bytes.
 * @returns a satisfiable range, `"invalid"`, or `"unsatisfiable"`.
 */
export function parseRange(header, size) {
	const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
	if (match === null) return "invalid";
	const [, startText, endText] = match;
	if (startText === "" && endText === "") return "invalid";
	let start;
	let end;
	if (startText === "") {
		const suffix = Number(endText);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
		start = Math.max(size - suffix, 0);
		end = size - 1;
	} else {
		start = Number(startText);
		end = endText === "" ? size - 1 : Number(endText);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return "invalid";
		if (start >= size) return "unsatisfiable";
		end = Math.min(end, size - 1);
	}
	if (size === 0) return "unsatisfiable";
	return { start, end };
}

/**
 * Stream a byte range of a file as a web stream, cancelled with the request.
 * @param target - absolute path of a regular file.
 * @param start - first byte offset.
 * @param end - last byte offset (inclusive).
 * @param signal - the request signal that aborts the read.
 * @returns the response body.
 */
function rangeBody(target, start, end, signal) {
	if (end < start) return new ReadableStream({ start: (controller) => controller.close() });
	const stream = createReadStream(target, { start, end });
	if (signal !== undefined && signal !== null) {
		signal.addEventListener("abort", () => stream.destroy(), { once: true });
	}
	return Readable.toWeb(stream);
}

/**
 * Normalize one root for prefix comparison.
 * @param root - absolute directory path.
 * @returns the path without a trailing separator (`/` stays `/`).
 */
function normalizeRoot(root) {
	const resolved = path.resolve(root);
	return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -path.sep.length) : resolved;
}

/**
 * Decide whether a canonical path lives inside one of the allowed roots.
 *
 * Comparison happens on the separator boundary so `/data/x2` is not accepted
 * for the root `/data/x`, and the root itself is always accepted.
 * @param candidate - canonical (realpath-resolved) absolute path.
 * @param roots - normalized allowed roots.
 * @returns whether the path may be served.
 */
export function withinAnyRoot(candidate, roots) {
	for (const root of roots) {
		if (root === path.sep) return true;
		if (candidate === root) return true;
		if (candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true;
	}
	return false;
}

/**
 * Resolve the roots this instance may serve files from.
 *
 * Precedence: `allowOutsideWorkspace: true` disables the fence entirely;
 * an explicit `allowedRoots` list wins over the workspace registry. When no
 * root can be determined (a bare connection without the workspace registry,
 * e.g. a headless boot that never opened a session) the fence stays open, so
 * the default install cannot break — the GUI always has a workspace, and then
 * the fence is active.
 * @param ctx - plugin context, used to reach `ctx.workspaceRegistry`.
 * @param config - plugin config (`allowOutsideWorkspace`, `allowedRoots`).
 * @returns allowed roots, or `null` when unrestricted.
 */
export async function resolveAllowedRoots(ctx, config = {}) {
	if (config?.allowOutsideWorkspace === true) return null;
	const explicit = Array.isArray(config?.allowedRoots)
		? config.allowedRoots.filter((entry) => typeof entry === "string" && path.isAbsolute(entry))
		: [];
	const candidates = explicit.length > 0 ? explicit : workspaceRoots(ctx);
	if (candidates.length === 0) return null;
	const roots = [];
	for (const candidate of candidates) {
		try {
			roots.push(normalizeRoot(await fsp.realpath(candidate)));
		} catch {
			/* a workspace that no longer exists cannot allow anything */
		}
	}
	return roots.length === 0 ? null : roots;
}

/**
 * Read a cordis service without declaring an inject dependency.
 *
 * `ctx.get(name)` is the documented way to peek at a service (`strict` means
 * "only when its providing fiber is active"); plain property access is kept as
 * a fallback for stub contexts in tests.
 * @param ctx - plugin context.
 * @param name - service name.
 * @returns the service, or `undefined` when unavailable.
 */
function serviceOf(ctx, name) {
	if (ctx === null || ctx === undefined) return undefined;
	try {
		if (typeof Reflect.get(ctx, "get") === "function") return ctx.get(name);
	} catch {
		/* fall through to the property read */
	}
	try {
		return Reflect.get(ctx, name);
	} catch {
		return undefined;
	}
}

/**
 * Read the canonical paths of every registered workspace.
 * @param ctx - plugin context.
 * @returns absolute workspace roots (paths of `ctx.workspaceRegistry`).
 */
function workspaceRoots(ctx) {
	const registry = serviceOf(ctx, "workspaceRegistry");
	if (registry === null || registry === undefined || typeof registry.list !== "function") return [];
	try {
		return (registry.list() ?? []).map((entry) => entry?.path).filter((entry) => typeof entry === "string");
	} catch {
		return [];
	}
}

/**
 * Apply the allowed-root fence to a requested path.
 *
 * The existing path is resolved through `realpath` first, so a symbolic link
 * inside the workspace cannot hand out a target outside it.
 * @param target - absolute path from the query string.
 * @param options - `{ resolveRoots }` supplied by {@link apply}.
 * @returns the canonical path to serve, or a failure to render.
 */
async function locate(target, options) {
	const roots = await resolveRootsOf(options);
	if (roots === null) return { path: target };
	let real;
	try {
		real = await fsp.realpath(target);
	} catch (error) {
		return { status: error?.code === "ENOENT" ? 404 : 403, text: "not accessible" };
	}
	if (!withinAnyRoot(real, roots)) {
		return { status: 403, text: "path is outside the allowed workspace roots" };
	}
	return { path: real };
}

/**
 * Resolve roots from the handler options, allowing a static list for tests.
 * @param options - handler options.
 * @returns allowed roots, or `null` when unrestricted.
 */
async function resolveRootsOf(options) {
	const provider = options?.resolveRoots;
	if (provider === undefined || provider === null) return null;
	if (typeof provider === "function") return await provider();
	return Array.isArray(provider) ? provider.map((entry) => normalizeRoot(entry)) : null;
}

/**
 * Answer `GET/HEAD /api/download?path=…`.
 * @param request - the authenticated request.
 * @param options - `{ resolveRoots }` from {@link apply}.
 * @returns the file response.
 */
export async function serveDownload(request, options) {
	const fail = (status, text) =>
		new Response(request.method === "HEAD" ? null : text, {
			status,
			headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
		});
	const url = new URL(request.url);
	const raw = url.searchParams.get("path");
	if (raw === null || raw.length === 0) return fail(400, "missing path");
	if (raw.includes("\u0000") || !path.isAbsolute(raw)) return fail(400, "absolute path required");
	const located = await locate(path.resolve(raw), options);
	if (located.path === undefined) return fail(located.status, located.text);
	const target = located.path;
	let info;
	try {
		info = await fsp.stat(target);
	} catch (error) {
		return fail(error?.code === "ENOENT" ? 404 : 403, "not accessible");
	}
	if (!info.isFile()) {
		return fail(403, info.isDirectory() ? "is a directory; use api/download.zip" : "not a regular file");
	}
	const requestedName = url.searchParams.get("name");
	const filename =
		(requestedName !== null && requestedName.length > 0 ? path.basename(requestedName) : path.basename(target)) ||
		"download";
	const headers = {
		...BASE_HEADERS,
		"Content-Type": mediaTypeOf(target),
		"Content-Disposition": contentDisposition(filename),
		"Accept-Ranges": "bytes",
	};
	const size = info.size;
	const rangeHeader = request.headers.get("range");
	if (rangeHeader !== null) {
		const range = parseRange(rangeHeader, size);
		if (range === "invalid") return fail(400, "invalid range");
		if (range === "unsatisfiable") {
			return new Response(request.method === "HEAD" ? null : "range not satisfiable", {
				status: 416,
				headers: { ...BASE_HEADERS, "Content-Range": `bytes */${size}`, "Content-Type": "text/plain; charset=utf-8" },
			});
		}
		headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
		headers["Content-Length"] = String(range.end - range.start + 1);
		if (request.method === "HEAD") return new Response(null, { status: 206, headers });
		return new Response(rangeBody(target, range.start, range.end, request.signal), { status: 206, headers });
	}
	headers["Content-Length"] = String(size);
	if (request.method === "HEAD") return new Response(null, { status: 200, headers });
	return new Response(rangeBody(target, 0, size - 1, request.signal), { status: 200, headers });
}

/**
 * DOS timestamp pair for a ZIP header.
 * @param value - the entry mtime.
 * @returns the packed `time` and `date` words.
 */
function dosDateTime(value) {
	const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
	const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
	return {
		time:
			((date.getHours() & 0x1f) << 11) |
			((date.getMinutes() & 0x3f) << 5) |
			(Math.floor(date.getSeconds() / 2) & 0x1f),
		date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f),
	};
}

/**
 * Walk a directory tree into ZIP entries, skipping symbolic links.
 * @param root - absolute directory path.
 * @returns entries in a stable, directory-first order.
 */
export async function collectZipEntries(root) {
	/** @type {Array<{ relPath: string, fullPath: string, size: number, mtime: Date, directory: boolean }>} */
	const entries = [];
	const walk = async (directory, prefix) => {
		const dirents = await fsp.readdir(directory, { withFileTypes: true });
		dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		for (const dirent of dirents) {
			const fullPath = path.join(directory, dirent.name);
			const relPath = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
			if (dirent.isSymbolicLink()) continue;
			if (dirent.isDirectory()) {
				let mtime;
				try {
					mtime = (await fsp.stat(fullPath)).mtime;
				} catch {
					mtime = new Date();
				}
				entries.push({ relPath: `${relPath}/`, fullPath, size: 0, mtime, directory: true });
				if (entries.length > MAX_ZIP_ENTRIES) throw new RangeError(`more than ${MAX_ZIP_ENTRIES} entries`);
				await walk(fullPath, relPath);
				continue;
			}
			if (!dirent.isFile()) continue;
			let info;
			try {
				info = await fsp.stat(fullPath);
			} catch {
				continue;
			}
			entries.push({ relPath, fullPath, size: info.size, mtime: info.mtime, directory: false });
			if (entries.length > MAX_ZIP_ENTRIES) throw new RangeError(`more than ${MAX_ZIP_ENTRIES} entries`);
		}
	};
	await walk(root, "");
	return entries;
}

/**
 * Total byte count of the archive these entries produce.
 * @param entries - entries from {@link collectZipEntries}.
 * @returns the exact archive size in bytes.
 */
export function zipByteLength(entries) {
	let total = END_OF_CENTRAL_DIRECTORY_BYTES;
	for (const entry of entries) {
		const nameBytes = Buffer.byteLength(entry.relPath, "utf8");
		total += LOCAL_HEADER_BYTES + nameBytes + CENTRAL_HEADER_BYTES + nameBytes;
		if (!entry.directory) total += entry.size + DATA_DESCRIPTOR_BYTES;
	}
	return total;
}

/**
 * Emit the archive as a sequence of buffers.
 * @param entries - planned entries.
 * @returns an async generator of archive chunks.
 */
async function* zipChunks(entries) {
	/** @type {Array<{ nameBytes: Buffer, crc: number, size: number, offset: number, dos: {time:number,date:number}, directory: boolean }>} */
	const central = [];
	let offset = 0;
	for (const entry of entries) {
		const nameBytes = Buffer.from(entry.relPath, "utf8");
		const dos = dosDateTime(entry.mtime);
		const flags = entry.directory ? ZIP_FLAG_UTF8 : ZIP_FLAG_UTF8 | ZIP_FLAG_DATA_DESCRIPTOR;
		const entryOffset = offset;
		const local = Buffer.alloc(LOCAL_HEADER_BYTES);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(ZIP_STORE, 8);
		local.writeUInt16LE(dos.time, 10);
		local.writeUInt16LE(dos.date, 12);
		local.writeUInt32LE(0, 14);
		local.writeUInt32LE(0, 18);
		local.writeUInt32LE(0, 22);
		local.writeUInt16LE(nameBytes.byteLength, 26);
		local.writeUInt16LE(0, 28);
		offset += local.byteLength + nameBytes.byteLength;
		yield Buffer.concat([local, nameBytes]);
		let checksum = 0;
		if (entry.directory) {
			checksum = 0;
		} else {
			checksum = 0;
			for await (const chunk of createReadStream(entry.fullPath)) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				checksum = crc32(bytes, checksum);
				offset += bytes.byteLength;
				yield bytes;
			}
			const descriptor = Buffer.alloc(DATA_DESCRIPTOR_BYTES);
			descriptor.writeUInt32LE(0x08074b50, 0);
			descriptor.writeUInt32LE(checksum >>> 0, 4);
			descriptor.writeUInt32LE(entry.size >>> 0, 8);
			descriptor.writeUInt32LE(entry.size >>> 0, 12);
			offset += descriptor.byteLength;
			yield descriptor;
		}
		central.push({ nameBytes, crc: checksum >>> 0, size: entry.size, offset: entryOffset, dos, directory: entry.directory });
	}
	let centralSize = 0;
	for (const entry of central) {
		const header = Buffer.alloc(CENTRAL_HEADER_BYTES);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(20, 6);
		header.writeUInt16LE(entry.directory ? ZIP_FLAG_UTF8 : ZIP_FLAG_UTF8 | ZIP_FLAG_DATA_DESCRIPTOR, 8);
		header.writeUInt16LE(ZIP_STORE, 10);
		header.writeUInt16LE(entry.dos.time, 12);
		header.writeUInt16LE(entry.dos.date, 14);
		header.writeUInt32LE(entry.crc, 16);
		header.writeUInt32LE(entry.size >>> 0, 20);
		header.writeUInt32LE(entry.size >>> 0, 24);
		header.writeUInt16LE(entry.nameBytes.byteLength, 28);
		header.writeUInt16LE(0, 30);
		header.writeUInt16LE(0, 32);
		header.writeUInt16LE(0, 34);
		header.writeUInt16LE(0, 36);
		header.writeUInt32LE(entry.directory ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
		header.writeUInt32LE(entry.offset >>> 0, 42);
		centralSize += CENTRAL_HEADER_BYTES + entry.nameBytes.byteLength;
		yield Buffer.concat([header, entry.nameBytes]);
	}
	const end = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_BYTES);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(central.length, 8);
	end.writeUInt16LE(central.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);
	yield end;
}

/**
 * Answer `GET/HEAD /api/download.zip?path=…`.
 * @param request - the authenticated request.
 * @param options - `{ resolveRoots }` from {@link apply}.
 * @returns the archive response.
 */
export async function serveZip(request, options) {
	const fail = (status, text) =>
		new Response(request.method === "HEAD" ? null : text, {
			status,
			headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
		});
	const url = new URL(request.url);
	const raw = url.searchParams.get("path");
	if (raw === null || raw.length === 0) return fail(400, "missing path");
	if (raw.includes("\u0000") || !path.isAbsolute(raw)) return fail(400, "absolute path required");
	const located = await locate(path.resolve(raw), options);
	if (located.path === undefined) return fail(located.status, located.text);
	const root = located.path;
	let info;
	try {
		info = await fsp.stat(root);
	} catch (error) {
		return fail(error?.code === "ENOENT" ? 404 : 403, "not accessible");
	}
	if (!info.isDirectory()) return fail(403, "not a directory");
	let entries;
	try {
		entries = await collectZipEntries(root);
	} catch (error) {
		return fail(error instanceof RangeError ? 413 : 500, String(error?.message ?? error));
	}
	const total = zipByteLength(entries);
	if (total > MAX_ZIP_BYTES) return fail(413, `archive would exceed ${MAX_ZIP_BYTES} bytes`);
	const filename = `${path.basename(root) || "workspace"}.zip`;
	const headers = {
		...BASE_HEADERS,
		"Content-Type": "application/zip",
		"Content-Disposition": contentDisposition(filename),
		"Content-Length": String(total),
	};
	if (request.method === "HEAD") return new Response(null, { headers });
	const signal = request.signal;
	const stream = Readable.from(
		(async function* () {
			for await (const chunk of zipChunks(entries)) {
				if (signal?.aborted === true) return;
				yield chunk;
			}
		})(),
	);
	if (signal !== undefined && signal !== null) {
		signal.addEventListener("abort", () => stream.destroy(), { once: true });
	}
	return new Response(Readable.toWeb(stream), { headers });
}

/**
 * Plugin entry point: register both routes on the connection service.
 * @param ctx - the plugin context.
 * @param config - plugin config: `allowOutsideWorkspace` (boolean, default
 * `false`) and `allowedRoots` (absolute directories, default: every
 * registered workspace root).
 */
export function apply(ctx, config = {}) {
	const connection = Reflect.get(ctx, "connection");
	if (connection === undefined) return;
	const options = { resolveRoots: () => resolveAllowedRoots(ctx, config) };
	ctx.effect(
		() =>
			connection.fetch.register({
				path: DOWNLOAD_PATH,
				methods: ["GET", "HEAD"],
				requestBody: "buffered",
				fetch: (request) => serveDownload(request, options),
			}),
		"workspace-download: /api/download",
	);
	ctx.effect(
		() =>
			connection.fetch.register({
				path: DOWNLOAD_ZIP_PATH,
				methods: ["GET", "HEAD"],
				requestBody: "buffered",
				fetch: (request) => serveZip(request, options),
			}),
		"workspace-download: /api/download.zip",
	);
}
