/**
 * Download controls for the DSH web client.
 *
 * Three slot contributions inside the existing “工作区文件” panel:
 *
 * - `sidebar.right.tab.document.actions` — a 下载 link in the document header,
 *   so any previewed file can be saved with its real name.
 * - `sidebar.right.tab.document.unpreviewable` — a download card for files the
 *   previewer refuses (too large, unsupported type), which is exactly the case
 *   the built-in 20 MiB `/api/file` limit used to make a dead end.
 * - `sidebar.right.tab.files.actions` — 打包下载 in the file-tree header,
 *   streaming the whole workspace as a ZIP.
 *
 * Two context-menu contributions, so the tree also offers per-item downloads
 * without opening a file first:
 *
 * - `file` target → 下载此文件 (`api/download`).
 * - `directory` target → 打包下载此目录 (`api/download.zip`).
 *
 * Every link hits this plugin's streaming routes (`api/download`,
 * `api/download.zip`) as a relative URL resolved against `document.baseURI`,
 * so a deployment prefix keeps working.
 *
 * @module dsh-workspace-download/client
 */
window.__ModuleLoader__.load({
	id: "dsh-workspace-download",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");

		/** Dictionary namespace owned by this plugin. */
		const NS = "workspace-download";
		const DOWNLOAD_ROUTE = "api/download";
		const ZIP_ROUTE = "api/download.zip";

		/**
		 * Resolve one of this plugin's routes against the application base.
		 * @param route - relative route, e.g. `api/download`.
		 * @param search - query string parameters.
		 * @returns an absolute-or-relative URL usable in an anchor.
		 */
		function routeUrl(route, search) {
			const target = `${route}?${search}`;
			const base = typeof document === "undefined" ? undefined : document.baseURI;
			if (typeof base !== "string" || base.length === 0) return target;
			try {
				return new URL(target, base).href;
			} catch {
				return target;
			}
		}

		/**
		 * Download URL of a single file.
		 * @param absolutePath - native path of the file.
		 * @param name - optional suggested file name.
		 * @returns the anchor target.
		 */
		function downloadUrl(absolutePath, name) {
			const search =
				name === undefined
					? `path=${encodeURIComponent(absolutePath)}`
					: `path=${encodeURIComponent(absolutePath)}&name=${encodeURIComponent(name)}`;
			return routeUrl(DOWNLOAD_ROUTE, search);
		}

		/**
		 * Download URL of a whole directory.
		 * @param absolutePath - native path of the directory.
		 * @returns the anchor target.
		 */
		function zipUrl(absolutePath) {
			return routeUrl(ZIP_ROUTE, `path=${encodeURIComponent(absolutePath)}`);
		}

		/**
		 * Basename of a native path, for labels and suggested names.
		 * @param absolutePath - native path.
		 * @returns the final path segment.
		 */
		function basenameOf(absolutePath) {
			const parts = String(absolutePath).split(/[/\\]/u).filter((part) => part.length > 0);
			return parts.length === 0 ? "下载" : parts[parts.length - 1];
		}

		/**
		 * Whether a path is already native-absolute (POSIX, drive-letter, or UNC).
		 * @param path - path as the host hands it to a context menu.
		 * @returns true when joining it with the workspace root is wrong.
		 */
		function isAbsolutePath(path) {
			return (
				typeof path === "string" &&
				(path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[/\\]/u.test(path))
			);
		}

		/**
		 * Absolute path of a context-menu target.
		 *
		 * The file tree reports row paths relative to the Session workspace, while
		 * the file page's own path label reports the root itself, so both spellings
		 * arrive here. The plugin's routes only accept absolute paths inside an
		 * allowed root, hence the join.
		 *
		 * @param ctx - the client plugin context (reads the Session list).
		 * @param sessionId - the Session the target was captured in.
		 * @param path - absolute or workspace-relative path.
		 * @returns the absolute path, or undefined when it cannot be resolved.
		 */
		function absolutePathOf(ctx, sessionId, path) {
			if (isAbsolutePath(path)) return path;
			const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) return undefined;
			if (typeof path !== "string" || path.length === 0) return cwd;
			const separator = cwd.includes("\\") ? "\\" : "/";
			return `${cwd.replace(/[/\\]+$/u, "")}${separator}${path.replace(/^(?:\.?[/\\])+/u, "")}`;
		}

		/**
		 * Start a browser download for a route of this plugin.
		 *
		 * A context-menu action runs without an anchor of its own, so one is
		 * synthesised and clicked inside the same user gesture; the `download`
		 * attribute keeps the response's own name and the route sets
		 * `Content-Disposition` anyway.
		 *
		 * @param url - absolute URL of `api/download` or `api/download.zip`.
		 */
		function startDownload(url) {
			if (typeof document === "undefined") return;
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "";
			anchor.rel = "noopener";
			anchor.style.display = "none";
			document.body.appendChild(anchor);
			try {
				anchor.click();
			} finally {
				anchor.remove();
			}
		}

		const actionStyle = {
			appearance: "none",
			alignItems: "center",
			background: "transparent",
			border: "1px solid currentColor",
			borderRadius: "6px",
			color: "inherit",
			cursor: "pointer",
			display: "inline-flex",
			font: "inherit",
			fontSize: "12px",
			gap: "4px",
			lineHeight: "20px",
			opacity: 0.72,
			padding: "0 8px",
			textDecoration: "none",
			whiteSpace: "nowrap",
		};

		const prominentStyle = {
			...actionStyle,
			borderColor: "transparent",
			background: "currentColor",
			color: "#ffffff",
			fontSize: "13px",
			fontWeight: 500,
			lineHeight: "28px",
			opacity: 1,
			padding: "0 14px",
		};

		/**
		 * Document-header 下载 action.
		 * @param props - slot props; carries the previewed file's absolute path.
		 * @returns the anchor, or nothing when the slot has no file.
		 */
		function FileDownloadAction(props) {
			if (typeof props.absolutePath !== "string" || props.absolutePath.length === 0) return null;
			const name = basenameOf(props.absolutePath);
			return jsxRuntime.jsx("a", {
				href: downloadUrl(props.absolutePath, name),
				download: name,
				title: `下载 ${name}（不限大小）`,
				"data-workspace-download": "document",
				style: actionStyle,
				children: "下载",
			});
		}

		/**
		 * Body shown in place of a preview the previewer refused.
		 * @param props - slot props; carries the file's absolute path.
		 * @returns the download card.
		 */
		function FileDownloadEmpty(props) {
			const absolutePath = props.absolutePath;
			if (typeof absolutePath !== "string" || absolutePath.length === 0) return null;
			const name = basenameOf(absolutePath);
			return jsxRuntime.jsx("div", {
				style: {
					alignItems: "center",
					display: "flex",
					flexDirection: "column",
					gap: "10px",
					justifyContent: "center",
					padding: "24px 16px",
					textAlign: "center",
				},
				children: [
					jsxRuntime.jsx("div", {
						style: { fontSize: "13px", opacity: 0.75, wordBreak: "break-all" },
						children: name,
					}),
					jsxRuntime.jsx("div", {
						style: { fontSize: "12px", opacity: 0.55, lineHeight: "18px", maxWidth: "32em" },
						children: "此文件无法在侧栏预览（格式不支持或体积过大），可直接下载到本地。",
					}),
					jsxRuntime.jsx("a", {
						href: downloadUrl(absolutePath, name),
						download: name,
						"data-workspace-download": "unpreviewable",
						style: prominentStyle,
						children: "下载文件",
					}),
				],
			});
		}

		/**
		 * File-tree header 打包下载 action.
		 * @param props - slot props; carries the workspace root.
		 * @returns the anchor, or nothing without a root.
		 */
		function DirectoryDownloadAction(props) {
			if (typeof props.absolutePath !== "string" || props.absolutePath.length === 0) return null;
			const name = `${basenameOf(props.absolutePath)}.zip`;
			return jsxRuntime.jsx("a", {
				href: zipUrl(props.absolutePath),
				download: name,
				title: "把整个工作区打包为 ZIP 下载",
				"data-workspace-download": "workspace",
				style: actionStyle,
				children: "打包下载",
			});
		}

		/**
		 * “下载此文件” entry of the shared context menu for a file target.
		 * @param ctx - the client plugin context (reads the Session list).
		 * @returns the menu contribution.
		 */
		function fileMenuContribution(ctx) {
			return {
				id: `${NS}.file`,
				target: "file",
				order: 120,
				resolve: ({ sessionId, path }) => {
					const absolutePath = absolutePathOf(ctx, sessionId, path);
					if (absolutePath === undefined) {
						return [{ id: `${NS}.download`, label: "下载", disabled: true }];
					}
					const name = basenameOf(absolutePath);
					return [
						{
							id: `${NS}.download`,
							label: `下载此文件（${name}）`,
							failureLabel: "下载失败",
							run: () => startDownload(downloadUrl(absolutePath, name)),
						},
					];
				},
			};
		}

		/**
		 * “打包下载此目录” entry of the shared context menu for a directory target.
		 * @param ctx - the client plugin context (reads the Session list).
		 * @returns the menu contribution.
		 */
		function directoryMenuContribution(ctx) {
			return {
				id: `${NS}.directory`,
				target: "directory",
				order: 120,
				resolve: ({ sessionId, path }) => {
					const absolutePath = absolutePathOf(ctx, sessionId, path);
					if (absolutePath === undefined) {
						return [{ id: `${NS}.zip`, label: "打包下载此目录", disabled: true }];
					}
					return [
						{
							id: `${NS}.zip`,
							label: "打包下载此目录",
							failureLabel: "打包下载失败",
							run: () => startDownload(zipUrl(absolutePath)),
						},
					];
				},
			};
		}

		/**
		 * Client plugin body: register the three slot contributions and the two
		 * per-item context-menu entries.
		 * @param ctx - the client plugin context.
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.right.tab.document.actions", () =>
				ctx.slots.register(
					{ name: "sidebar.right.tab.document.actions", id: NS, order: 90 },
					FileDownloadAction,
				),
			);
			ctx.slots.inject("sidebar.right.tab.document.unpreviewable", () =>
				ctx.slots.register(
					{ name: "sidebar.right.tab.document.unpreviewable", id: NS },
					FileDownloadEmpty,
				),
			);
			ctx.slots.inject("sidebar.right.tab.files.actions", () =>
				ctx.slots.register({ name: "sidebar.right.tab.files.actions", id: NS }, DirectoryDownloadAction),
			);
			ctx.effect(() => ctx.contextMenus.register(fileMenuContribution(ctx)));
			ctx.effect(() => ctx.contextMenus.register(directoryMenuContribution(ctx)));
		}

		const inject = ["slots", "contextMenus", "sessions"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
