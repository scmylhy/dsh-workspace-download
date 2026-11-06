/**
 * Handler tests for the workspace-download plugin, runnable without DSH:
 * `node --test test/`
 *
 * The plugin's `apply` only talks to `ctx.connection.fetch.register`, so a
 * stub context captures the registered routes and the handlers are exercised
 * directly against a fixture tree on disk.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

import {
	apply,
	DOWNLOAD_PATH,
	DOWNLOAD_ZIP_PATH,
	parseRange,
	resolveAllowedRoots,
	withinAnyRoot,
	zipByteLength,
	collectZipEntries,
} from "../lib/index.js";

const run = promisify(execFile);

/** Build a stub plugin context that records the registered fetch routes. */
function stubContext() {
	const routes = new Map();
	const effects = [];
	const ctx = {
		connection: {
			fetch: {
				register(spec) {
					routes.set(spec.path, spec);
					return () => routes.delete(spec.path);
				},
			},
		},
		effect(factory) {
			effects.push(factory());
		},
	};
	return { ctx, routes, effects };
}

/** Wrap a URL path in a GET/HEAD request like the connection layer does. */
function request(urlPath, method = "GET", headers = {}) {
	return new Request(`http://127.0.0.1:3080${urlPath}`, { method, headers });
}

/** Assemble a fixture tree and return its paths. */
async function makeFixture(root) {
	const small = path.join(root, "small.txt");
	await fsp.writeFile(small, "hello world\n", "utf8");
	const big = path.join(root, "big.bin");
	const bigBytes = Buffer.alloc(30 * 1024 * 1024 + 123, 7);
	await fsp.writeFile(big, bigBytes);
	const nested = path.join(root, "nested");
	await fsp.mkdir(path.join(nested, "deeper"), { recursive: true });
	await fsp.writeFile(path.join(nested, "a.md"), "# a\n", "utf8");
	await fsp.writeFile(path.join(nested, "deeper", "中文.txt"), "内容\n", "utf8");
	await fsp.mkdir(path.join(root, "empty"), { recursive: true });
	return { small, big, bigBytes, nested, root };
}

