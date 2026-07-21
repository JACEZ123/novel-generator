// ============================================================================
// 网文小说生成器 · 作者 Jace
// 生成可下载的自动写作辅助脚本（Windows PowerShell / macOS bash）
// 脚本通过本机 HTTP API 控制任务，不依赖项目目录；服务需已在跑
// © Jace · MIT License
// ============================================================================

export const SCRIPT_KINDS = [
  { id: "auto-start", label: "开始自动连写（最近一本，或指定书）", os: ["windows", "mac"] },
  { id: "auto-status", label: "查看自动写作进度", os: ["windows", "mac"] },
  { id: "auto-stop", label: "停止当前自动任务", os: ["windows", "mac"] },
  { id: "keep-awake", label: "防止电脑休眠", os: ["windows", "mac"] },
  { id: "keep-awake-off", label: "恢复休眠设置", os: ["windows"] },
];

export function listScripts(os) {
  const o = os === "mac" ? "mac" : "windows";
  return SCRIPT_KINDS.filter((k) => k.os.includes(o));
}

function filename(os, kind) {
  const ext = os === "mac" ? "sh" : "ps1";
  return `jace-${kind}-${os === "mac" ? "mac" : "win"}.${ext}`;
}

function winPickBook(port, bookId) {
  if (bookId) {
    return `$BookId = @'
${bookId}
'@
$BookId = $BookId.Trim()
`;
  }
  return `$books = Invoke-RestMethod -Uri "$Base/api/books"
if (-not $books.books -or $books.books.Count -eq 0) { Write-Host "没有可写的书"; exit 1 }
$BookId = $books.books[0].id
Write-Host "目标书: $BookId"
`;
}

function macPickBook(port, bookId) {
  if (bookId) {
    return `BOOK_ID=$(printf '%s' ${JSON.stringify(bookId)})\n`;
  }
  return `BOOK_ID=$(python3 - <<'PY'
import json, urllib.request
d = json.load(urllib.request.urlopen("http://localhost:${port}/api/books"))
books = d.get("books") or []
print(books[0]["id"] if books else "")
PY
)
if [ -z "$BOOK_ID" ]; then echo "没有可写的书"; exit 1; fi
echo "目标书: $BOOK_ID"
`;
}

function buildWindows(kind, port, bookId) {
  const header = `# 网文小说生成器 · 作者 Jace · 自动写作辅助脚本（Windows）
# © Jace · MIT License
# 用法：右键「使用 PowerShell 运行」，或：
#   powershell -ExecutionPolicy Bypass -File .\\${filename("windows", kind)}
# 前提：本机服务已启动（npm start），端口 ${port}

$ErrorActionPreference = "Stop"
$Port = ${port}
$Base = "http://localhost:$Port"
`;

  if (kind === "keep-awake") {
    return `${header}
# 需要管理员权限：插电时禁止睡眠/休眠
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$p = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "请用「以管理员身份运行」的 PowerShell 再执行。" -ForegroundColor Yellow
  exit 1
}
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change standby-timeout-dc 20
powercfg /change hibernate-timeout-dc 40
Write-Host "已设置：插电时不自动睡眠/休眠。自动写作请接电源。"
Write-Host "恢复：下载并运行「恢复休眠设置」脚本。"
`;
  }

  if (kind === "keep-awake-off") {
    return `${header}
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$p = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "请用「以管理员身份运行」的 PowerShell 再执行。" -ForegroundColor Yellow
  exit 1
}
powercfg /change standby-timeout-ac 30
powercfg /change hibernate-timeout-ac 60
powercfg /change standby-timeout-dc 15
powercfg /change hibernate-timeout-dc 30
Write-Host "已恢复较常见的默认超时（可再在系统设置里调整）。"
`;
  }

  const pick = winPickBook(port, bookId);
  if (kind === "auto-start") {
    return `${header}
${pick}
$body = @{ bookId = $BookId } | ConvertTo-Json
$r = Invoke-RestMethod -Method POST -Uri "$Base/api/auto/start" -ContentType "application/json; charset=utf-8" -Body $body
$r | ConvertTo-Json -Depth 6
Write-Host "已请求开始自动连写。可关掉浏览器，任务在本机服务进程中继续。"
`;
  }
  if (kind === "auto-stop") {
    return `${header}
${pick}
$body = @{ bookId = $BookId } | ConvertTo-Json
$r = Invoke-RestMethod -Method POST -Uri "$Base/api/auto/stop" -ContentType "application/json; charset=utf-8" -Body $body
$r | ConvertTo-Json -Depth 6
Write-Host "已请求停止自动任务。"
`;
  }
  if (kind === "auto-status") {
    return `${header}
${pick}
$enc = [uri]::EscapeDataString($BookId)
$r = Invoke-RestMethod -Uri "$Base/api/auto/status?bookId=$enc"
$r | ConvertTo-Json -Depth 6
`;
  }
  throw new Error(`unknown kind: ${kind}`);
}

