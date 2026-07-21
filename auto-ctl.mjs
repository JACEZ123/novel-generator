// ============================================================================
// 网文小说生成器 · 作者 Jace
// 自动连写控制 / 看门狗。用法：node auto-ctl.mjs <start|status|stop|watch> [bookId]
// bookId 默认取 data/books 下最近修改的一本（从文件系统读取，避免命令行中文乱码）
// © Jace · MIT License
// ============================================================================
import { readdir, stat, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data", "books");
const PORT = process.env.NOVEL_PORT || 4568;
const BASE = `http://localhost:${PORT}`;
const SNAP = join(HERE, "autowatch.json");
const STALL_SEC = 1800;   // 30 分钟无进展视为卡住
const MAX_FAILS = 3;      // 同一章连续失败上限

async function pickBook(arg) {
  if (arg) return arg;
  const dirs = [];
  for (const d of await readdir(DATA)) {
    try { const s = await stat(join(DATA, d)); if (s.isDirectory()) dirs.push({ d, m: s.mtimeMs }); } catch {}
  }
  dirs.sort((a, b) => b.m - a.m);
  return dirs[0]?.d;
}
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const getStatus = (id) => fetch(`${BASE}/api/auto/status?bookId=${encodeURIComponent(id)}`).then(j);
const postStart = (id) => fetch(`${BASE}/api/auto/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: id }) }).then(j);
const postStop = (id) => fetch(`${BASE}/api/auto/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: id }) }).then(j);
async function readSnap() { try { return JSON.parse(await readFile(SNAP, "utf8")); } catch { return {}; } }
async function writeSnap(o) { await writeFile(SNAP, JSON.stringify(o, null, 2), "utf8"); }

// 回滚最后一章（若其状态为 state-degraded / audit-failed），使能干净重写
async function rollbackLastIfBad(id) {
  const chDir = join(DATA, id, "chapters");
  let idx = [];
  try { idx = JSON.parse(await readFile(join(chDir, "index.json"), "utf8")); } catch { return null; }
  if (!idx.length) return null;
  const last = idx[idx.length - 1];
  if (last.status !== "state-degraded" && last.status !== "audit-failed") return null;
  const n = last.number;
  for (const f of await readdir(chDir)) { const m = f.match(/^(\d{4})_.*\.md$/); if (m && Number(m[1]) >= n) await rm(join(chDir, f), { force: true }); }
  await writeFile(join(chDir, "index.json"), JSON.stringify(idx.filter((c) => c.number < n), null, 2), "utf8");
  const sdir = join(DATA, id, "story", "state");
  const patch = async (file, mut) => { try { const p = join(sdir, file); const o = JSON.parse(await readFile(p, "utf8")); mut(o); await writeFile(p, JSON.stringify(o, null, 2), "utf8"); } catch {} };
  await patch("current_state.json", (o) => { if ((o.chapter ?? 0) >= n) o.chapter = n - 1; });
  await patch("manifest.json", (o) => { if ((o.lastAppliedChapter ?? 0) >= n) o.lastAppliedChapter = n - 1; });
  await patch("chapter_summaries.json", (o) => { if (Array.isArray(o.rows)) o.rows = o.rows.filter((r) => r.chapter < n); });
  try { const mdP = join(DATA, id, "story", "current_state.md"); let md = await readFile(mdP, "utf8"); md = md.replace(/(\|\s*当前章节\s*\|\s*)\d+(\s*\|)/, `$1${n - 1}$2`); await writeFile(mdP, md, "utf8"); } catch {}
  return n;
}

const action = process.argv[2] || "status";
const id = await pickBook(process.argv[3]);
if (!id) { console.log("NO_BOOK"); process.exit(0); }

if (action === "start") { console.log(JSON.stringify(await postStart(id))); }
else if (action === "stop") { console.log(JSON.stringify(await postStop(id))); }
else if (action === "status") { console.log(JSON.stringify(await getStatus(id))); }
else if (action === "watch") {
  const s = await getStatus(id);
  const snap = await readSnap();
  const now = new Date().toISOString();
  const changed = s.msg !== snap.msg || s.total !== snap.total;
  const lastChangeAt = changed ? now : (snap.lastChangeAt || now);
  const stalledMs = Date.now() - new Date(lastChangeAt).getTime();
  let out = { total: s.total, msg: s.msg, running: s.running, lastChangeAt, failChapter: snap.failChapter || 0, failCount: snap.failCount || 0 };

  if (s.completed || (s.target && s.total >= s.target)) { await writeSnap(out); console.log(`DONE 全书完成（${s.total}/${s.target} 章）`); process.exit(0); }

  const stalled = s.running && (stalledMs >= STALL_SEC * 1000 || (s.stalledSec ?? 0) >= STALL_SEC);
  const stopped = !s.running;

  if (s.running && !stalled) { await writeSnap(out); console.log(`OK 运行中 第${s.current}章 · ${s.msg}`); process.exit(0); }

  // 异常：停止 或 卡住
  const failN = s.current || (s.total + 1);
  if (out.failChapter === failN) out.failCount += 1; else { out.failChapter = failN; out.failCount = 1; }

  if (out.failCount >= MAX_FAILS) { out.lastChangeAt = now; await writeSnap(out); console.log(`ESCALATE 第${failN}章已连续失败${out.failCount}次（${stalled ? "卡住" : "停止"}），停止自愈，请人工介入。error=${s.error || ""}`); process.exit(0); }

  // 自愈：卡住先停；回滚坏章；重启
  if (stalled) await postStop(id);
  const rolled = await rollbackLastIfBad(id);
  const st = await postStart(id);
  out.lastChangeAt = now; out.msg = "(healed)"; out.total = s.total;
  await writeSnap(out);
  console.log(`HEALED ${stalled ? "卡住" : "停止"}→已自愈：${rolled ? `回滚第${rolled}章并` : ""}重启自动连写（第${failN}章第${out.failCount}次尝试）。start=${JSON.stringify(st)}`);
}
