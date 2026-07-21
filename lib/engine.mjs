// jace 自研写作引擎 —— LLM 客户端 + 书籍状态 + 长篇管线
// 全部 prompt 从 data/skills/pipeline/*.md 读取（缺失回退到 lib/default-skills.mjs）

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PIPELINE_SKILLS } from "./default-skills.mjs";

// ---------- Skills ----------
function safeName(n) {
  return String(n || "").replace(/[^\w.\- 一-鿿]/g, "").replace(/\.\.+/g, "").trim();
}

export function loadSkillPrompt(projectRoot, name, vars = {}) {
  const fallback = DEFAULT_PIPELINE_SKILLS[name] || "";
  let text = fallback;
  try {
    const p = join(projectRoot, "skills", "pipeline", `${safeName(name)}.md`);
    if (existsSync(p)) {
      const t = readFileSync(p, "utf8");
      if (t.trim()) text = t;
    }
  } catch { /* fallback */ }
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
}

// ---------- LLM ----------
export function createLLMClient(config = {}) {
  return {
    provider: config.provider || "openai",
    service: config.service || "custom",
    configSource: config.configSource || "env",
    apiFormat: config.apiFormat || "chat",
    stream: config.stream !== false,
    baseUrl: String(config.baseUrl || "https://api.deepseek.com").replace(/\/$/, ""),
    apiKey: config.apiKey || "",
    model: config.model || "",
    defaults: {
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens || 8192,
      thinkingBudget: 0,
      extra: {},
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function chatCompletion(client, model, messages, options = {}) {
  if (!client?.apiKey) throw new Error("缺少 API Key");
  const url = `${client.baseUrl}/chat/completions`;
  const temperature = options.temperature ?? client.defaults.temperature;
  const maxTokens = options.maxTokens ?? client.defaults.maxTokens;
  const useStream = options.onTextDelta ? true : !!client.stream && options.stream !== false;

  const body = {
    model: model || client.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature,
    max_tokens: maxTokens,
    stream: useStream,
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${client.apiKey}`,
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        const err = new Error(`LLM HTTP ${resp.status}: ${t.slice(0, 400)}`);
        if ([429, 502, 503, 504].includes(resp.status) && attempt < 2) {
          await sleep(800 * (attempt + 1));
          lastErr = err;
          continue;
        }
        throw err;
      }

      if (!useStream) {
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content ?? "";
        const usage = data?.usage || {};
        return {
          content,
          usage: {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0,
          },
        };
      }

      // SSE stream
      let content = "";
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() || "";
        for (const line of parts) {
          const s = line.trim();
          if (!s.startsWith("data:")) continue;
          const payload = s.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            const delta = j?.choices?.[0]?.delta?.content || "";
            if (delta) {
              content += delta;
              options.onTextDelta?.(delta);
            }
          } catch { /* ignore partial */ }
        }
      }
      return {
        content,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr || new Error("LLM 调用失败");
}

// ---------- helpers ----------
function zhLen(s) {
  return Array.from(String(s || "").replace(/\s+/g, "")).length;
}

function stripChapterStruct(md) {
  let s = md || "";
  const cc = s.match(/===\s*CHAPTER_CONTENT\s*===\s*([\s\S]*)$/i);
  if (cc) s = cc[1];
  return s.replace(/===\s*(PRE_WRITE_CHECK|CHAPTER_TITLE|CHAPTER_CONTENT)\s*===/gi, "").trim();
}

function parseChapterOutput(raw, fallbackTitle = "未命名") {
  const text = String(raw || "");
  const titleM = text.match(/===\s*CHAPTER_TITLE\s*===\s*([\s\S]*?)(?===\s*CHAPTER_CONTENT\s*===|$)/i);
  const bodyM = text.match(/===\s*CHAPTER_CONTENT\s*===\s*([\s\S]*)$/i);
  let title = (titleM ? titleM[1] : "").trim().replace(/^#+\s*/, "").replace(/^第.*?章\s*/, "").trim();
  let content = (bodyM ? bodyM[1] : "").trim();
  if (!content) {
    // 容错：模型没按格式时，整段当正文
    content = text.trim();
  }
  if (!title) title = fallbackTitle;
  return { title: title.slice(0, 40), content };
}

function parseRoles(raw) {
  const parts = String(raw || "").split(/===\s*ROLE\s*===/i).map((x) => x.trim()).filter(Boolean);
  const roles = [];
  for (const p of parts) {
    const tierM = p.match(/tier:\s*(.+)/i);
    const nameM = p.match(/name:\s*(.+)/i);
    const bodyM = p.split(/---\s*/)[1] || p.replace(/^tier:.*$/im, "").replace(/^name:.*$/im, "").trim();
    const tier = (tierM?.[1] || "主要角色").trim();
    const name = (nameM?.[1] || "").trim().replace(/[\/\\:*?"<>|]/g, "");
    if (!name) continue;
    roles.push({ tier: tier.includes("次要") ? "次要角色" : "主要角色", name, content: bodyM.trim() });
  }
  return roles;
}

function parseAuditJson(raw) {
  let s = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const j = JSON.parse(s);
    const issues = Array.isArray(j.issues)
      ? j.issues.map((i) => ({
          severity: ["critical", "warning", "info"].includes(i.severity) ? i.severity : "warning",
          category: i.category || "其它",
          description: i.description || String(i),
          suggestion: i.suggestion || "",
        }))
      : [];
    const hasCritical = issues.some((i) => i.severity === "critical");
    return {
      passed: j.passed === true && !hasCritical,
      overallScore: typeof j.overallScore === "number" ? j.overallScore : null,
      score: typeof j.overallScore === "number" ? j.overallScore : null,
      summary: j.summary || "",
      issues,
      parseFailed: false,
    };
  } catch {
    return {
      passed: false,
      overallScore: null,
      score: null,
      summary: "审计结果无法解析",
      issues: [{ severity: "critical", category: "系统", description: "审计输出不是合法 JSON", suggestion: "重新审计" }],
      parseFailed: true,
    };
  }
}

function safeFileTitle(t) {
  return String(t || "未命名").replace(/[\/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "未命名";
}

// ---------- StateManager ----------
export class StateManager {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
  }
  get booksDir() {
    return join(this.projectRoot, "books");
  }
  bookDir(bookId) {
    return join(this.booksDir, bookId);
  }
  async loadBookConfig(bookId) {
    const p = join(this.bookDir(bookId), "book.json");
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw);
  }
  async saveBookConfig(bookId, config) {
    await mkdir(this.bookDir(bookId), { recursive: true });
    await writeFile(join(this.bookDir(bookId), "book.json"), JSON.stringify(config, null, 2), "utf8");
  }
  async loadChapterIndex(bookId) {
    try {
      return JSON.parse(await readFile(join(this.bookDir(bookId), "chapters", "index.json"), "utf8"));
    } catch {
      return [];
    }
  }
  async saveChapterIndex(bookId, index) {
    const dir = join(this.bookDir(bookId), "chapters");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.json"), JSON.stringify(index, null, 2), "utf8");
  }
  async getNextChapterNumber(bookId) {
    const idx = await this.loadChapterIndex(bookId);
    if (!idx.length) return 1;
    return Math.max(...idx.map((c) => c.number)) + 1;
  }
  async ensureRuntimeState(bookId, chapter = 0) {
    const sdir = join(this.bookDir(bookId), "story", "state");
    await mkdir(sdir, { recursive: true });
    const cur = join(sdir, "current_state.json");
    const man = join(sdir, "manifest.json");
    if (!existsSync(cur)) await writeFile(cur, JSON.stringify({ chapter }, null, 2), "utf8");
    if (!existsSync(man)) await writeFile(man, JSON.stringify({ lastAppliedChapter: chapter }, null, 2), "utf8");
  }
  async bumpState(bookId, chapter) {
    await this.ensureRuntimeState(bookId, chapter);
    const sdir = join(this.bookDir(bookId), "story", "state");
    await writeFile(join(sdir, "current_state.json"), JSON.stringify({ chapter }, null, 2), "utf8");
    await writeFile(join(sdir, "manifest.json"), JSON.stringify({ lastAppliedChapter: chapter }, null, 2), "utf8");
  }
}

// ---------- PipelineRunner ----------
export class PipelineRunner {
  constructor(cfg = {}) {
    this.client = cfg.client;
    this.model = cfg.model;
    this.projectRoot = cfg.projectRoot;
    this.modelOverrides = cfg.modelOverrides || {};
    this.externalContext = cfg.externalContext || "";
    this.chapterReviewMode = cfg.chapterReviewMode || "manual";
    this.logger = cfg.logger;
    this.onTextDelta = cfg.onTextDelta;
    this.onRequest = cfg.onRequest;
    this.onStreamProgress = cfg.onStreamProgress;
    this.state = new StateManager(cfg.projectRoot);
  }

  modelFor(agent) {
    const o = this.modelOverrides[agent];
    if (!o) return this.model;
    return typeof o === "string" ? o : o.model || this.model;
  }

  stage(msg) {
    this.logger?.info?.(msg);
  }

  async chat(agent, messages, opts = {}) {
    this.onRequest?.({ agent, messages });
    this.stage(`调用 ${agent}`);
    const started = Date.now();
    let chars = 0;
    const onDelta = (t) => {
      chars += t.length;
      this.onTextDelta?.(t);
      this.onStreamProgress?.({
        elapsedMs: Date.now() - started,
        totalChars: chars,
        chineseChars: chars,
        status: "streaming",
      });
    };
    const resp = await chatCompletion(this.client, this.modelFor(agent), messages, {
      temperature: opts.temperature ?? 0.7,
      onTextDelta: opts.stream !== false ? onDelta : undefined,
    });
    this.onStreamProgress?.({
      elapsedMs: Date.now() - started,
      totalChars: chars || zhLen(resp.content),
      chineseChars: zhLen(resp.content),
      status: "done",
    });
    return resp;
  }

  skill(name, vars) {
    return loadSkillPrompt(this.projectRoot, name, vars);
  }

  async readFoundation(bookId) {
    const base = join(this.state.bookDir(bookId), "story");
    const pick = async (rel) => {
      try { return await readFile(join(base, rel), "utf8"); } catch { return ""; }
    };
    const roles = [];
    for (const tier of ["主要角色", "次要角色"]) {
      const d = join(base, "roles", tier);
      try {
        for (const f of await readdir(d)) {
          if (f.endsWith(".md")) {
            roles.push({ tier, name: f.replace(/\.md$/, ""), content: await readFile(join(d, f), "utf8") });
          }
        }
      } catch { /* */ }
    }
    return {
      story_frame: await pick("outline/story_frame.md"),
      volume_map: await pick("outline/volume_map.md"),
      book_rules: await pick("book_rules.md"),
      pending_hooks: await pick("pending_hooks.md"),
      style_guide: await pick("style_guide.md"),
      roles,
    };
  }

  async writeFoundationFiles(bookId, parts) {
    const base = join(this.state.bookDir(bookId), "story");
    await mkdir(join(base, "outline"), { recursive: true });
    await mkdir(join(base, "roles", "主要角色"), { recursive: true });
    await mkdir(join(base, "roles", "次要角色"), { recursive: true });
    if (parts.story_frame != null) await writeFile(join(base, "outline", "story_frame.md"), parts.story_frame, "utf8");
    if (parts.volume_map != null) await writeFile(join(base, "outline", "volume_map.md"), parts.volume_map, "utf8");
    if (parts.book_rules != null) await writeFile(join(base, "book_rules.md"), parts.book_rules, "utf8");
    if (parts.pending_hooks != null) await writeFile(join(base, "pending_hooks.md"), parts.pending_hooks, "utf8");
    if (parts.style_guide != null) await writeFile(join(base, "style_guide.md"), parts.style_guide, "utf8");
    if (Array.isArray(parts.roles)) {
      // 清空旧角色再写入
      for (const tier of ["主要角色", "次要角色"]) {
        const d = join(base, "roles", tier);
        try {
          for (const f of await readdir(d)) if (f.endsWith(".md")) await rm(join(d, f), { force: true });
        } catch { /* */ }
      }
      for (const r of parts.roles) {
        const dir = join(base, "roles", r.tier);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${r.name}.md`), r.content || "", "utf8");
      }
    }
  }

  bookBrief(book) {
    return `书名：${book.title}\n题材：${book.genre}\n目标：${book.targetChapters}章 × 每章约${book.chapterWordCount}字\n语言：${book.language || "zh"}`;
  }

  async initBook(book) {
    const bookId = book.id;
    await mkdir(join(this.state.bookDir(bookId), "chapters"), { recursive: true });
    await this.state.saveBookConfig(bookId, book);
    await this.state.saveChapterIndex(bookId, []);
    await this.state.ensureRuntimeState(bookId, 0);

    const settings = this.externalContext || "";
    const brief = this.bookBrief(book);

    this.stage("生成故事框架与世界观");
    const frameResp = await this.chat("architect", [
      { role: "system", content: this.skill("故事框架生成") },
      { role: "user", content: `${brief}\n\n【作者初始设定】\n${settings || "（无额外设定，请按题材合理创作）"}` },
    ], { temperature: 0.7, stream: false });
    const story_frame = frameResp.content.trim();

    this.stage("规划分卷卷纲");
    const volResp = await this.chat("architect", [
      { role: "system", content: this.skill("分卷卷纲生成") },
      { role: "user", content: `${brief}\n\n【故事框架】\n${story_frame}` },
    ], { temperature: 0.6, stream: false });
    const volume_map = volResp.content.trim();

    this.stage("生成角色卡");
    const roleResp = await this.chat("architect", [
      { role: "system", content: this.skill("角色卡生成") },
      { role: "user", content: `${brief}\n\n【故事框架】\n${story_frame}\n\n【分卷卷纲】\n${volume_map}` },
    ], { temperature: 0.7, stream: false });
    const roles = parseRoles(roleResp.content);

    this.stage("生成创作规则");
    const rulesResp = await this.chat("architect", [
      { role: "system", content: this.skill("创作规则生成") },
      { role: "user", content: `${brief}\n\n【故事框架】\n${story_frame}` },
    ], { temperature: 0.5, stream: false });

    this.stage("生成伏笔清单");
    const hooksResp = await this.chat("architect", [
      { role: "system", content: this.skill("伏笔清单生成") },
      { role: "user", content: `${brief}\n\n【故事框架】\n${story_frame}\n\n【分卷卷纲】\n${volume_map}` },
    ], { temperature: 0.6, stream: false });

    this.stage("生成文风指南");
    const styleResp = await this.chat("architect", [
      { role: "system", content: this.skill("文风指南生成") },
      { role: "user", content: `${brief}\n\n【作者设定】\n${settings || "（无）"}\n\n【故事框架摘要】\n${story_frame.slice(0, 2000)}` },
    ], { temperature: 0.5, stream: false });

    await this.writeFoundationFiles(bookId, {
      story_frame,
      volume_map,
      book_rules: rulesResp.content.trim(),
      pending_hooks: hooksResp.content.trim(),
      style_guide: styleResp.content.trim(),
      roles: roles.length ? roles : [{ tier: "主要角色", name: "主角", content: "（待补充）" }],
    });

    // 轻量控制文档，兼容旧路径读取
    const story = join(this.state.bookDir(bookId), "story");
    await writeFile(join(story, "brief.md"), `${brief}\n\n${settings}`, "utf8").catch(() => {});
    await writeFile(join(story, "author_intent.md"), settings || "按既定框架推进主线。", "utf8").catch(() => {});
    await writeFile(join(story, "current_focus.md"), "开篇建立人物与核心冲突。", "utf8").catch(() => {});
  }

  async reviseFoundation(bookId, feedback) {
    const book = await this.state.loadBookConfig(bookId);
    const f = await this.readFoundation(bookId);
    const rolesTxt = (f.roles || []).map((r) => `【${r.tier}/${r.name}】\n${r.content}`).join("\n\n");
    this.stage("按反馈修订设定");
    const resp = await this.chat("foundation-reviewer", [
      { role: "system", content: this.skill("设定修订") },
      {
        role: "user",
        content: `${this.bookBrief(book)}\n\n【作者反馈】\n${feedback}\n\n【当前故事框架】\n${f.story_frame}\n\n【当前卷纲】\n${f.volume_map}\n\n【当前规则】\n${f.book_rules}\n\n【当前伏笔】\n${f.pending_hooks}\n\n【当前文风】\n${f.style_guide}\n\n【当前角色】\n${rolesTxt}\n\n请按下列分区完整输出修订结果：
===SECTION:story_frame===
...
===SECTION:volume_map===
...
===SECTION:book_rules===
...
===SECTION:pending_hooks===
...
===SECTION:style_guide===
...
===SECTION:roles===
（角色区仍用 ===ROLE=== 格式）`,
      },
    ], { temperature: 0.5, stream: false });

    const raw = resp.content;
    const take = (key) => {
      const re = new RegExp(`===\\s*SECTION:${key}\\s*===\\s*([\\s\\S]*?)(?===\\s*SECTION:|$)`, "i");
      const m = raw.match(re);
      return m ? m[1].trim() : null;
    };
    const parts = {
      story_frame: take("story_frame") || f.story_frame,
      volume_map: take("volume_map") || f.volume_map,
      book_rules: take("book_rules") || f.book_rules,
      pending_hooks: take("pending_hooks") || f.pending_hooks,
      style_guide: take("style_guide") || f.style_guide,
    };
    const rolesBlock = take("roles") || "";
    const roles = parseRoles(rolesBlock);
    if (roles.length) parts.roles = roles;
    await this.writeFoundationFiles(bookId, parts);
  }

  async loadRecentChapters(bookId, beforeN, count = 2) {
    const out = [];
    for (let i = Math.max(1, beforeN - count); i < beforeN; i++) {
      const ch = await this.readChapterFile(bookId, i);
      if (ch) out.push(`【第${i}章 ${ch.title}】\n${stripChapterStruct(ch.content).slice(0, 1800)}`);
    }
    return out.join("\n\n");
  }

  async readChapterFile(bookId, n) {
    const dir = join(this.state.bookDir(bookId), "chapters");
    try {
      const files = await readdir(dir);
      const pad = String(n).padStart(4, "0");
      const f = files.find((x) => x.startsWith(pad) && x.endsWith(".md"));
      if (!f) return null;
      return { title: f.slice(5).replace(/\.md$/, ""), content: await readFile(join(dir, f), "utf8"), file: f };
    } catch {
      return null;
    }
  }

  async loadOutline(bookId, n) {
    try {
      const arr = JSON.parse(await readFile(join(this.state.bookDir(bookId), "story", "chapter-outline.json"), "utf8"));
      return arr.find((o) => o.n === n) || null;
    } catch {
      return null;
    }
  }

  async saveChapter(bookId, n, title, content, status = "draft") {
    const dir = join(this.state.bookDir(bookId), "chapters");
    await mkdir(dir, { recursive: true });
    const pad = String(n).padStart(4, "0");
    // 删同号旧文件
    try {
      for (const f of await readdir(dir)) {
        if (f.startsWith(pad + "_") && f.endsWith(".md")) await rm(join(dir, f), { force: true });
      }
    } catch { /* */ }
    const fileName = `${pad}_${safeFileTitle(title)}.md`;
    const body = `===CHAPTER_TITLE===\n${title}\n===CHAPTER_CONTENT===\n${content}\n`;
    await writeFile(join(dir, fileName), body, "utf8");

    const idx = await this.state.loadChapterIndex(bookId);
    const next = idx.filter((c) => c.number !== n);
    next.push({
      number: n,
      title,
      status,
      wordCount: zhLen(content),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auditIssues: [],
    });
    next.sort((a, b) => a.number - b.number);
    await this.state.saveChapterIndex(bookId, next);
    await this.state.bumpState(bookId, n);

    // 写入简易 plan memo（供 /api/plan 读取）
    const runtime = join(this.state.bookDir(bookId), "story", "runtime");
    await mkdir(runtime, { recursive: true });
    const outline = await this.loadOutline(bookId, n);
    const memo = outline
      ? `标题：${outline.title}\n一句话：${outline.summary}\n梗概：${outline.detail}`
      : `标题：${title}`;
    await writeFile(join(runtime, `chapter-${pad}.plan.md`), memo, "utf8");

    return { filePath: join(dir, fileName), wordCount: zhLen(content) };
  }

  async writeDraft(bookId, context) {
    const book = await this.state.loadBookConfig(bookId);
    const n = await this.state.getNextChapterNumber(bookId);
    const f = await this.readFoundation(bookId);
    const outline = await this.loadOutline(bookId, n);
    const recent = await this.loadRecentChapters(bookId, n, 2);
    const rolesTxt = (f.roles || []).slice(0, 8).map((r) => `【${r.tier}】${r.name}\n${r.content.slice(0, 600)}`).join("\n\n");
    const outlineTxt = outline
      ? `第${outline.n}章 ${outline.title}\n核心：${outline.summary}\n梗概：${outline.detail}`
      : "（无预置章纲，请按卷纲推进下一合理情节）";

    this.stage("撰写正文");
    const resp = await this.chat("writer", [
      { role: "system", content: this.skill("正文写手", { wordCount: book.chapterWordCount || 3000 }) },
      {
        role: "user",
        content: `${this.bookBrief(book)}

【故事框架】
${f.story_frame.slice(0, 4000)}

【当前卷纲】
${f.volume_map.slice(0, 3000)}

【创作规则】
${f.book_rules.slice(0, 2000)}

【文风指南】
${f.style_guide.slice(0, 1500)}

【活跃伏笔】
${f.pending_hooks.slice(0, 1500)}

【角色】
${rolesTxt}

【本章章纲】
${outlineTxt}

【前文摘要】
${recent || "（本书开篇）"}

【额外指令】
${context || this.externalContext || "（无）"}

请按格式输出第 ${n} 章。`,
      },
    ], { temperature: 0.75 });

    const parsed = parseChapterOutput(resp.content, outline?.title || `第${n}章`);
    const saved = await this.saveChapter(bookId, n, parsed.title, parsed.content, "draft");
    return {
      chapterNumber: n,
      title: parsed.title,
      wordCount: saved.wordCount,
      filePath: saved.filePath,
      tokenUsage: resp.usage,
    };
  }

  async auditDraft(bookId, chapterNumber) {
    const book = await this.state.loadBookConfig(bookId);
    const n = chapterNumber || (await this.state.getNextChapterNumber(bookId)) - 1;
    if (!n || n < 1) throw new Error("没有可审计的章节");
    const ch = await this.readChapterFile(bookId, n);
    if (!ch) throw new Error(`找不到第 ${n} 章`);
    const f = await this.readFoundation(bookId);
    const outline = await this.loadOutline(bookId, n);
    const recent = await this.loadRecentChapters(bookId, n, 1);

    this.stage("审计章节连贯性");
    const resp = await this.chat("auditor", [
      { role: "system", content: this.skill("章节审计") },
      {
        role: "user",
        content: `${this.bookBrief(book)}

【故事框架要点】
${f.story_frame.slice(0, 2500)}

【创作规则】
${f.book_rules.slice(0, 1500)}

【本章章纲】
${outline ? `${outline.title}｜${outline.summary}\n${outline.detail}` : "（无）"}

【前文】
${recent || "（无）"}

【本章正文】
${stripChapterStruct(ch.content).slice(0, 12000)}

请输出审计 JSON。`,
      },
    ], { temperature: 0.3, stream: false });

    const audit = parseAuditJson(resp.content);
    // 回写 index 状态
    const idx = await this.state.loadChapterIndex(bookId);
    const item = idx.find((c) => c.number === n);
    if (item) {
      item.status = audit.passed ? "ready-for-review" : "audit-failed";
      item.auditIssues = (audit.issues || []).map((i) => `[${i.severity}] ${i.description}`);
      item.updatedAt = new Date().toISOString();
      await this.state.saveChapterIndex(bookId, idx);
    }
    return { ...audit, chapterNumber: n };
  }

  async reviseDraft(bookId, chapterNumber) {
    const book = await this.state.loadBookConfig(bookId);
    const n = chapterNumber || (await this.state.getNextChapterNumber(bookId)) - 1;
    if (!n || n < 1) throw new Error("没有可修订的章节");
    const ch = await this.readChapterFile(bookId, n);
    if (!ch) throw new Error(`找不到第 ${n} 章`);
    const f = await this.readFoundation(bookId);
    const idx = await this.state.loadChapterIndex(bookId);
    const meta = idx.find((c) => c.number === n);
    const issues = (meta?.auditIssues || []).join("\n") || "（无显式问题清单，请整体润色并消除明显硬伤）";

    this.stage("按审计意见修订");
    const resp = await this.chat("reviser", [
      { role: "system", content: this.skill("章节修订") },
      {
        role: "user",
        content: `${this.bookBrief(book)}

【创作规则】
${f.book_rules.slice(0, 1500)}

【文风指南】
${f.style_guide.slice(0, 1200)}

【审计问题】
${issues}

【原文】
${stripChapterStruct(ch.content).slice(0, 12000)}

请输出修订后的章节。`,
      },
    ], { temperature: 0.55 });

    const parsed = parseChapterOutput(resp.content, ch.title);
    const saved = await this.saveChapter(bookId, n, parsed.title, parsed.content, "draft");
    return {
      chapterNumber: n,
      wordCount: saved.wordCount,
      fixedIssues: meta?.auditIssues || [],
      applied: true,
      status: "ready-for-review",
    };
  }

  async writeNextChapter(bookId) {
    const draft = await this.writeDraft(bookId, this.externalContext);
    if (this.chapterReviewMode === "manual") {
      return {
        chapterNumber: draft.chapterNumber,
        title: draft.title,
        wordCount: draft.wordCount,
        auditResult: { passed: false, issues: [], summary: "manual mode: draft only" },
        revised: false,
        status: "draft",
      };
    }
    let audit = await this.auditDraft(bookId, draft.chapterNumber);
    let revised = false;
    if (!audit.passed) {
      await this.reviseDraft(bookId, draft.chapterNumber);
      revised = true;
      audit = await this.auditDraft(bookId, draft.chapterNumber);
    }
    const ch = await this.readChapterFile(bookId, draft.chapterNumber);
    return {
      chapterNumber: draft.chapterNumber,
      title: ch?.title || draft.title,
      wordCount: zhLen(stripChapterStruct(ch?.content || "")),
      auditResult: audit,
      revised,
      status: audit.passed ? "ready-for-review" : "audit-failed",
    };
  }
}