function buildMac(kind, port, bookId) {
  const header = `#!/usr/bin/env bash
# 网文小说生成器 · 作者 Jace · 自动写作辅助脚本（macOS）
# © Jace · MIT License
# 用法：chmod +x ${filename("mac", kind)} && ./${filename("mac", kind)}
#   或：bash ${filename("mac", kind)}
# 前提：本机服务已启动（npm start），端口 ${port}

set -euo pipefail
PORT=${port}
BASE="http://localhost:$PORT"
`;

  if (kind === "keep-awake") {
    return `${header}
echo "caffeinate 运行中：系统不会因空闲睡眠。Ctrl+C 结束并恢复。"
echo "请另开终端保持 npm start 与自动连写任务。"
exec caffeinate -dims
`;
  }
  if (kind === "keep-awake-off") {
    throw new Error("mac keep-awake-off: Ctrl+C 结束 caffeinate 即可");
  }

  const pick = macPickBook(port, bookId);
  if (kind === "auto-start") {
    return `${header}
${pick}
export BOOK_ID
BODY=$(python3 -c 'import json,os; print(json.dumps({"bookId": os.environ["BOOK_ID"]}))')
curl -sS -X POST "$BASE/api/auto/start" -H "Content-Type: application/json" -d "$BODY"
echo
echo "已请求开始自动连写。可关掉浏览器，任务在本机服务进程中继续。"
`;
  }
  if (kind === "auto-stop") {
    return `${header}
${pick}
export BOOK_ID
BODY=$(python3 -c 'import json,os; print(json.dumps({"bookId": os.environ["BOOK_ID"]}))')
curl -sS -X POST "$BASE/api/auto/stop" -H "Content-Type: application/json" -d "$BODY"
echo
echo "已请求停止自动任务。"
`;
  }
  if (kind === "auto-status") {
    return `${header}
${pick}
export BOOK_ID
ENC=$(python3 -c 'import os,urllib.parse; print(urllib.parse.quote(os.environ["BOOK_ID"], safe=""))')
curl -sS "$BASE/api/auto/status?bookId=$ENC"
echo
`;
  }
  throw new Error(`unknown kind: ${kind}`);
}

/** @returns {{ filename: string, mime: string, content: string }} */
export function buildScript({ os, kind, port, bookId = "" }) {
  const o = os === "mac" ? "mac" : "windows";
  const k = String(kind || "");
  const meta = SCRIPT_KINDS.find((x) => x.id === k);
  if (!meta || !meta.os.includes(o)) throw new Error(`不支持的脚本: ${o}/${k}`);
  const p = Number(port) || 4568;
  const bid = String(bookId || "").trim();
  const content = o === "mac" ? buildMac(k, p, bid) : buildWindows(k, p, bid);
  const name = filename(o, k);
  const mime = o === "mac" ? "text/x-shellscript; charset=utf-8" : "text/plain; charset=utf-8";
  return { filename: name, mime, content };
}