describe("workspace-download routes", () => {
	let root;
	let fixture;
	let routes;

	before(async () => {
		root = await fsp.mkdtemp(path.join(tmpdir(), "wsdl-"));
		fixture = await makeFixture(root);
		const { ctx, routes: registered } = stubContext();
		apply(ctx);
		routes = registered;
	});

	after(async () => {
		await fsp.rm(root, { recursive: true, force: true });
	});

	it("registers both routes", () => {
		assert.ok(routes.has(DOWNLOAD_PATH), "download route registered");
		assert.ok(routes.has(DOWNLOAD_ZIP_PATH), "zip route registered");
		assert.deepEqual(routes.get(DOWNLOAD_PATH).methods, ["GET", "HEAD"]);
	});

	it("streams a small file with an attachment disposition", async () => {
		const handler = routes.get(DOWNLOAD_PATH).fetch;
		const response = await handler(request(`${DOWNLOAD_PATH}?path=${encodeURIComponent(fixture.small)}`));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-length"), "12");
		assert.equal(response.headers.get("accept-ranges"), "bytes");
		assert.match(response.headers.get("content-disposition"), /^attachment; filename="small\.txt"; filename\*=UTF-8''small\.txt$/u);
		assert.equal(await response.text(), "hello world\n");
	});

	it("serves HEAD without a body", async () => {
		const handler = routes.get(DOWNLOAD_PATH).fetch;
		const response = await handler(request(`${DOWNLOAD_PATH}?path=${encodeURIComponent(fixture.small)}`, "HEAD"));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-length"), "12");
		assert.equal(await response.text(), "");
	});

	it("answers byte ranges", async () => {
		const handler = routes.get(DOWNLOAD_PATH).fetch;
		const url = `${DOWNLOAD_PATH}?path=${encodeURIComponent(fixture.small)}`;
		const middle = await handler(request(url, "GET", { range: "bytes=6-10" }));
		assert.equal(middle.status, 206);
		assert.equal(middle.headers.get("content-range"), "bytes 6-10/12");
		assert.equal(await middle.text(), "world");

		const tail = await handler(request(url, "GET", { range: "bytes=-6" }));
		assert.equal(tail.status, 206);
		assert.equal(tail.headers.get("content-range"), "bytes 6-11/12");
		assert.equal(await tail.text(), "world\n");

		const unsatisfiable = await handler(request(url, "GET", { range: "bytes=100-200" }));
		assert.equal(unsatisfiable.status, 416);
		assert.equal(unsatisfiable.headers.get("content-range"), "bytes */12");

		const invalid = await handler(request(url, "GET", { range: "bytes=zzz" }));
		assert.equal(invalid.status, 400);
	});

	it("streams a 30 MiB file that the 20 MiB /api/file route refuses", async () => {
		const handler = routes.get(DOWNLOAD_PATH).fetch;
		const response = await handler(request(`${DOWNLOAD_PATH}?path=${encodeURIComponent(fixture.big)}`));
		assert.equal(response.status, 200);
		assert.equal(Number(response.headers.get("content-length")), fixture.bigBytes.byteLength);
		const body = Buffer.from(await response.arrayBuffer());
		assert.equal(body.byteLength, fixture.bigBytes.byteLength);
		const digest = (value) => createHash("sha256").update(value).digest("hex");
		assert.equal(digest(body), digest(fixture.bigBytes));
	});

	it("rejects malformed paths and directories", async () => {
		const handler = routes.get(DOWNLOAD_PATH).fetch;
		const missing = await handler(request(DOWNLOAD_PATH));
		assert.equal(missing.status, 400);
		const relative = await handler(request(`${DOWNLOAD_PATH}?path=etc%2Fpasswd`));
		assert.equal(relative.status, 400);
		const absent = await handler(request(`${DOWNLOAD_PATH}?path=${encodeURIComponent(path.join(root, "nope.txt"))}`));
		assert.equal(absent.status, 404);
		const directory = await handler(request(`${DOWNLOAD_PATH}?path=${encodeURIComponent(root)}`));
		assert.equal(directory.status, 403);
	});

	it("suggests the requested name when given", async () => {
		const handler = routes.get(DOWNLOAD_PATH).fetch;
		const url = `${DOWNLOAD_PATH}?path=${encodeURIComponent(fixture.small)}&name=${encodeURIComponent("报告 final.txt")}`;
		const response = await handler(request(url));
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''%E6%8A%A5%E5%91%8A%20final\.txt$/u);
	});

	it("zips a directory tree and reports its exact byte length", async () => {
		const handler = routes.get(DOWNLOAD_ZIP_PATH).fetch;
		const url = `${DOWNLOAD_ZIP_PATH}?path=${encodeURIComponent(fixture.nested)}`;
		const response = await handler(request(url));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "application/zip");
		assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''nested\.zip$/u);
		const declared = Number(response.headers.get("content-length"));
		const bytes = Buffer.from(await response.arrayBuffer());
		assert.equal(bytes.byteLength, declared);
		const archive = path.join(tmpdir(), `wsdl-${process.pid}.zip`);
		await fsp.writeFile(archive, bytes);
		const { stdout } = await run("python3", [
			"-c",
			[
				"import sys, zipfile",
				"z = zipfile.ZipFile(sys.argv[1])",
				"assert z.testzip() is None, 'crc mismatch'",
				"print('|'.join(sorted(z.namelist())))",
				"print(z.read('deeper/中文.txt').decode('utf-8'))",
			].join("\n"),
			archive,
		]);
		await fsp.rm(archive, { force: true });
		const [names, content] = stdout.trim().split("\n");
		assert.deepEqual(names.split("|"), ["a.md", "deeper/", "deeper/中文.txt"]);
		assert.equal(content, "内容");
	});

	it("plans the same byte count it streams for a whole workspace", async () => {
		const entries = await collectZipEntries(root);
		const planned = zipByteLength(entries);
		const handler = routes.get(DOWNLOAD_ZIP_PATH).fetch;
		const response = await handler(request(`${DOWNLOAD_ZIP_PATH}?path=${encodeURIComponent(root)}`, "HEAD"));
		assert.equal(response.status, 200);
		assert.equal(Number(response.headers.get("content-length")), planned);
		const body = Buffer.from(await (await handler(request(`${DOWNLOAD_ZIP_PATH}?path=${encodeURIComponent(root)}`))).arrayBuffer());
		assert.equal(body.byteLength, planned);
	});
});

