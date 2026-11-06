#!/usr/bin/env bash
# 把 dsh-workspace-download 以 link 方式装进一个 DSH profile（可回滚：旧配置备份在 ~/.dsh/backups/）
#
# 用法:
#   ./install-into-profile.sh [插件目录]
#   PROFILE=web ./install-into-profile.sh /path/to/dsh-workspace-download
#
# 环境变量:
#   PROFILE   目标 profile 名（默认 web，对应 ~/.dsh/profiles/web）
#   DSH_BIN   dsh 可执行文件或 lib/bin.js 的路径（默认从 PATH 找 dsh）
set -euo pipefail

PLUGIN="${1:-$(cd "$(dirname "$0")" && pwd)}"
PROFILE_NAME="${PROFILE:-web}"
PROFILE="$HOME/.dsh/profiles/$PROFILE_NAME"
TS=$(date +%Y%m%d-%H%M%S)
BK="$HOME/.dsh/backups/profile-$PROFILE_NAME-$TS"

[ -f "$PLUGIN/package.json" ] || { echo "!! $PLUGIN 不是插件目录（缺 package.json）" >&2; exit 1; }
[ -d "$PROFILE" ] || { echo "!! profile 不存在: $PROFILE" >&2; exit 1; }

DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
[ -n "$DSH_BIN" ] || { echo "!! 找不到 dsh，请把 dsh 放进 PATH，或用 DSH_BIN=/path/to/dsh 指定" >&2; exit 1; }
case "$DSH_BIN" in
  *.js) DSH=(node "$DSH_BIN") ;;
  *)    DSH=("$DSH_BIN") ;;
esac

echo "== 1) 备份 profile 配置 → $BK"
mkdir -p "$BK"
for f in package.json cordis.patch.yml cordis.yml pnpm-lock.yaml pnpm-workspace.yaml; do
  [ -f "$PROFILE/$f" ] && cp -p "$PROFILE/$f" "$BK/$f"
done
ls -1 "$BK"

echo "== 2) 安装依赖（link:$PLUGIN）"
cd "$PROFILE"
"${DSH[@]}" plugin --profile "$PROFILE_NAME" add "link:$PLUGIN" 2>&1 | tail -25

echo "== 3) 把 dsh-workspace-download 追加进 dsh.profile.bundles"
node - "$PROFILE/package.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
const bundles = (pkg.dsh.profile.bundles ??= []);
const name = 'dsh-workspace-download';
if (!bundles.includes(name)) bundles.push(name);
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('bundles(' + bundles.length + '):', bundles.join(', '));
NODE

echo "== 4) 依赖是否落到 profile 的 node_modules"
ls -ld "$PROFILE/node_modules/dsh-workspace-download"
node -e "import('dsh-workspace-download').then(m => console.log('host exports:', Object.keys(m)))" --input-type=module

echo "== 5) 组合后的 profile 树里是否有我的 row"
# 注意：--dump-config 可能会在 profile 目录里写一份临时 cordis.yml，需要对该目录有写权限。
"${DSH[@]}" --profile "$PROFILE_NAME" --dump-config 2>&1 | grep -n -A2 'workspace-download' \
  || echo "!! 未在 dump-config 中找到 workspace-download"

echo "== 6) 客户端 bundle 契约自检"
node - "$PROFILE/node_modules/dsh-workspace-download" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const client = pkg.dsh?.client;
const entry = pkg.exports?.['./client'];
const rel = typeof entry === 'string' ? entry : entry?.default;
if (!client || typeof client.platform !== 'string') throw new Error('dsh.client.platform 缺失');
if (!rel) throw new Error('exports["./client"] 缺失');
const src = fs.readFileSync(path.join(dir, rel), 'utf8');
if (!src.includes('__ModuleLoader__')) throw new Error('client bundle 未使用 __ModuleLoader__');
if (/require\(['"](?!react|react\/jsx-runtime)[^'"]+['"]\)/.test(src)) throw new Error('client bundle 引用了 react 之外的模块');
console.log('OK: platform=' + client.platform + ' entry=' + rel + ' bytes=' + src.length);
NODE

echo "== 完成。重启 DSH Web 后生效：systemctl --user restart dsh-web（或前台 dsh web 重开）"
