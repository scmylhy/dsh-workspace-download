/**
 * Client-bundle smoke tests: load `lib/client.js` the way the web shell does
 * (`window.__ModuleLoader__.load`) and drive the registered slot components and
 * context-menu contributions.
 *
 * React is stubbed down to "createElement returns its arguments" and the
 * document to "record the anchor that gets clicked", so this covers what the
 * plugin actually owns: the module contract, workspace path resolution, URL
 * building, Chinese labels, three slot registrations and two menu targets.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Session the fake client context exposes, with a POSIX workspace root. */
const SESSION_ID = "s-1";
const WORKSPACE = "/srv/workspaces/运维";

/** Load the client bundle into a fresh fake shell and return its exports. */
function loadClient() {
	const loaded = [];
	let modules;
	globalThis.window = {
		__ModuleLoader__: {
			load(spec) {
				loaded.push(spec);
				modules = spec.factory((id) => {
					if (id === "react") return {};
					if (id === "react/jsx-runtime") {
						return { jsx: (type, props) => ({ type, props }) };
					}
					throw new Error(`unexpected module request: ${id}`);
				});
			},
		},
	};
	return import(`../lib/client.js?cachebust=${Math.random()}`).then(() => ({ loaded, exports: modules }));
}

/**
 * Run the plugin body against a fake client context.
 * @param exports - the loaded module exports.
 * @returns the slot registrations and the context-menu contributions.
 */
function collectContributions(exports) {
	const registry = [];
	const menus = [];
	const ctx = {
		slots: {
			inject(name, factory) {
				assert.equal(typeof name, "string");
				factory();
			},
			register(spec, component) {
				registry.push({ spec, component });
			},
		},
		contextMenus: {
			register(contribution) {
				menus.push(contribution);
				return () => {};
			},
		},
		sessions: {
			list: {
				getSnapshot() {
					return { byId: { [SESSION_ID]: { cwd: WORKSPACE } } };
				},
			},
		},
		effect(run) {
			return run();
		},
	};
	exports.apply(ctx);
	return { registry, menus };
}

/**
 * Execute a menu action with a document stub that records the anchor click.
 * @param run - the action's `run` callback.
 * @returns the href that was clicked.
 */
function clickOf(run) {
	const clicked = [];
	const created = [];
	const appended = [];
	globalThis.document = {
		body: {
			appendChild(element) {
				appended.push(element);
			},
		},
		createElement(tag) {
			assert.equal(tag, "a");
			const anchor = {
				style: {},
				click() {
					clicked.push(this.href);
				},
				remove() {
					assert.equal(anchor.removed, undefined);
					anchor.removed = true;
				},
			};
			created.push(anchor);
			return anchor;
		},
	};
	try {
		run();
	} finally {
		delete globalThis.document;
	}
	assert.equal(created.length, 1);
	assert.deepEqual(appended, created);
	assert.equal(created[0].removed, true);
	assert.equal(created[0].download, "");
	assert.equal(created[0].style.display, "none");
	assert.equal(clicked.length, 1);
	return clicked[0];
}

