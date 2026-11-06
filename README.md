# dsh-workspace-download

为 DSH Web 右侧栏补上「下载」：任何工作区目录下的任意文件都能直接流式下载，任意目录都能一键打包成 ZIP，
不再受内置预览通道的大小限制（>20 MiB 的文件同样可直接下载）。

## 它做了什么

| 位置 | 行为 |
| --- | --- |
| 文件预览面板标题栏 | 「下载」按钮：下载当前预览的文件（浏览器直连下载，流式，不占用前端内存） |
| 文件无法预览时的空态 | 说明文字 + 「下载文件」链接（大文件、二进制、未知格式都能拿到） |
| 右侧栏「工作区文件」标题栏 | 「打包下载」按钮：把当前工作区根目录整体打包为 `<工作区名>.zip` 流式下载 |
| 文件树里右键单个文件 | 「下载此文件（文件名）」：不必先点开预览，直接流式下载该文件 |
| 文件树里右键任意目录 | 「打包下载此目录」：只打包这一棵子树，而不是整个工作区 |

背后是两条零依赖的 HTTP 路由（同一进程，复用 DSH 自身的鉴权与 Cookie）：

- `GET|HEAD /api/download?path=<绝对路径>[&name=<下载名>]` —— 单文件流式下载，支持 `Range`（断点续传/拖动播放）、
  `Content-Length` 精确、`Content-Type` 按扩展名推断、危险类型带 `CSP: sandbox`。
- `GET|HEAD /api/download.zip?path=<绝对路径>` —— 目录打包下载：先预扫描算出精确字节数再回 `Content-Length`，
  然后流式输出 ZIP（store 模式，无压缩 CPU 开销，中文文件名按 UTF-8 标记）。

右键菜单里的路径既可能是绝对路径（文件页标题栏的当前目录），也可能是相对工作区根的路径（文件树的行），
插件会用当前会话的 `cwd` 把相对路径补成绝对路径再发请求；会话工作区未知时菜单项置灰而不是发一个注定 403 的请求。

限制与安全：只接受绝对路径；目录条目跳过符号链接；打包上限 20 万条目 / 4 GiB；错误码 `400`（路径非法）、
`403`（越界/是目录/无权限）、`404`（不存在）、`413`（超限）、`416`（Range 越界）。

## 安全边界：下载围栏

两条路由默认只服务「本实例已注册的工作区」里的路径，不需要任何配置：

| 配置 | 含义 |
| --- | --- |
| （不配置，默认） | 允许根 = `ctx.workspaceRegistry.list()` 里每个工作区的 `path`，即 GUI 中打开过的每个工作区 |
| `allowedRoots: ["/abs/dir", ...]` | 显式覆盖：只认这些绝对路径（非绝对路径条目被忽略）；配置了就不再读工作区注册表 |
| `allowOutsideWorkspace: true` | 彻底关闭围栏（任何绝对路径都能下，等同 0.1.0 的行为，不建议） |

判定细节：

- 先 `realpath` 再比较，所以工作区里的符号链接无法逃逸到外部（`ws/符号链接.txt → /etc/hostname` 会 403）；
- 目录前缀按分隔符边界比较，`/data/x2` 不会因为根是 `/data/x` 而被放行；
- 越界一律 `403`，正文写明 `path is outside the allowed workspace roots`；
- **兜底放行**：拿不到工作区注册表（无 GUI 的裸 boot、插件被单独加载）或注册表为空时，围栏自动放行，
  避免默认安装把一个还没打开工作区的实例锁死。GUI 一旦有工作区，围栏立即生效。

在 profile 的 `cordis.patch.yml` 里覆写配置（可选）：

```yaml
- id: workspace-download
  name: dsh-workspace-download
  config:
    # 显式列出允许的根；不写则自动取工作区注册表
    allowedRoots:
      - /home/dev/workspace
    # allowOutsideWorkspace: true   # 真的要放开一切时才取消注释
```

## 安装

需要 DSH ≥ 0.2（`dsh` 命令在 PATH 里；没有的话用你 checkout 里的 `node <dsh>/lib/bin.js` 代替）。

```bash
git clone https://github.com/<你>/dsh-workspace-download.git
cd dsh-workspace-download

# 以 link 方式装进某个 profile（profile 名按你的情况改，例如 web）
dsh plugin --profile web add link:"$PWD"
```

再把 `dsh-workspace-download` 加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组；
本仓库的 [install-into-profile.sh](install-into-profile.sh) 会自动完成上面两步，并把旧配置备份到
`.dsh-profile-backup-<时间戳>/`：

```bash
PROFILE=web ./install-into-profile.sh /path/to/dsh-workspace-download
```

验证插件已进组合后的插件树：

```bash
dsh --profile web --dump-config | grep -A2 'dsh-workspace-download'
```

重启 DSH Web 才生效（重启会断开当前网页几秒，刷新后重连即可）：

```bash
dsh web --profile web       # 前台运行
# 或者你的 systemd 用户单元
systemctl --user restart dsh-web
```

浏览器端如果之前装过旧版，插件 bundle 带 `cache-control: immutable`，请 `Ctrl+Shift+R` 硬刷新一次。

## 开发

```bash
cd plugins/dsh-workspace-download
node --test test/handler.test.mjs test/client.test.mjs
```

`test/handler.test.mjs` 用桩 ctx 校验路由注册、Range/HEAD/错误码、ZIP 字节数与 Python `zipfile` 交叉校验；
`test/client.test.mjs` 用假的 `window.__ModuleLoader__` 载入客户端 bundle，校验模块契约与三个插槽的渲染结果。
注意：`node --test test/` 在 Node 22 会把目录当模块解析而报 `MODULE_NOT_FOUND`，要显式列出文件。

## 仓库结构

```
lib/index.js       宿主侧：两条 HTTP 路由（/api/download、/api/download.zip）、Range/HEAD、围栏校验、ZIP 流式打包
lib/client.js      Web 客户端：3 个插槽（预览标题栏 / 不可预览空态 / 文件树头）+ 2 条右键菜单（文件 / 目录）
cordis.patch.yml   DSH bundle patch：把插件挂进 profile 的插件树（含 allowedRoots 配置示例）
test/handler.test.mjs   路由层测试（桩 ctx，Range/HEAD/错误码/ZIP 与 Python zipfile 交叉校验）
test/client.test.mjs    客户端契约测试（假 __ModuleLoader__，插槽渲染与右键菜单行为）
install-into-profile.sh 一键装进 profile（link 安装 + 追加 bundles + 契约自检，旧配置自动备份）
```

## 兼容性

- DSH `0.2.x`（`@deepseek-ai/dsh`），Node `>= 22`（用到 `node:fs/promises` 的 `FileHandle.readableWebStream`）；
- 只依赖宿主的公开插槽与 `ctx.contextMenus`，不 patch 宿主代码；
- 服务端零第三方依赖；客户端只 `require("react")` / `react/jsx-runtime`。

## License

[MIT](LICENSE) © 2026 scmylhywork