describe("workspace root fence", () => {
	it("accepts a root and any descendant, but not a sibling sharing the prefix", () => {
		const roots = ["/data/x"];
		assert.equal(withinAnyRoot("/data/x", roots), true);
		assert.equal(withinAnyRoot("/data/x/file.txt", roots), true);
		assert.equal(withinAnyRoot("/data/x/deep/a/b", roots), true);
		assert.equal(withinAnyRoot("/data/x2", roots), false);
		assert.equal(withinAnyRoot("/data/x2/file.txt", roots), false);
		assert.equal(withinAnyRoot("/data", roots), false);
		assert.equal(withinAnyRoot("/etc/hostname", roots), false);
	});

	it("treats `/` as a root that allows everything", () => {
		assert.equal(withinAnyRoot("/etc/hostname", ["/"]), true);
	});

	it("resolves roots from the workspace registry", async () => {
		const root = await fsp.mkdtemp(path.join(tmpdir(), "wsdl-reg-"));
		try {
			const ctx = { workspaceRegistry: { list: () => [{ path: root }, { path: "/nonexistent-workspace" }] } };
			const resolved = await resolveAllowedRoots(ctx, {});
			assert.deepEqual(resolved, [await fsp.realpath(root)]);
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	it("stays unrestricted without a usable root, and when explicitly allowed", async () => {
		assert.equal(await resolveAllowedRoots({}, {}), null);
		assert.equal(await resolveAllowedRoots({ workspaceRegistry: { list: () => [] } }, {}), null);
		assert.equal(await resolveAllowedRoots({ workspaceRegistry: { list: () => [{ path: "/etc" }] } }, { allowOutsideWorkspace: true }), null);
		const resolved = await resolveAllowedRoots({}, { allowedRoots: ["/etc"] });
		assert.deepEqual(resolved, ["/etc"]);
	});
});

describe("allowed-root enforcement on the handlers", () => {
	let root;
	let outside;
	let routes;

	before(async () => {
		root = await fsp.mkdtemp(path.join(tmpdir(), "wsdl-fence-"));
		outside = await fsp.mkdtemp(path.join(tmpdir(), "wsdl-outside-"));
		await fsp.writeFile(path.join(root, "inside.txt"), "inside\n", "utf8");
		await fsp.mkdir(path.join(root, "dir"), { recursive: true });
		await fsp.writeFile(path.join(root, "dir", "a.txt"), "a\n", "utf8");
		await fsp.writeFile(path.join(outside, "outside.txt"), "outside\n", "utf8");
		const { ctx, routes: registered } = stubContext();
		apply(ctx, { allowedRoots: [root] });
		routes = registered;
	});

	after(async () => {
		await fsp.rm(root, { recursive: true, force: true });
		await fsp.rm(outside, { recursive: true, force: true });
	});

	it("serves a file inside the allowed root", async () => {
		const handler = routes.get(DOWNLOAD_PATH).fetch;
		const response = await handler(request(`${DOWNLOAD_PATH}?path=${encodeURIComponent(path.join(root, "inside.txt"))}`));
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "inside\n");
	});

	it("refuses a file outside the allowed root", async () => {
		const handler = routes.get(DOWNLOAD_PATH).fetch;
		for (const target of [path.join(outside, "outside.txt"), "/etc/hostname"]) {
			const response = await handler(request(`${DOWNLOAD_PATH}?path=${encodeURIComponent(target)}`));
			assert.equal(response.status, 403, target);
			assert.match(await response.text(), /outside the allowed workspace roots/u);
		}
	});

	it("refuses a symbolic link that escapes the allowed root", async () => {
		const link = path.join(root, "escape.txt");
		await fsp.symlink("/etc/hostname", link);
		const handler = routes.get(DOWNLOAD_PATH).fetch;
		const response = await handler(request(`${DOWNLOAD_PATH}?path=${encodeURIComponent(link)}`));
		assert.equal(response.status, 403);
	});

	it("refuses a directory outside the allowed root on the ZIP route", async () => {
		const handler = routes.get(DOWNLOAD_ZIP_PATH).fetch;
		const denied = await handler(request(`${DOWNLOAD_ZIP_PATH}?path=${encodeURIComponent(outside)}`));
		assert.equal(denied.status, 403);
		const allowed = await handler(request(`${DOWNLOAD_ZIP_PATH}?path=${encodeURIComponent(path.join(root, "dir"))}`));
		assert.equal(allowed.status, 200);
		assert.equal(allowed.headers.get("content-type"), "application/zip");
	});

	it("keeps serving without a fence when no root is configured", async () => {
		const { ctx, routes: registered } = stubContext();
		apply(ctx);
		const handler = registered.get(DOWNLOAD_PATH).fetch;
		const response = await handler(request(`${DOWNLOAD_PATH}?path=${encodeURIComponent(path.join(root, "inside.txt"))}`));
		assert.equal(response.status, 200);
	});
});

describe("parseRange", () => {
	it("handles open, bounded and suffix ranges", () => {
		assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
		assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
		assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
		assert.deepEqual(parseRange("bytes=90-999", 100), { start: 90, end: 99 });
		assert.equal(parseRange("bytes=100-200", 100), "unsatisfiable");
		assert.equal(parseRange("bytes=9-3", 100), "invalid");
		assert.equal(parseRange("items=0-1", 100), "invalid");
		assert.equal(parseRange("bytes=-0", 100), "invalid");
	});
});