describe("client bundle", () => {
	it("loads as a ModuleLoader plugin exporting apply and inject", async () => {
		const { loaded, exports } = await loadClient();
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].id, "dsh-workspace-download");
		assert.equal(typeof exports.apply, "function");
		assert.deepEqual(exports.inject, ["slots", "contextMenus", "sessions"]);
	});

	it("registers the three sidebar contributions", async () => {
		const { exports } = await loadClient();
		const { registry } = collectContributions(exports);
		assert.deepEqual(
			registry.map((entry) => entry.spec.name),
			[
				"sidebar.right.tab.document.actions",
				"sidebar.right.tab.document.unpreviewable",
				"sidebar.right.tab.files.actions",
			],
		);
		for (const entry of registry) {
			assert.equal(entry.spec.id, "workspace-download");
			assert.equal(typeof entry.component, "function");
		}
	});

	it("registers one file and one directory context-menu contribution", async () => {
		const { exports } = await loadClient();
		const { menus } = collectContributions(exports);
		assert.deepEqual(
			menus.map((menu) => ({ id: menu.id, target: menu.target, order: menu.order })),
			[
				{ id: "workspace-download.file", target: "file", order: 120 },
				{ id: "workspace-download.directory", target: "directory", order: 120 },
			],
		);
		for (const menu of menus) assert.equal(typeof menu.resolve, "function");
	});

	it("links the header action at the streaming route", async () => {
		const { exports } = await loadClient();
		const { registry } = collectContributions(exports);
		const action = registry.find((entry) => entry.spec.name === "sidebar.right.tab.document.actions");
		const element = action.component({ absolutePath: "/home/dev/工作区/报告 2026.pdf" });
		assert.equal(element.type, "a");
		assert.equal(
			element.props.href,
			"api/download?path=%2Fhome%2Fdev%2F%E5%B7%A5%E4%BD%9C%E5%8C%BA%2F%E6%8A%A5%E5%91%8A%202026.pdf&name=%E6%8A%A5%E5%91%8A%202026.pdf",
		);
		assert.equal(element.props.download, "报告 2026.pdf");
		assert.equal(element.props.children, "下载");
		assert.equal(action.component({}), null);
	});

	it("resolves routes against the deployment prefix", async () => {
		const { exports } = await loadClient();
		const { registry } = collectContributions(exports);
		globalThis.document = { baseURI: "https://dsh.scmylhy.cn:8443/sub/app/" };
		try {
			const files = registry.find((entry) => entry.spec.name === "sidebar.right.tab.files.actions");
			const element = files.component({ absolutePath: "/srv/workspaces/运维" });
			assert.equal(
				element.props.href,
				"https://dsh.scmylhy.cn:8443/sub/app/api/download.zip?path=%2Fsrv%2Fworkspaces%2F%E8%BF%90%E7%BB%B4",
			);
			assert.equal(element.props.download, "运维.zip");
		} finally {
			delete globalThis.document;
		}
	});

	it("explains and links unpublishable previews", async () => {
		const { exports } = await loadClient();
		const { registry } = collectContributions(exports);
		const empty = registry.find((entry) => entry.spec.name === "sidebar.right.tab.document.unpreviewable");
		const element = empty.component({ absolutePath: "/home/dev/big.iso" });
		assert.equal(element.type, "div");
		const parts = element.props.children;
		assert.equal(parts.length, 3);
		assert.equal(parts[2].type, "a");
		assert.equal(parts[2].props.download, "big.iso");
		assert.equal(parts[2].props.children, "下载文件");
		assert.equal(empty.component({}), null);
	});

	it("offers 下载此文件 for a tree row, joining the Session workspace", async () => {
		const { exports } = await loadClient();
		const { menus } = collectContributions(exports);
		const actions = menus[0].resolve({ sessionId: SESSION_ID, path: "docs/报告 2026.pdf" }, new AbortController().signal);
		assert.equal(actions.length, 1);
		assert.equal(actions[0].id, "workspace-download.download");
		assert.equal(actions[0].label, "下载此文件（报告 2026.pdf）");
		assert.equal(actions[0].failureLabel, "下载失败");
		assert.equal(
			clickOf(actions[0].run),
			"api/download?path=%2Fsrv%2Fworkspaces%2F%E8%BF%90%E7%BB%B4%2Fdocs%2F%E6%8A%A5%E5%91%8A%202026.pdf&name=%E6%8A%A5%E5%91%8A%202026.pdf",
		);
	});

	it("keeps an already absolute file path as handed over", async () => {
		const { exports } = await loadClient();
		const { menus } = collectContributions(exports);
		const actions = menus[0].resolve({ sessionId: SESSION_ID, path: "/var/log/系统.log" }, new AbortController().signal);
		assert.match(clickOf(actions[0].run), /path=%2Fvar%2Flog%2F%E7%B3%BB%E7%BB%9F\.log/);
	});

	it("disables the file action when the Session workspace is unknown", async () => {
		const { exports } = await loadClient();
		const { menus } = collectContributions(exports);
		const actions = menus[0].resolve({ sessionId: "missing", path: "notes.md" }, new AbortController().signal);
		assert.deepEqual(
			actions.map((action) => ({ label: action.label, disabled: action.disabled, run: action.run })),
			[{ label: "下载", disabled: true, run: undefined }],
		);
	});

	it("zips the clicked directory, or the workspace root", async () => {
		const { exports } = await loadClient();
		const { menus } = collectContributions(exports);
		const child = menus[1].resolve({ sessionId: SESSION_ID, path: "子目录" }, new AbortController().signal);
		assert.equal(child.length, 1);
		assert.equal(child[0].label, "打包下载此目录");
		assert.equal(
			clickOf(child[0].run),
			"api/download.zip?path=%2Fsrv%2Fworkspaces%2F%E8%BF%90%E7%BB%B4%2F%E5%AD%90%E7%9B%AE%E5%BD%95",
		);
		const root = menus[1].resolve({ sessionId: SESSION_ID, path: WORKSPACE }, new AbortController().signal);
		assert.match(clickOf(root[0].run), /api\/download\.zip\?path=%2Fsrv%2Fworkspaces%2F%E8%BF%90%E7%BB%B4$/);
	});
});
