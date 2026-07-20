// jace 开源小说生成器 前端状态机
const S = {
  kind: "longform", bookId: null, foundation: null,
  chapter: 1, preAudit: null, postAudit: null,
  confirmStage: "draft", selectedTab: null, ac: null,
  book: null, total: 0, chaptersData: [], outlines: [], chapterTitle: null,
};
const $ = (id) => document.getElementById(id);
const openModal = (id) => $(id).classList.add("on");
const closeModal = (id) => $(id).classList.remove("on");
const esc = (s) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 进度反馈：当前行醒目 + 上一行淡出，让等待过程可见
function showProgress(elId, msg) {
  const el = $(elId); if (!el) return;
  el.classList.remove("hidden");
  const prevCur = el.querySelector(".cur")?.textContent;
  el.innerHTML = `<span class="cur">${esc(msg)}</span>` + (prevCur ? `<span class="past">上一步：${esc(prevCur)}</span>` : "");
}
function hideProgress(elId) { const el = $(elId); if (el) { el.classList.add("hidden"); el.innerHTML = ""; } }

// ---------- 通用 Markdown 渲染（##、-、|表格|、**粗体**、`code`、有序表）----------
function mdInline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>");
}
function mdToHtml(md) {
  const lines = (md || "").replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(mdInline).join("<br>")}</p>`); para = []; } };
  while (i < lines.length) {
    const ln = lines[i];
    const t = ln.trim();
    // 表格：连续含 | 的行，且下一行是分隔行 |---|
    if (/^\|.*\|/.test(t) && i + 1 < lines.length && /^\|?[\s:|-]+\|/.test(lines[i + 1].trim()) && lines[i + 1].includes("-")) {
      flushPara();
      const rows = [];
      const header = t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      i += 2; // 跳过表头 + 分隔行
      while (i < lines.length && /^\|.*\|/.test(lines[i].trim())) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        i++;
      }
      out.push(`<table class="md"><thead><tr>${header.map((c) => `<th>${mdInline(c)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    // 标题
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); const lv = Math.min(h[1].length + 2, 6); out.push(`<h${lv} class="md">${mdInline(h[2])}</h${lv}>`); i++; continue; }
    // 无序列表
    if (/^[-*+]\s+/.test(t)) {
      flushPara(); const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*+]\s+/, "")); i++; }
      out.push(`<ul class="md">${items.map((x) => `<li>${mdInline(x)}</li>`).join("")}</ul>`); continue;
    }
    // 有序列表
    if (/^\d+[.)]\s+/.test(t)) {
      flushPara(); const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^\d+[.)]\s+/, "")); i++; }
      out.push(`<ol class="md">${items.map((x) => `<li>${mdInline(x)}</li>`).join("")}</ol>`); continue;
    }
    // 引用
    if (/^>\s?/.test(t)) { flushPara(); out.push(`<blockquote class="md">${mdInline(t.replace(/^>\s?/, ""))}</blockquote>`); i++; continue; }
    // 空行 = 段落分隔
    if (t === "") { flushPara(); i++; continue; }
    para.push(t); i++;
  }
  flushPara();
  return out.join("");
}

// ---------- 左侧项目栏：列书 / 恢复 / 回首页 ----------
async function loadBooks() {
  try {
    const d = await (await fetch("/api/books")).json();
    const list = $("book-list");
    list.innerHTML = (d.books || []).map((b) => `
      <div class="book-item ${b.id === S.bookId ? "active" : ""}" onclick="resumeBook('${encodeURIComponent(b.id)}')">
        <div class="bk-kind">📖 长篇小说</div>
        <div class="bk-title">${esc(b.title)}</div>
        <div class="bk-meta">${b.hasFoundation ? `已写 ${b.total} 章` : "设定未完成"}</div>
      </div>`).join("") || `<p style="color:var(--muted);font-size:12px;padding:4px">还没有作品，点上方新建。</p>`;
  } catch { /* ignore */ }
}
function goHome() {
  $("workspace").classList.add("hidden");
  $("home").classList.remove("hidden");
  homeTab("start");
  checkReady();
  loadBooks();
}

// ---------- 首页 tab：开始创作 / 流程说明 ----------
function homeTab(which) {
  const start = which !== "flow";
  $("home-start").classList.toggle("hidden", !start);
  $("home-flow").classList.toggle("hidden", start);
  $("ht-start").classList.toggle("sel", start);
  $("ht-flow").classList.toggle("sel", !start);
}

// ---------- 就绪检查：未配置密钥则提示去「设置」 ----------
async function checkReady() {
  try {
    const d = await (await fetch("/api/ready")).json();
    const banner = $("home-need-key");
    if (banner) banner.classList.toggle("hidden", !!d.ready);
    return !!d.ready;
  } catch { return true; }
}

// ---------- 设置：API Key / Base URL / 可用模型 ----------
async function openSettingsConfig() {
  try {
    const c = await (await fetch("/api/config")).json();
    $("cfg-baseurl").value = c.baseUrl || "";
    $("cfg-fast").value = c.fastModel || "";
    $("cfg-strong").value = c.strongModel || "";
    $("cfg-temp").value = c.temperature ?? 0.7;
    $("cfg-models").value = (c.models || []).map((m) => (m.label && m.label !== m.id ? `${m.id}|${m.label}` : m.id)).join("\n");
    $("cfg-key").value = "";
    const st = $("cfg-key-state");
    if (c.keyFromEnv) st.textContent = "（当前来自环境变量，已生效）";
    else if (c.hasKey) st.textContent = `（已保存：${c.keyHint}，留空则不改）`;
    else st.textContent = "（未配置）";
    $("cfg-hint").textContent = "";
  } catch { /* ignore */ }
  openModal("m-config");
}
async function saveConfig() {
  const models = $("cfg-models").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [id, ...rest] = l.split("|");
    return { id: id.trim(), label: (rest.join("|").trim() || id.trim()) };
  });
  const payload = {
    apiKey: $("cfg-key").value.trim(),          // 空则后端保留原值
    baseUrl: $("cfg-baseurl").value.trim(),
    models,
    fastModel: $("cfg-fast").value.trim(),
    strongModel: $("cfg-strong").value.trim(),
    temperature: Number($("cfg-temp").value) || 0.7,
  };
  try {
    const d = await (await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).json();
    if (d.ok) {
      $("cfg-hint").style.color = "var(--acc-d)";
      $("cfg-hint").textContent = d.hasKey ? "✅ 已保存，密钥就绪" : "⚠ 已保存，但仍未检测到密钥";
      checkReady();
      setTimeout(() => closeModal("m-config"), 700);
    } else {
      $("cfg-hint").textContent = "保存失败";
    }
  } catch (e) { $("cfg-hint").textContent = "保存失败：" + e; }
}
async function resumeBook(idEnc) {
  const bookId = decodeURIComponent(idEnc);
  try {
    const d = await (await fetch(`/api/resume?bookId=${encodeURIComponent(bookId)}`)).json();
    if (d.error) throw new Error(d.error);
    S.bookId = bookId; S.foundation = d.foundation; S.outlines = d.outlines || [];
    S.book = d.book; S.total = d.total || 0; S.chaptersData = d.chapters || [];
    S.preAudit = null; S.postAudit = null; S.ac = null;
    await loadPanel();
    $("home").classList.add("hidden");
    $("workspace").classList.remove("hidden");
    renderCards();
    // 若该书后台自动连写仍在运行 → 直接进入自动界面并接续轮询
    let auto = null;
    try { auto = await (await fetch(`/api/auto/status?bookId=${encodeURIComponent(bookId)}`)).json(); } catch { /* */ }
    if (auto && auto.running) { enterAutoUI(); pollAuto(); }
    else showProject();
    loadBooks();
  } catch (e) { alert("恢复失败：" + e.message); }
}

// ========== 视图切换 ==========
function showProject() {
  $("view-chapter").classList.add("hidden");
  $("view-project").classList.remove("hidden");
  renderCards();
  renderProject();
}
function showChapterView() {
  $("view-project").classList.add("hidden");
  $("view-chapter").classList.remove("hidden");
}

// 章节状态判定
const isAudited = (st) => st === "ready-for-review";
function statusLabel(st) { return isAudited(st) ? { cls: "ok", txt: "已审计" } : { cls: "draft", txt: "草稿·待审计" }; }

// ========== 项目总览 ==========
function renderProject() {
  $("pj-title").textContent = S.book?.title || S.bookId;
  const chs = S.chaptersData || [];
  const target = S.book?.targetChapters || 0;
  const last = chs[chs.length - 1];
  let taskHtml, actions = "";
  const nextN = chs.length + 1;
  const lastN = chs.length ? Math.max(...chs.map((c) => c.n)) : 0;
  // 自动连写运行中：显示横幅 + 停止按钮，章节列表照常展示（刷新即见最新已写章）
  if (S.autoRunning) {
    $("pj-title").textContent = S.book?.title || S.bookId;
    $("pj-task").innerHTML = `🚀 <b>自动连写中</b>（后台运行，可随时关页面/刷新）：${esc(S.autoMsg || "运行中…")}`;
    $("pj-actions").innerHTML = `<div class="tab" onclick="stopAuto()">⏹ 停止自动连写</div>`;
    $("pj-chapters").innerHTML = chs.length
      ? chs.map((c) => {
          const s = statusLabel(c.status);
          const preview = firstLines(stripStructure(c.content), 3);
          return `<div class="chap-row" onclick="openChapter(${c.n})"><div class="cr-head"><span class="cr-title">第 ${c.n} 章 ${esc(cleanTitle(c.title))}</span><span class="cr-status ${s.cls}">${s.txt}</span></div><div class="cr-preview">${esc(preview)}</div></div>`;
        }).join("")
      : `<p style="color:var(--muted)">正在生成第 1 章…</p>`;
    return;
  }
  // 组末（写完每组第4章：4/9/14…）需先审阅下一组大纲，通过后再写下一章
  const nextGroupStart = Math.floor(lastN / 5) * 5 + 6; // 4→6, 9→11…
  const grp = (S.outlines || []).filter((o) => o.n >= nextGroupStart && o.n < nextGroupStart + 5);
  const needOutlineStep = lastN > 0 && lastN % 5 === 4 && (grp.length === 0 || grp.some((o) => !o.confirmed));
  if (last && !isAudited(last.status)) {
    taskHtml = `当前任务：<b>第 ${last.n} 章</b> · 草稿已生成，<b>待审计</b>`;
    actions = `<div class="tab sel" onclick="openChapter(${last.n})">📋 审阅 / 审计第 ${last.n} 章</div>`;
  } else if (needOutlineStep) {
    taskHtml = `当前任务：<b>第 ${nextGroupStart}-${nextGroupStart + 4} 章大纲</b> · ${grp.length ? "待审阅/审计" : "待生成"}（先过大纲，再写第 ${nextN} 章）`;
    actions = `<div class="tab sel" onclick="startMidbookOutline(${nextGroupStart})">📋 ${grp.length ? "审阅" : "生成"}第 ${nextGroupStart}-${nextGroupStart + 4} 章大纲</div>`
      + `<div class="tab" onclick="writeChapter(${nextN})">跳过，直接写第 ${nextN} 章</div>`;
  } else {
    taskHtml = chs.length
      ? `当前任务：<b>第 ${nextN} 章</b> · 正文编写，<b>未开始</b>${target ? `（全书 ${target} 章）` : ""}`
      : "当前任务：<b>第 1 章</b> · 正文编写，未开始";
    actions = `<div class="tab sel" onclick="writeChapter(${nextN})">✍ 生成第 ${nextN} 章</div>`;
  }
  actions += `<div class="tab" onclick="autoComplete()">🚀 自动完成（写到完本，不再人工确认）</div>`;
  $("pj-task").innerHTML = taskHtml;
  $("pj-actions").innerHTML = actions;
  $("pj-chapters").innerHTML = chs.length
    ? chs.map((c) => {
        const s = statusLabel(c.status);
        const preview = firstLines(stripStructure(c.content), 3);
        return `<div class="chap-row" onclick="openChapter(${c.n})">
          <div class="cr-head"><span class="cr-title">第 ${c.n} 章 ${esc(cleanTitle(c.title))}</span><span class="cr-status ${s.cls}">${s.txt}</span><span class="cr-del" onclick="event.stopPropagation();deleteChapter(${c.n})">🗑 删除本章</span></div>
          <div class="cr-preview">${esc(preview)}</div></div>`;
      }).join("")
    : `<p style="color:var(--muted)">还没有正文，点上方"生成第 1 章"开始。</p>`;
}
// 删除第 n 章（及其之后章节），二次确认后回滚到上一节点
async function deleteChapter(n) {
  const chs = S.chaptersData || [];
  const after = chs.filter((c) => c.n > n).length;
  const msg1 = after > 0
    ? `删除第 ${n} 章会同时删除其后的第 ${n + 1}-${chs[chs.length - 1].n} 章（共 ${after + 1} 章），无法恢复。确定？`
    : `确定删除第 ${n} 章？`;
  if (!confirm(msg1)) return;
  if (!confirm(`二次确认：真的删除第 ${n} 章${after > 0 ? " 及其后章节" : ""}吗？此操作不可撤销。`)) return;
  try {
    const d = await (await fetch("/api/chapter/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, n }) })).json();
    if (d.error) throw new Error(d.error);
    // 本地同步：移除 >= n 的章节，当前任务回到"上一节点的下一步"
    S.chaptersData = chs.filter((c) => c.n < n);
    S.total = S.chaptersData.length;
    loadBooks();
    showProject();
  } catch (e) { alert("删除失败：" + e.message); }
}
// 取正文前 n 行（非空）
function firstLines(text, n) {
  return (text || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, n).join(" ");
}

// ========== 单章详情 ==========
function openChapter(n) {
  const c = (S.chaptersData || []).find((x) => x.n === n);
  S.chapter = n;
  S.chapterTitle = c ? cleanTitle(c.title) : null;
  S.preAudit = c?.content || null; S.postAudit = null;
  showChapterView();
  renderChapterSidebar(n);
  $("audit-box")?.remove();
  $("btn-pause").classList.add("hidden");
  $("stage").textContent = "";
  if (c) {
    $("cd-title").textContent = `第 ${n} 章 ${cleanTitle(c.title)}`;
    $("ch-body").innerHTML = renderBody(c.content);
    renderChapterActions(c.status);
  } else {
    $("cd-title").textContent = `第 ${n} 章 · 未生成`;
    $("ch-body").textContent = "";
    $("cd-actions").innerHTML = `<div class="tab sel" onclick="writeChapter(${n})">✍ 生成本章</div>`;
  }
}
// 单章操作按钮：已审计→编辑/重写/修改/重新审计；草稿→审计/修订/重写
function renderChapterActions(status) {
  if (isAudited(status)) {
    $("cd-actions").innerHTML = `
      <div class="tab" onclick="editChapterText()">✏ 编辑正文</div>
      <div class="tab" onclick="reReviseChapter()">🔧 修改（给意见）</div>
      <div class="tab" onclick="reRewriteChapter()">♻ 重写本章</div>
      <div class="tab" onclick="reAuditChapter()">🔎 重新审计</div>`;
  } else {
    $("cd-actions").innerHTML = `
      <div class="tab sel" onclick="reAuditChapter()">🔎 审计本章（自动修订到通过）</div>
      <div class="tab" onclick="reReviseChapter()">🔧 修订（给意见）</div>
      <div class="tab" onclick="reRewriteChapter()">♻ 重写本章</div>`;
  }
}
// 单章详情右侧：章纲（聚焦本章的近若干章）+ 该章所属卷纲。不展示世界观/角色/伏笔。
function renderChapterSidebar(n) {
  const GROUP = 5; // 每组 5 章
  const outlines = S.outlines || [];
  // 本章所在的 5 章分组：如第15章 → 11-15；第4章 → 1-5
  const groupEnd = Math.ceil(n / GROUP) * GROUP;
  const groupStart = groupEnd - GROUP + 1;
  const inGroup = outlines.filter((o) => o.n >= groupStart && o.n <= groupEnd);
  const before = outlines.filter((o) => o.n < groupStart);
  const olItem = (o, open) => `<details ${open ? "open" : ""}><summary>第${o.n}章 ${esc(o.title)}${o.n === n ? " ◀ 本章" : ""}</summary><p class="ol-sum" style="margin:4px 0">${esc(o.summary)}</p><div class="mdbox" style="max-height:200px">${mdToHtml(o.detail)}</div></details>`;
  const groupHtml = inGroup.length
    ? inGroup.map((o) => olItem(o, o.n === n)).join("")
    : `<p style="color:var(--muted);font-size:12.5px">本组（第 ${groupStart}-${groupEnd} 章）尚无章纲。</p>`;
  const beforeHtml = before.length
    ? `<details class="vol-drawer"><summary>展开前 ${before.length} 章章纲（第 1-${groupStart - 1} 章）</summary>${before.map((o) => olItem(o, false)).join("")}</details>`
    : "";
  // 所属卷纲
  const vols = splitVolumes(S.foundation?.volume_map || "");
  let volCard = "";
  if (vols.length) {
    const per = Math.max(1, Math.ceil((S.book?.targetChapters || 100) / vols.length));
    const cur = Math.min(vols.length - 1, Math.floor((n - 1) / per));
    const others = vols.map((_, i) => i).filter((i) => i !== cur);
    const otherHtml = others.length ? `<details class="vol-drawer"><summary>展开其余 ${others.length} 卷卷纲</summary>${others.map((i) => `<details><summary>${esc(vols[i].title)}</summary><div class="mdbox">${mdToHtml(vols[i].body)}</div></details>`).join("")}</details>` : "";
    volCard = `<div class="cardbox"><h4>🗺 本章所属卷（第 ${cur + 1} 卷）</h4><details open><summary>${esc(vols[cur].title)}</summary><div class="mdbox">${mdToHtml(vols[cur].body)}</div></details>${otherHtml}</div>`;
  }
  $("cards").innerHTML = `
    ${panelCardHtml(true)}
    <div class="cardbox"><h4>📋 章纲（第 ${groupStart}-${groupEnd} 章，聚焦第 ${n} 章）</h4>${beforeHtml}${groupHtml}</div>
    ${volCard}`;
}

// 生成某章（新章或未生成章）
function writeChapter(n) {
  S.chapter = n;
  showChapterView();
  $("cd-title").textContent = `第 ${n} 章 · 生成中`;
  $("cd-actions").innerHTML = "";
  renderChapterSidebar(n);
  streamWrite({});
}
// 重新审计（自动修订到通过）当前章
function reAuditChapter() { showChapterView(); runAudit(); }
// 修订/重写当前章（带意见）
function reReviseChapter() {
  const t = prompt("请输入修订意见（在原稿基础上按意见修改）：");
  if (!t) return;
  streamWrite({ rewrite: true, note: `在原稿基础上按意见修改：${t}`, context: `在原稿基础上按意见修改。\n【上一版正文】\n${S.preAudit}\n【意见】\n${t}` });
}
function reRewriteChapter() {
  const t = prompt("请输入重写意见（按意见整章重写）：");
  if (!t) return;
  streamWrite({ rewrite: true, note: `按意见重写本章：${t}`, context: `按意见重写本章。\n【上一版正文】\n${S.preAudit}\n【意见】\n${t}` });
}
// 就地编辑正文
function editChapterText() {
  const c = (S.chaptersData || []).find((x) => x.n === S.chapter);
  const cur = c?.content || "";
  $("ch-body").innerHTML = `<textarea id="edit-body" style="width:100%;min-height:50vh;font-family:var(--serif);font-size:15px;line-height:1.9">${esc(stripStructure(cur))}</textarea>`;
  $("cd-actions").innerHTML = `<div class="tab sel" onclick="saveChapterText()">💾 保存正文</div><div class="tab" onclick="openChapter(${S.chapter})">取消</div>`;
}
async function saveChapterText() {
  const content = $("edit-body").value;
  await fetch("/api/chapter/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, n: S.chapter, content }) });
  const c = (S.chaptersData || []).find((x) => x.n === S.chapter); if (c) c.content = content;
  openChapter(S.chapter);
}

// ---------- 模型配置 ----------
async function openModelConfig() {
  const r = await fetch("/api/model-config");
  const d = await r.json();
  $("model-rows").innerHTML = d.stages.map((s) => {
    const opts = d.models.map((m) => `<option value="${m.id}" ${d.config[s.key] === m.id ? "selected" : ""}>${m.label}</option>`).join("");
    return `<label style="display:flex;align-items:center;gap:12px;margin:8px 0">
      <span style="flex:0 0 130px;color:var(--ink)">${s.label}</span>
      <select data-stage="${s.key}" style="flex:1">${opts}</select></label>`;
  }).join("");
  openModal("m-model");
}
async function saveModelConfig() {
  const config = {};
  $("model-rows").querySelectorAll("select").forEach((sel) => { config[sel.dataset.stage] = sel.value; });
  const r = await fetch("/api/model-config", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }),
  });
  if ((await r.json()).ok) { closeModal("m-model"); }
  else alert("保存失败");
}

// ---------- 首页 → 初始设定 ----------
function openSettings(kind) {
  S.kind = kind;
  $("settings-title").textContent = (kind === "longform" ? "长篇小说" : "剧本创作") + " · 初始设定";
  openModal("m-settings");
}

// ---------- 生成大纲/世界观 ----------
function genFoundation() {
  const title = $("f-title").value.trim();
  if (!title) { alert("请输入书名"); return; }
  $("btn-gen").disabled = true; $("btn-gen").textContent = "生成中…";
  showProgress("gen-progress", "🚀 提交设定，正在启动生成…");
  streamPost("/api/foundation", {
    kind: S.kind, title, genre: $("f-genre").value,
    targetChapters: +$("f-target").value, chapterWordCount: +$("f-words").value,
    settings: $("f-settings").value,
  }, {
    onStage: (s) => showProgress("gen-progress", s.msg),
    onEvent: (ev, d) => {
      if (ev === "done") {
        S.bookId = d.bookId; S.foundation = d.foundation;
        hideProgress("gen-progress");
        $("btn-gen").disabled = false; $("btn-gen").textContent = "生成大纲与世界观";
        closeModal("m-settings");
        renderFoundation();
        openModal("m-foundation");
        loadBooks();
      } else if (ev === "error") {
        showError2("gen-progress", d);
        $("btn-gen").disabled = false; $("btn-gen").textContent = "重新生成大纲与世界观";
      }
    },
  });
}
function showError2(elId, d) {
  const code = d?.code ? `[${d.code}] ` : "";
  const el = $(elId); if (el) { el.classList.remove("hidden"); el.innerHTML = `<span style="color:#c0392b">出错 ${code}${esc(d?.message || "连接中断")}</span>`; }
}

function renderFoundation() {
  const f = S.foundation;
  const rolesText = (f.roles || []).map((r) => `【${r.tier}】${r.name}\n${r.content}`).join("\n\n———\n\n");
  const secs = [
    ["故事框架 / 世界观", f.story_frame],
    ["卷纲 / OKR", f.volume_map],
    ["角色设定", rolesText],
    ["设定规则", f.book_rules],
    ["初始伏笔", f.pending_hooks],
  ];
  $("foundation-view").innerHTML = secs.map(([t, c]) =>
    `<section><h4>${t}</h4><div class="mdbox">${c ? mdToHtml(c) : "（空）"}</div></section>`).join("");
}

// 右侧常驻卡片：卷纲 / 世界观 / 角色 / 伏笔 / 规则 / 文风（可编辑）
function renderCards() {
  const f = S.foundation; if (!f) return;
  const roles = (f.roles || []).map((r, i) =>
    `<details data-role="${i}"><summary>${esc(r.name)}<span class="rtier">${r.tier === "主要角色" ? "主" : "次"}</span><span class="card-edit" onclick="event.stopPropagation();editRole(${i})">✏ 编辑</span></summary><div class="mdbox">${mdToHtml(r.content)}</div></details>`).join("");
  const rolesHtml = roles || `<p style="color:var(--muted);font-size:12.5px;margin:4px 0">初始化时未生成角色卡；<a href="javascript:refreshCards()">点此刷新</a>。</p>`;
  const vols = splitVolumes(f.volume_map);
  const volHtml = vols.length
    ? vols.map((v, i) => `<details ${i === 0 ? "open" : ""}><summary>${esc(v.title)}</summary><div class="mdbox">${mdToHtml(v.body)}</div></details>`).join("")
    : `<div class="mdbox">${f.volume_map ? mdToHtml(f.volume_map) : "（空）"}</div>`;
  const editable = (sec, title, icon, content) =>
    `<div class="cardbox" data-sec="${sec}"><h4>${icon} ${title}<span class="card-edit" onclick="editSection('${sec}')">✏ 编辑</span></h4><div class="mdbox sec-view">${content ? mdToHtml(content) : "（空）"}</div></div>`;
  $("cards").innerHTML = `
    ${panelCardHtml()}
    <div class="cardbox"><h4>🗺 卷纲 / 各卷大纲（${vols.length || "—"} 卷）<span class="card-edit" onclick="editSection('volume_map')">✏ 编辑</span></h4>${volHtml}</div>
    ${editable("story_frame", "世界观 / 故事框架", "🌏", f.story_frame)}
    <div class="cardbox"><h4>👤 角色</h4>${rolesHtml}</div>
    ${editable("pending_hooks", "伏笔", "🎣", f.pending_hooks)}
    ${editable("book_rules", "设定规则", "📐", f.book_rules)}
    ${editable("style_guide", "文风", "🎨", f.style_guide)}`;
}
// 编辑某个设定分节
function editSection(sec) {
  const f = S.foundation || {};
  const cur = f[sec] || "";
  const box = document.querySelector(`#cards .cardbox[data-sec="${sec}"]`) || document.querySelector("#cards .cardbox");
  const view = box.querySelector(".sec-view") || box;
  const holder = document.createElement("div");
  holder.className = "card-edit-wrap";
  holder.innerHTML = `<textarea>${esc(cur)}</textarea><div class="toolbar"><button class="primary" onclick="saveSection('${sec}', this)">保存</button><button onclick="renderCards()">取消</button></div>`;
  view.replaceWith(holder);
}
async function saveSection(sec, btn) {
  const content = btn.closest(".card-edit-wrap").querySelector("textarea").value;
  await fetch("/api/foundation/save-section", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, section: sec, content }) });
  S.foundation[sec] = content;
  renderCards();
}
// 编辑角色卡
function editRole(i) {
  const r = S.foundation.roles[i];
  const det = document.querySelector(`#cards details[data-role="${i}"]`);
  const view = det.querySelector(".mdbox");
  const holder = document.createElement("div");
  holder.className = "card-edit-wrap";
  holder.innerHTML = `<textarea>${esc(r.content)}</textarea><div class="toolbar"><button class="primary" onclick="saveRole(${i}, this)">保存</button><button onclick="renderCards()">取消</button></div>`;
  view.replaceWith(holder);
}
async function saveRole(i, btn) {
  const r = S.foundation.roles[i];
  const content = btn.closest(".card-edit-wrap").querySelector("textarea").value;
  await fetch("/api/role/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, tier: r.tier, name: r.name, content }) });
  r.content = content;
  renderCards();
}
async function refreshCards() {
  if (!S.bookId) return;
  try {
    const r = await fetch(`/api/foundation?bookId=${encodeURIComponent(S.bookId)}`);
    const d = await r.json();
    if (d.foundation) { S.foundation = d.foundation; renderCards(); }
  } catch { /* ignore */ }
}
// 从 volume_map 里按"第N卷/卷N"或 ## 标题切分出各卷
function splitVolumes(md) {
  if (!md) return [];
  const lines = md.split("\n");
  const vols = []; let cur = null;
  for (const ln of lines) {
    const t = ln.trim();
    const isVol = /第[一二三四五六七八九十\d]+卷/.test(t) || (/^#{1,4}\s/.test(t) && /卷/.test(t));
    if (isVol) { if (cur) vols.push(cur); cur = { title: t.replace(/^[#*\s-]+/, "").slice(0, 40), body: "" }; }
    else if (cur) cur.body += ln + "\n";
  }
  if (cur) vols.push(cur);
  return vols.filter((v) => v.body.trim());
}

// ===== 网游人物属性面板 =====
async function loadPanel() {
  S.panel = null; S.panelEnabled = false;
  if (!S.bookId) return;
  try {
    const d = await (await fetch(`/api/panel?bookId=${encodeURIComponent(S.bookId)}`)).json();
    S.panelEnabled = !!d.enabled; S.panel = d.panel || null;
  } catch { /* ignore */ }
}
function panelCardHtml(inChapter) {
  if (!S.panelEnabled || !S.panel) return "";
  const p = S.panel;
  const attrs = Object.entries(p.attributes || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join("");
  const eq = (p.equipment || []).length ? (p.equipment).map((e) => `<li><b>${esc(e.name)}</b>${e.effect ? "：" + esc(e.effect) : ""}</li>`).join("") : "<li style='color:var(--muted)'>（无）</li>";
  const sk = (p.skills || []).length ? (p.skills).map((e) => `<li><b>${esc(e.name)}</b>${e.effect ? "：" + esc(e.effect) : ""}</li>`).join("") : "<li style='color:var(--muted)'>（无）</li>";
  // 单章详情里额外提供"依据正文手动更新"按钮
  const manualBtn = inChapter ? `<button style="width:100%;margin-top:8px;font-size:12px" onclick="manualUpdatePanel()">🔄 依据本章正文手动更新人物面板</button>` : "";
  return `<div class="cardbox panel-card">
    <h4>🎮 人物面板<span class="card-edit" onclick="editPanel()">✏ 编辑</span></h4>
    <div class="pl-row"><b>昵称</b> ${esc(p.nickname || "（待定）")} &nbsp;·&nbsp; <b>Lv</b> ${esc(String(p.level ?? 1))}${p.updatedAtChapter ? ` <span style="color:var(--muted);font-size:11px">（更新至第${p.updatedAtChapter}章）</span>` : ""}</div>
    <table class="md pl-attrs">${attrs}</table>
    <div class="pl-sub">装备</div><ul class="pl-list">${eq}</ul>
    <div class="pl-sub">技能</div><ul class="pl-list">${sk}</ul>
    ${manualBtn}
  </div>`;
}
// 依据当前打开章节的正文，手动触发面板更新
async function manualUpdatePanel() {
  if (!S.chapter) return;
  const btnCard = document.querySelector("#cards .panel-card");
  if (btnCard) { const b = btnCard.querySelector("button"); if (b) { b.disabled = true; b.textContent = "更新中…"; } }
  await commitPanel(S.chapter);
}
function editPanel() {
  const box = document.querySelector("#cards .panel-card");
  if (!box) return;
  box.innerHTML = `<h4>🎮 编辑人物面板</h4><textarea id="panel-edit" style="width:100%;min-height:220px;font-family:ui-monospace,monospace;font-size:12px">${esc(JSON.stringify(S.panel, null, 2))}</textarea><div class="toolbar"><button class="primary" onclick="savePanel()">保存</button><button onclick="refreshSidebar()">取消</button></div>`;
}
async function savePanel() {
  try {
    const panel = JSON.parse($("panel-edit").value);
    await fetch("/api/panel/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, panel }) });
    S.panel = panel; refreshSidebar();
  } catch (e) { alert("JSON 格式有误：" + e.message); }
}
// 本章通过后提交面板更新（第5章起；由 LLM 依据正文更新）
async function commitPanel(n) {
  if (!S.panelEnabled || !n) return;
  try {
    const d = await (await fetch("/api/panel/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, n }) })).json();
    if (d.panel) { S.panel = d.panel; refreshSidebar(); }
  } catch { /* ignore */ }
}
// 根据当前视图刷新右侧
function refreshSidebar() {
  if (!$("view-chapter").classList.contains("hidden")) renderChapterSidebar(S.chapter);
  else renderCards();
}

// 输入记录（信息留存）
async function openLogs() {
  if (!S.bookId) { alert("尚未建书"); return; }
  const r = await fetch(`/api/logs?bookId=${encodeURIComponent(S.bookId)}`);
  const d = await r.json();
  const rows = (d.inputs || []).map((x) => {
    const meta = `<div class="logmeta">${x.at.slice(0, 19).replace("T", " ")} · <b>${esc(x.type)}</b></div>`;
    const isPrompt = /^建书Prompt/.test(x.type || "");
    if (isPrompt) return `<div class="logrow">${meta}<details><summary style="cursor:pointer;color:var(--acc-d);font-size:13px">展开完整 prompt（${x.text.length} 字）</summary><pre>${esc(x.text)}</pre></details></div>`;
    return `<div class="logrow">${meta}<pre>${esc(x.text)}</pre></div>`;
  }).join("") || "<p style='color:var(--muted)'>暂无记录</p>";
  $("logs-body").innerHTML = rows;
  openModal("m-logs");
}

async function reviseFoundation() {
  const fb = $("f-revise").value.trim();
  if (!fb) { alert("请输入修订意见"); return; }
  const btn = event.target; btn.disabled = true; btn.textContent = "重生成中…";
  try {
    const r = await fetch("/api/foundation/revise", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: S.bookId, feedback: fb }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    S.foundation = d.foundation; renderFoundation(); $("f-revise").value = "";
  } catch (e) { alert("重生成失败：" + e.message); }
  finally { btn.disabled = false; btn.textContent = "按意见重生成设定"; }
}

// ---------- 确认设定 → 生成近5章章纲 → 确认 → 开始写作 ----------
function startWriting() {
  closeModal("m-foundation");
  $("home").classList.add("hidden");
  $("workspace").classList.remove("hidden");
  S.book = S.book || { title: $("f-title").value.trim(), targetChapters: +$("f-target").value };
  S.total = 0; S.chaptersData = [];
  renderCards();
  // 初始建书场景：恢复按钮文案与"直接写到完本"
  S.outlineMode = "initial";
  $("btn-outline-confirm").textContent = "✅ 确认章纲，逐章写作";
  $("btn-outline-auto").style.display = "";
  const hint0 = document.querySelector("#m-outline .hint"); if (hint0) hint0.style.display = "";
  S.outlineStart = 1;
  openModal("m-outline");
  $("outline-list").innerHTML = ""; $("outline-audit-log").innerHTML = "";
  genOutlines(1, 5, "");
}

// 生成近 N 章章纲（流式）
function genOutlines(startN, count, feedback) {
  $("outline-range").textContent = `第 ${startN}-${startN + count - 1} 章`;
  $("btn-outline-regen").disabled = true; $("btn-outline-confirm").disabled = true;
  showProgress("outline-progress", "📋 正在规划章纲…");
  let buf = "";
  S.ac = streamPost("/api/chapter-outline", { bookId: S.bookId, startN, count, feedback }, {
    onStage: (s) => showProgress("outline-progress", s.msg),
    onDelta: (t) => { buf += t; showProgress("outline-progress", "✍ 生成中：" + buf.slice(-40).replace(/\n/g, " ")); },
    onEvent: (ev, d) => {
      if (ev === "done") {
        S.outlineEdit = d.outlines || [];
        mergeOutlineEdit();
        hideProgress("outline-progress");
        renderOutlines();
        $("btn-outline-regen").disabled = false; $("btn-outline-confirm").disabled = false;
        $("outline-feedback").value = "";
      } else if (ev === "error") {
        showError2("outline-progress", d);
        $("btn-outline-regen").disabled = false; $("btn-outline-confirm").disabled = false;
      }
    },
  });
}
function renderOutlines() {
  $("outline-list").innerHTML = (S.outlineEdit || []).map((o, i) => `
    <div class="ol-item" data-i="${i}">
      <div class="ol-head">
        <span class="ol-n">第${o.n}章</span>
        <span class="ol-title">${esc(o.title)}</span>
        <span class="ol-edit" onclick="editOutline(${i})">✏ 编辑本章</span>
      </div>
      <p class="ol-sum">${esc(o.summary)}</p>
      <details><summary>展开梗概</summary><div class="mdbox" style="max-height:none">${mdToHtml(o.detail)}</div></details>
    </div>`).join("");
}
function editOutline(i) {
  const o = S.outlineEdit[i];
  const box = $("outline-list").querySelector(`.ol-item[data-i="${i}"]`);
  box.innerHTML = `
    <div class="ol-head"><span class="ol-n">第${o.n}章</span><span style="color:var(--muted);font-size:12px">编辑中</span></div>
    <label style="margin-top:6px">标题</label><input class="e-title" value="${esc(o.title)}" />
    <label>一句话总结</label><input class="e-sum" value="${esc(o.summary)}" />
    <label>梗概</label><textarea class="e-detail">${esc(o.detail)}</textarea>
    <div class="toolbar"><button onclick="saveOutlineEdit(${i})" class="primary">保存本章</button><button onclick="renderOutlines()">取消</button></div>`;
}
function saveOutlineEdit(i) {
  const box = $("outline-list").querySelector(`.ol-item[data-i="${i}"]`);
  S.outlineEdit[i] = { ...S.outlineEdit[i], title: box.querySelector(".e-title").value.trim(), summary: box.querySelector(".e-sum").value.trim(), detail: box.querySelector(".e-detail").value.trim() };
  mergeOutlineEdit();
  renderOutlines();
}
function regenOutlines() {
  const fb = $("outline-feedback").value.trim();
  if (!fb) { alert("请输入整体修改意见"); return; }
  genOutlines(S.outlineStart || 1, (S.outlineEdit?.length || 5), fb);
}
async function confirmOutlines(auto) {
  mergeOutlineEdit();
  $("btn-outline-confirm").disabled = true; $("btn-outline-auto").disabled = true;
  try {
    await fetch("/api/chapter-outline/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: S.bookId, outlines: S.outlines || [] }),
    });
  } catch { /* 存失败也继续 */ }
  $("btn-outline-confirm").disabled = false; $("btn-outline-auto").disabled = false;
  closeModal("m-outline");
  // 组末章纲（人工审阅后）：提交自动审计 → 完成 → 回项目总览
  if (S.outlineMode === "midbook") {
    S.outlineMode = null;
    showChapterView();
    $("cd-title").textContent = `第 ${S.outlineStart}-${S.outlineStart + 4} 章章纲 · 自动审计`;
    $("cd-actions").innerHTML = ""; $("ch-body").textContent = "";
    await runOutlineAudit(S.outlineStart, undefined, true); // 确认 → 标记 confirmed
    showProject();
    return;
  }
  // 初始章纲：确认后开始写作 / 自动到完本
  if (auto) {
    if (!confirm("将从第 1 章开始自动写到完本，中途不再逐章确认。已确认的章纲仍会被遵循。确定？")) return;
    showChapterView();
    $("stage").textContent = "🚀 自动连写已启动…";
    startAuto();
  } else {
    writeChapter(1);
  }
}
// 从当前进度自动写到完本：后台任务（关闭页面也继续），页面只轮询进度
async function startAuto() {
  enterAutoUI();
  try {
    await fetch("/api/auto/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId }) });
  } catch (e) { $("stage").textContent = "启动失败：" + e.message; return; }
  pollAuto();
}
// 进入自动连写的界面状态：项目总览 + 运行横幅（可随时刷新看已写章节）
function enterAutoUI() {
  S.autoRunning = true; S.autoMsg = "启动中…";
  showProject();
}
// 轮询后台状态（只查询，不重启任务）
function pollAuto() {
  clearTimeout(S._autoPoll);
  const tick = async () => {
    let d;
    try { d = await (await fetch(`/api/auto/status?bookId=${encodeURIComponent(S.bookId)}`)).json(); }
    catch { S._autoPoll = setTimeout(tick, 6000); return; }
    S.autoMsg = (d.error ? "⚠ " + d.error + " · " : "") + (d.msg || (d.running ? "运行中…" : "已结束"));
    if ((d.total || 0) !== (S.total || 0)) { await refreshResume(); }  // 有新章 → 拉取
    S.total = d.total || S.total;
    if (d.running) {
      if (!$("view-project").classList.contains("hidden")) renderProject(); // 在总览页则刷新横幅+列表
      S._autoPoll = setTimeout(tick, 6000);
    } else {
      S.autoRunning = false;
      await refreshResume();
      showProject();
    }
  };
  tick();
}
async function stopAuto() {
  await fetch("/api/auto/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId }) }).catch(() => {});
  S.autoMsg = "正在停止…（完成当前章后停止）";
  if (!$("view-project").classList.contains("hidden")) renderProject();
}
// 静默刷新书籍数据（章节/大纲/面板），不切换视图
async function refreshResume() {
  try {
    const d = await (await fetch(`/api/resume?bookId=${encodeURIComponent(S.bookId)}`)).json();
    if (d.error) return;
    S.chaptersData = d.chapters || []; S.total = d.total || 0;
    S.foundation = d.foundation || S.foundation; S.outlines = d.outlines || S.outlines;
    await loadPanel();
  } catch { /* ignore */ }
}
// 对某组章纲跑「生成(若缺)→自动审计→修订→通过」闭环。
// logElId 给定则把每轮审计详情/报错渲染到该元素（弹框内用 "outline-audit-log"）；否则渲染到单章视图的 #outline-audit-box。
function runOutlineAudit(startN, logElId, markDone) {
  const endN = startN + 4;
  return new Promise((resolve) => {
    let box;
    if (logElId) { box = $(logElId); }
    else {
      box = $("outline-audit-box");
      if (!box) { box = document.createElement("div"); box.id = "outline-audit-box"; ($("cd-audit") || $("ch-body")).insertAdjacentElement("beforebegin", box); }
    }
    box.className = "audit-panel";
    const rounds = [];
    let head = `📋 第 ${startN}-${endN} 章章纲：自动审计中…`;
    const render = () => {
      box.innerHTML = `<h4>${esc(head)}</h4>` + rounds.map((a) => {
        if (a.error) return `<div class="iss" style="color:#c0392b">第${a.round}轮出错 [${a.code || ""}]：${esc(a.error)}</div>`;
        return `<div class="iss"><b>第${a.round}轮：${a.passed ? "✅ 合格" : "⚠ 需修订"}</b> ${esc(a.verdict || "")}` +
          (a.raw ? `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:12px;color:var(--acc-d)">展开完整审计意见</summary><pre style="white-space:pre-wrap;font-size:12px;line-height:1.6;margin:4px 0">${esc(a.raw)}</pre></details>` : "") + `</div>`;
      }).join("");
    };
    render();
    streamPost("/api/outline-audit", { bookId: S.bookId, startN, count: 5, markDone: !!markDone }, {
      onStage: (s) => { head = "📋 " + s.msg; render(); },
      onEvent: (ev, d) => {
        if (ev === "audit") { rounds.push(d); render(); }
        else if (ev === "done") {
          const before = JSON.stringify((S.outlines || []).filter((o) => o.n >= startN && o.n <= endN).map((o) => [o.title, o.summary]));
          const map = new Map((S.outlines || []).map((o) => [o.n, o]));
          (d.outlines || []).forEach((o) => map.set(o.n, o));
          S.outlines = [...map.values()].sort((a, b) => a.n - b.n);
          const after = JSON.stringify((S.outlines || []).filter((o) => o.n >= startN && o.n <= endN).map((o) => [o.title, o.summary]));
          const changed = before !== after;
          head = `✅ 第 ${startN}-${endN} 章章纲已就绪（${d.passed ? "审计合格" : "已尽力修订"}，共 ${d.rounds} 轮，${changed ? "章纲已按审计修改" : "无需修改"}）`;
          render();
          resolve();
        } else if (ev === "error") { rounds.push({ round: (rounds.length + 1), error: d.message || "连接中断", code: d.code }); render(); resolve(); }
      },
    });
  });
}
// 章纲弹框内的"自动纠正"：保存当前章纲 → 跑审改闭环 → 回填供人工再审
async function autocorrectOutlines() {
  const startN = S.outlineStart || 1;
  $("btn-outline-regen").disabled = true; $("btn-outline-confirm").disabled = true;
  const ac = $("btn-outline-autocorrect"); if (ac) ac.disabled = true;
  try {
    mergeOutlineEdit();
    await fetch("/api/chapter-outline/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, outlines: S.outlines || [] }) });
    await runOutlineAudit(startN, "outline-audit-log");
    // 审计/修订后 S.outlines 已更新，回填当前组到编辑区并重渲染（展示纠正后的章纲）
    S.outlineEdit = (S.outlines || []).filter((o) => o.n >= startN && o.n < startN + 5).map((o) => ({ ...o }));
    renderOutlines();
  } finally {
    $("btn-outline-regen").disabled = false; $("btn-outline-confirm").disabled = false;
    if (ac) ac.disabled = false;
  }
}
// 人工模式：组末生成下一组章纲 → 弹出供人工审阅/编辑 → 确认后自动审计
function startMidbookOutline(startN) {
  S.outlineMode = "midbook"; S.outlineStart = startN;
  // 组末场景：确认后是"提交自动审计"，隐藏"直接写到完本"
  $("btn-outline-confirm").textContent = "✅ 确认章纲，提交自动审计";
  $("btn-outline-auto").style.display = "none";
  const hint = document.querySelector("#m-outline .hint"); if (hint) hint.style.display = "none";
  openModal("m-outline");
  $("outline-list").innerHTML = ""; $("outline-audit-log").innerHTML = "";
  $("outline-range").textContent = `第 ${startN}-${startN + 4} 章`;
  const existing = (S.outlines || []).filter((o) => o.n >= startN && o.n < startN + 5);
  if (existing.length) {
    // 已有该组大纲（之前生成的）→ 直接展示供人工审阅/编辑，不重复生成
    S.outlineEdit = existing.map((o) => ({ ...o }));
    renderOutlines();
    $("btn-outline-regen").disabled = false; $("btn-outline-confirm").disabled = false;
  } else {
    genOutlines(startN, 5, "");
  }
}
// 把弹框里编辑的 S.outlineEdit 合并回全量 S.outlines（按章号）
function mergeOutlineEdit() {
  const map = new Map((S.outlines || []).map((o) => [o.n, o]));
  (S.outlineEdit || []).forEach((o) => map.set(o.n, o));
  S.outlines = [...map.values()].sort((a, b) => a.n - b.n);
}
// 新增/更新章节数据
function upsertChapter(n, title, content, status) {
  const arr = S.chaptersData || (S.chaptersData = []);
  const idx = arr.findIndex((c) => c.n === n);
  const row = { n, title: cleanTitle(title), content, status: status || "draft" };
  if (idx >= 0) arr[idx] = row; else arr.push(row);
  arr.sort((a, b) => a.n - b.n);
  S.total = arr.length;
}

// 通用：POST + SSE 流式读取（fetch + ReadableStream），返回 AbortController
function streamPost(url, payload, { onStage, onDelta, onEvent }) {
  const ac = new AbortController();
  (async () => {
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) return;
      onEvent("error", { message: "请求发送失败：" + e.message }); return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let ev = "message", data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          const obj = JSON.parse(data);
          if (ev === "stage") onStage?.(obj);
          else if (ev === "delta") onDelta?.(obj.t);
          else onEvent?.(ev, obj);
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) onEvent?.("error", { message: "流中断：" + e.message });
    }
  })();
  return ac;
}

// 流式写一章草稿。opts: {context, rewrite, note}
function streamWrite({ context, rewrite, note }) {
  showChapterView();
  $("cd-title").textContent = `第 ${S.chapter} 章 · 生成中`;
  $("cd-actions").innerHTML = "";
  $("ch-body").textContent = "";
  $("audit-box")?.remove();
  $("btn-pause").classList.remove("hidden");
  $("stage").textContent = "正在规划（章纲+上下文，约1分钟无正文输出）…";
  const sf = makeStreamFilter();
  S.ac = streamPost("/api/write", { bookId: S.bookId, context, rewrite: !!rewrite, note }, {
    onStage: (s) => { $("stage").textContent = s.msg; },
    onDelta: (t) => {
      const r = sf(t);
      if (r.phase === "check") {
        $("stage").textContent = `✍ 写作自检中（推导人物/情节，正文马上开始）… 已生成 ${r.rawLen} 字`;
        $("ch-body").innerHTML = `<div style="color:#b0b8b4;font-size:13px;line-height:1.7;white-space:pre-wrap">${esc(r.raw.slice(-500))}</div>`;
      } else if (r.prose != null) {
        $("stage").textContent = `✍ 正在创作正文… 已 ${r.prose.length} 字`;
        $("ch-body").textContent = r.prose;
      }
    },
    onEvent: (ev, d) => {
      if (ev === "done") {
        S.ac = null; S.chapter = d.chapterNumber; S.preAudit = d.content; S.postAudit = null;
        S.chapterTitle = cleanTitle(d.title);
        upsertChapter(d.chapterNumber, d.title, d.content, "draft");
        $("cd-title").textContent = `第 ${d.chapterNumber} 章 ${S.chapterTitle}`;
        $("ch-body").innerHTML = renderBody(d.content);
        $("btn-pause").classList.add("hidden");
        $("stage").textContent = "草稿完成，请选择操作。";
        openChapterConfirm("draft", d.content, `第 ${d.chapterNumber} 章草稿完成`);
      } else if (ev === "error") {
        S.ac = null; $("btn-pause").classList.add("hidden");
        showError(d);
      }
    },
  });
}

function pauseWrite() {
  if (S.ac) { S.ac.abort(); S.ac = null; }
  $("btn-pause").classList.add("hidden");
  $("stage").textContent = "已暂停：已中断本次接口调用。";
  $("cd-title").textContent = `第 ${S.chapter} 章 · 已暂停`;
}

function showError(d) {
  const code = d?.code ? `[${d.code}] ` : "";
  $("stage").innerHTML = `<span style="color:#c0392b">出错 ${code}${esc(d?.message || "连接中断")}</span>`;
}
// 清理正文：剥掉 writer 结构块残留 + 章节标题行，其余走 markdown 渲染
function renderBody(md) {
  return `<div class="mdbox">${mdToHtml(stripStructure(md))}</div>`;
}
function stripStructure(md) {
  let s = md || "";
  const cc = s.match(/===\s*CHAPTER_CONTENT\s*===\s*([\s\S]*)$/);
  if (cc) s = cc[1];
  s = s.replace(/===\s*(PRE_WRITE_CHECK|CHAPTER_TITLE|CHAPTER_CONTENT)\s*===/g, "");
  s = s.replace(/^\s*#{0,6}\s*第[一二三四五六七八九十百零\d]+章[^\n]*\n/, "");
  return s.trim();
}
function cleanTitle(t) { return (t || "").replace(/^#+\s*/, "").replace(/^第.*?章\s*/, "").trim(); }

// 流式过滤器：writer 依次吐 === PRE_WRITE_CHECK === / === CHAPTER_TITLE === / === CHAPTER_CONTENT ===
function makeStreamFilter() {
  let raw = "";
  return (t) => {
    raw += t;
    const idx = raw.indexOf("=== CHAPTER_CONTENT ===");
    if (idx < 0) return { phase: "check", prose: null, raw, rawLen: raw.length };
    let prose = raw.slice(idx + "=== CHAPTER_CONTENT ===".length);
    prose = prose.replace(/^\s*#{0,6}\s*第[一二三四五六七八九十百零\d]+章[^\n]*\n/, "");
    return { phase: "content", prose: prose.replace(/^\n+/, ""), rawLen: raw.length };
  };
}

// ---------- 章节确认弹框 ----------
// stage: "draft"(修订/重写/继续) | "audited"(5选项)
function openChapterConfirm(stage, content, title) {
  S.confirmStage = stage; S.selectedTab = null;
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = content;
  const tabs = stage === "draft"
    ? [["🔧 自动纠正（AI先自查自改）", "autocorrect", false], ["修订", "revise", true], ["重写", "rewrite", true], ["继续（进入自动审计）", "continue", false]]
    : [["使用审计前版本", "use-pre", false], ["对审计前版本修改", "edit-pre", true],
       ["对审计版本修订", "revise-post", true], ["重写审计版本", "rewrite-post", true],
       ["使用审计后版本", "use-post", false]];
  $("confirm-tabs").innerHTML = tabs.map(([label, val, needText]) =>
    `<div class="tab" data-val="${val}" data-need="${needText}">${label}</div>`).join("");
  $("confirm-tabs").querySelectorAll(".tab").forEach((t) => t.onclick = () => selectTab(t));
  $("confirm-input-wrap").classList.add("hidden");
  openModal("m-confirm");
}
function selectTab(el) {
  $("confirm-tabs").querySelectorAll(".tab").forEach((t) => t.classList.remove("sel"));
  el.classList.add("sel");
  S.selectedTab = el.dataset.val;
  const need = el.dataset.need === "true";
  $("confirm-input-wrap").classList.toggle("hidden", !need);
  $("confirm-hint").textContent = need ? "该选项必须填写意见" : "";
}

async function submitConfirm() {
  const tab = S.selectedTab;
  if (!tab) { alert("请先选择一个操作"); return; }
  const needText = $("confirm-tabs").querySelector(".tab.sel")?.dataset.need === "true";
  const text = $("confirm-input").value.trim();
  if (needText && !text) { alert("该选项必须输入意见"); return; }
  $("confirm-input").value = "";

  if (tab === "autocorrect") { closeModal("m-confirm"); runAudit("draft"); return; }
  if (tab === "continue") { closeModal("m-confirm"); await runAudit("audited"); return; }

  if (tab === "revise" || tab === "rewrite") {
    closeModal("m-confirm");
    const verb = tab === "revise" ? "在原稿基础上按意见修改" : "按意见重写本章";
    streamWrite({ rewrite: true, note: `${verb}：${text}`, context: `${verb}。\n【上一版正文】\n${S.preAudit}\n【意见】\n${text}` });
    return;
  }

  if (tab === "use-pre" || tab === "use-post") {
    closeModal("m-confirm");
    const chosen = tab === "use-pre" ? S.preAudit : S.postAudit;
    if (tab === "use-pre") await setChapter(S.chapter, S.preAudit);
    acceptChapter(chosen);
    return;
  }

  closeModal("m-confirm");
  const base = tab === "edit-pre" ? S.preAudit : S.postAudit;
  const verb = tab === "rewrite-post" ? "按意见重写本章" : "在指定版本基础上按意见修改";
  streamWrite({ rewrite: true, note: `${verb}：${text}`, context: `${verb}。\n【基准正文】\n${base}\n【意见】\n${text}` });
}

// ---------- 自动审改闭环（审计→按等级自动修订→重新审计→循环到通过）----------
function renderReviewLog() {
  let box = $("audit-box");
  if (!box) { box = document.createElement("div"); box.id = "audit-box"; $("ch-body").insertAdjacentElement("afterend", box); }
  box.className = "audit-panel";
  box.innerHTML = (S.reviewRounds || []).map((a) => {
    const list = a.issues.length
      ? a.issues.map((i) => `<div class="iss"><b>[${esc(i.severity)}]</b> ${esc(i.description)}</div>`).join("")
      : `<div class="iss">未发现问题。</div>`;
    return `<h4>🔎 第 ${a.round} 轮审计：${a.passed ? "✅ 通过" : "未通过"}${a.score != null ? ` · 评分 ${a.score}` : ""} · ${a.issues.length} 条</h4>${list}`;
  }).join("<hr style='border:none;border-top:1px dashed var(--line);margin:8px 0'>");
}
// 由"继续/重新审计"(afterStage=audited) 或"自动纠正"(afterStage=draft) 触发：自动审改闭环
// afterStage="audited" → 跑完进入版本选择/定稿；"draft" → 跑完回到人工审阅（可再提意见）
function runAudit(afterStage = "audited") {
  S.reviewRounds = [];
  showChapterView();
  $("cd-actions").innerHTML = "";
  $("cd-title").textContent = `第 ${S.chapter} 章 · 自动审改中`;
  $("stage").textContent = "🔎 第 1 轮审计中（连贯性 / 设定一致性 / 节奏爽感）…";
  $("ch-body").textContent = "";
  $("audit-box")?.remove();
  const sf0 = { fn: makeStreamFilter() };
  S.ac = streamPost("/api/auto-review", { bookId: S.bookId, chapter: S.chapter }, {
    onStage: (s) => { $("stage").textContent = s.msg; },
    onDelta: (t) => { const r = sf0.fn(t); $("ch-body").textContent = r.prose != null ? r.prose : (r.raw || ""); },
    onEvent: (ev, d) => {
      if (ev === "audit") {
        S.reviewRounds.push(d);
        renderReviewLog();
        sf0.fn = makeStreamFilter();
      } else if (ev === "done") {
        S.ac = null;
        S.postAudit = d.content || S.preAudit;
        if (d.title) S.chapterTitle = cleanTitle(d.title);
        $("ch-body").innerHTML = renderBody(S.postAudit);
        $("cd-title").textContent = `第 ${S.chapter} 章 ${S.chapterTitle || ""} · ${d.passed ? "审计已通过" : "已达最多修订轮次"}`;
        $("stage").textContent = d.passed
          ? `✅ 审计通过（共 ${d.rounds} 轮），这是最终版本，请确认。`
          : `⚠ 修订 ${d.rounds} 轮后仍有遗留问题，已给出当前最佳版本，请确认。`;
        renderReviewLog();
        const hist = (S.reviewRounds || []).map((a) => `第${a.round}轮：${a.passed ? "通过" : a.issues.length + "条问题"}`).join("；");
        if (afterStage === "draft") {
          // 自动纠正：纠正后的版本作为新草稿，回到人工审阅（可再修订/重写/继续）
          S.preAudit = S.postAudit;
          $("cd-title").textContent = `第 ${S.chapter} 章 ${S.chapterTitle || ""} · 已自动纠正`;
          openChapterConfirm("draft", S.postAudit, `第 ${S.chapter} 章 · 已自动纠正（${d.passed ? "已通过" : d.rounds + "轮"}），请审阅`);
          $("confirm-body").textContent = S.postAudit + "\n\n——— 自动纠正过程 ———\n" + hist;
        } else {
          openChapterConfirm("audited", S.postAudit, `第 ${S.chapter} 章 · ${d.passed ? "审计通过版本" : "最佳版本"}`);
          $("confirm-body").textContent = S.postAudit + "\n\n——— 审计过程 ———\n" + hist;
        }
      } else if (ev === "error") { S.ac = null; showError(d); }
    },
  });
}

async function setChapter(n, content) {
  await fetch("/api/set-chapter", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: S.bookId, n, content }),
  });
}

// 锁入正文：定稿本章。若为组末（4/9/14…）则先走"章纲人工审+自动审"，再回项目总览
function acceptChapter(content) {
  upsertChapter(S.chapter, S.chapterTitle || "", content, "ready-for-review");
  $("stage").textContent = `第 ${S.chapter} 章已定稿，收入正文。`;
  $("audit-box")?.remove();
  loadBooks();
  const doneN = S.chapter;
  if (S.panelEnabled) { $("stage").textContent = `第 ${doneN} 章已定稿，正在更新人物面板…`; commitPanel(doneN); }
  const nextStart = Math.floor(doneN / 5) * 5 + 6; // 4→6, 9→11…
  const grp = (S.outlines || []).filter((o) => o.n >= nextStart && o.n < nextStart + 5);
  // 组末：下一组大纲缺失或未确认 → 先走"章纲人工审阅 + 自动审计"，确认后再写下一章
  if (doneN % 5 === 4 && (grp.length === 0 || grp.some((o) => !o.confirmed))) {
    startMidbookOutline(nextStart);
  } else {
    showProject();
  }
}

function autoComplete() {
  if (!confirm("将从下一章开始自动连写到完本，中途不再人工确认。确定？")) return;
  showChapterView();
  $("stage").textContent = "🚀 自动连写已启动…";
  startAuto();
}

// ---------- 初始化：加载项目栏 + 就绪检查 ----------
loadBooks();
checkReady();
