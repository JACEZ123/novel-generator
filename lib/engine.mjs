// ============================================================================
// 网文小说生成器 · 作者 Jace
// 自研写作引擎 —— LLM 客户端 + 书籍状态 + 长篇/剧本管线
// 提示词从 data/skills/<longform|script>/*.md 读取（缺失回退到 lib/default-skills.mjs）
// © Jace · MIT License
// ============================================================================

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LONGFORM_SKILLS, DEFAULT_SCRIPT_SKILLS, DEFAULT_SKILLS_BY_GROUP } from "./default-skills.mjs";
import { DEFAULT_LOOPS } from "./loop-config.mjs";

// ---------- Skills ----------
function safeName(n) {
  return String(n || "").replace(/[^\w.\- 一-鿿]/g, "").replace(/\.\.+/g, "").trim();
}

/** kind: longform | script — 技能按作品类型分目录存放 */
export function loadSkillPrompt(projectRoot, name, vars = {}, kind = "longform") {
  const group = kind === "script" ? "script" : "longform";
  const defaults = DEFAULT_SKILLS_BY_GROUP[group] || DEFAULT_LONGFORM_SKILLS;
  const fallback = defaults[name] || DEFAULT_SCRIPT_SKILLS[name] || DEFAULT_LONGFORM_SKILLS[name] || "";
  let text = fallback;
  try {
    const primary = join(projectRoot, "skills", group, `${safeName(name)}.md`);
    const legacy = join(projectRoot, "skills", "pipeline", `${safeName(name)}.md`);
    const p = existsSync(primary) ? primary : (existsSync(legacy) ? legacy : null);
    if (p) {
      const t = readFileSync(p, "utf8");
      if (t.trim()) text = t;
    }
  } catch { /* fallback */ }
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
}

/** 读取 data/skills/custom/*.md，拼成可注入上下文的用户技能包 */
export function loadCustomSkillsBundle(projectRoot, maxChars = 4000) {
  const dir = join(projectRoot, "skills", "custom");
  if (!existsSync(dir)) return "";
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  const chunks = [];
  let used = 0;
  for (const f of files) {
    try {
      const body = readFileSync(join(dir, f), "utf8").trim();
      if (!body) continue;
      const block = `### ${f.replace(/\.md$/, "")}\n${body}`;
      if (used + block.length > maxChars) break;
      chunks.push(block);
      used += block.length;
    } catch { /* skip */ }
  }
  if (!chunks.length) return "";
  return `【用户自定义技能（必须遵守）】\n${chunks.join("\n\n")}`;
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
/** 建书各节点的展示元数据（进度条 / 剩余项文案） */
const FOUNDATION_STEP_META = {
  foundation_frame: {
    label: "故事框架与世界观",
    skill: { longform: "故事框架生成", script: "剧本结构生成" },
    writing: { longform: "编写世界观", script: "编写剧本大纲" },
    parse: { longform: "世界观", script: "剧本大纲" },
  },
  foundation_volume: {
    label: "分卷卷纲",
    skill: { longform: "分卷卷纲生成", script: "幕场结构生成" },
    writing: { longform: "编写分卷卷纲", script: "编写幕场结构" },
    parse: { longform: "分卷卷纲", script: "幕场结构" },
  },
  foundation_roles: {
    label: "角色卡",
    skill: { longform: "角色卡生成", script: "角色卡生成" },
    writing: { longform: "编写角色卡", script: "编写角色卡" },
    parse: { longform: "角色卡", script: "角色卡" },
  },
  foundation_rules: {
    label: "创作规则",
    skill: { longform: "创作规则生成", script: "创作规则生成" },
    writing: { longform: "编写创作规则", script: "编写创作规则" },
    parse: { longform: "创作规则", script: "创作规则" },
  },
  foundation_hooks: {
    label: "伏笔清单",
    skill: { longform: "伏笔清单生成", script: "伏笔清单生成" },
    writing: { longform: "编写伏笔清单", script: "编写戏剧钩子" },
    parse: { longform: "伏笔清单", script: "戏剧钩子" },
  },
  foundation_style: {
    label: "文风指南",
    skill: { longform: "文风指南生成", script: "文风指南生成" },
    writing: { longform: "编写文风指南", script: "编写文风指南" },
    parse: { longform: "文风指南", script: "文风指南" },
  },
};

function foundationStepPercent(stepIdx, total, within01) {
  const n = Math.max(1, total);
  const base = (stepIdx / n) * 100;
  const span = 100 / n;
  return Math.min(99, Math.max(1, Math.round(base + span * Math.min(1, Math.max(0, within01)))));
}

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
    this.onProgress = cfg.onProgress;
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

  /** 细粒度进度：msg / percent / remaining / elapsedSec / step */
  progress(info = {}) {
    const payload = {
      msg: info.msg || "",
      percent: info.percent != null ? info.percent : null,
      remaining: info.remaining != null ? String(info.remaining) : "",
      elapsedSec: info.elapsedSec != null ? info.elapsedSec : null,
      step: info.step || "",
      phase: info.phase || "",
    };
    this.onProgress?.(payload);
    if (payload.msg) this.logger?.info?.(payload.msg);
  }

  async chat(agent, messages, opts = {}) {
    const onPhase = typeof opts.onPhase === "function" ? opts.onPhase : null;
    onPhase?.("send");
    this.onRequest?.({ agent, messages });
    this.stage(`调用 ${agent}`);
    onPhase?.("understand");
    const started = Date.now();
    let chars = 0;
    let lastPhaseAt = 0;
    const wantStream = opts.stream !== false || !!onPhase;
    const onDelta = (t) => {
      chars += t.length;
      this.onTextDelta?.(t);
      this.onStreamProgress?.({
        elapsedMs: Date.now() - started,
        totalChars: chars,
        chineseChars: chars,
        status: "streaming",
      });
      if (onPhase && Date.now() - lastPhaseAt >= 700) {
        lastPhaseAt = Date.now();
        onPhase("streaming", { chars, elapsedMs: Date.now() - started });
      }
    };
    const resp = await chatCompletion(this.client, this.modelFor(agent), messages, {
      temperature: opts.temperature ?? 0.7,
      onTextDelta: wantStream ? onDelta : undefined,
      stream: wantStream,
    });
    this.onStreamProgress?.({
      elapsedMs: Date.now() - started,
      totalChars: chars || zhLen(resp.content),
      chineseChars: zhLen(resp.content),
      status: "done",
    });
    onPhase?.("done", { chars: chars || zhLen(resp.content), elapsedMs: Date.now() - started });
    return resp;
  }

  skill(name, vars = {}, kind = "longform") {
    return loadSkillPrompt(this.projectRoot, name, vars, kind === "script" ? "script" : "longform");
  }

  customBundle() {
    return loadCustomSkillsBundle(this.projectRoot);
  }

  async loadChapterSummaries(bookId, maxChars = 3500) {
    const p = join(this.state.bookDir(bookId), "story", "chapter_summaries.md");
    try {
      const t = await readFile(p, "utf8");
      if (t.length <= maxChars) return t.trim();
      return t.slice(-maxChars).trim();
    } catch {
      return "";
    }
  }

  async appendChapterSummary(bookId, n, title, content, outline) {
    const p = join(this.state.bookDir(bookId), "story", "chapter_summaries.md");
    const one = outline?.summary
      || stripChapterStruct(content).replace(/\s+/g, " ").slice(0, 180);
    const line = `- 第${n}章《${title}》：${one}\n`;
    try {
      await writeFile(p, (existsSync(p) ? await readFile(p, "utf8") : "") + line, "utf8");
    } catch { /* ignore */ }
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

  async initBook(book, options = {}) {
    const bookId = book.id;
    await mkdir(join(this.state.bookDir(bookId), "chapters"), { recursive: true });
    await this.state.saveBookConfig(bookId, book);
    await this.state.saveChapterIndex(bookId, []);
    await this.state.ensureRuntimeState(bookId, 0);

    const settings = this.externalContext || "";
    const brief = this.bookBrief(book);
    const custom = this.customBundle();
    const customBlock = custom ? `\n\n${custom}` : "";
    const isScript = book.kind === "script";
    const kind = isScript ? "script" : "longform";
    const kindKey = isScript ? "script" : "longform";
    const loop = Array.isArray(options.foundationLoop) && options.foundationLoop.length
      ? options.foundationLoop
      : DEFAULT_LOOPS.foundation;

    let story_frame = "";
    let volume_map = "";
    let roles = [];
    let book_rules = "";
    let pending_hooks = "";
    let style_guide = "";

    const total = loop.filter((id) => FOUNDATION_STEP_META[id]).length || loop.length;
    const labelsOf = (ids) => ids.map((id) => FOUNDATION_STEP_META[id]?.label || id);
    const remainingOf = (fromIdx) => {
      const rest = labelsOf(loop.slice(fromIdx + 1));
      return rest.length ? rest.join("、") : "无";
    };

    const runLlmStep = async (stepId, stepIdx, buildMessages, { temperature = 0.7, validate, maxRetry = 1 } = {}) => {
      const meta = FOUNDATION_STEP_META[stepId] || { label: stepId, skill: { longform: stepId, script: stepId }, writing: { longform: stepId, script: stepId }, parse: { longform: stepId, script: stepId } };
      const skillName = meta.skill[kindKey] || meta.skill.longform;
      const writingLabel = meta.writing[kindKey] || meta.writing.longform;
      const parseLabel = meta.parse[kindKey] || meta.parse.longform;
      const remaining = remainingOf(stepIdx);
      const stepT0 = Date.now();
      const elapsed = () => Math.max(0, Math.round((Date.now() - stepT0) / 1000));
      const pct = (w) => foundationStepPercent(stepIdx, total, w);

      this.progress({
        step: stepId,
        phase: "skill",
        msg: `正在结合 skill「${skillName}」组装 Prompt`,
        percent: pct(0.05),
        remaining,
        elapsedSec: elapsed(),
      });

      const messages = buildMessages(skillName);

      this.progress({
        step: stepId,
        phase: "send",
        msg: `正在发送 Prompt（${meta.label}）`,
        percent: pct(0.12),
        remaining,
        elapsedSec: elapsed(),
      });

      let attempt = 0;
      let content = "";
      while (attempt <= maxRetry) {
        attempt += 1;
        if (attempt > 1) {
          this.progress({
            step: stepId,
            phase: "retry",
            msg: `大模型返回${parseLabel}不符合规范，重新生成中，耗时 ${elapsed()}s，整体 ${pct(0.1)}%`,
            percent: pct(0.1),
            remaining,
            elapsedSec: elapsed(),
          });
        }

        const resp = await this.chat("architect", messages, {
          temperature,
          stream: true,
          onPhase: (phase, extra = {}) => {
            if (phase === "understand") {
              this.progress({
                step: stepId,
                phase,
                msg: `大模型已接收 Prompt，开始理解中（${meta.label}）`,
                percent: pct(0.22),
                remaining,
                elapsedSec: elapsed(),
              });
            } else if (phase === "streaming") {
              const n = extra.chars || 0;
              this.progress({
                step: stepId,
                phase,
                msg: `大模型正在返回${writingLabel}（已接收 ${n} 字）`,
                percent: pct(0.25 + Math.min(0.55, n / 8000 * 0.55)),
                remaining,
                elapsedSec: elapsed(),
              });
            } else if (phase === "done") {
              this.progress({
                step: stepId,
                phase,
                msg: `大模型已返回${parseLabel}，Markdown 格式处理中，耗时 ${elapsed()}s，整体 ${pct(0.85)}%`,
                percent: pct(0.85),
                remaining,
                elapsedSec: elapsed(),
              });
            }
          },
        });
        content = (resp.content || "").trim();

        if (!validate) break;
        const ok = validate(content);
        if (ok) break;
        if (attempt > maxRetry) break;
      }

      this.progress({
        step: stepId,
        phase: "parsed",
        msg: `${parseLabel}已处理完成，耗时 ${elapsed()}s，整体 ${pct(1)}%，剩余 ${remaining === "无" ? "收尾入库" : remaining} 待生成`,
        percent: pct(1),
        remaining,
        elapsedSec: elapsed(),
      });
      return content;
    };

    const steps = {
      foundation_frame: async (stepIdx) => {
        this.stage(isScript ? "生成剧本故事大纲" : "生成故事框架与世界观");
        story_frame = await runLlmStep("foundation_frame", stepIdx, (skillName) => [
          { role: "system", content: this.skill(skillName, {}, kind) },
          { role: "user", content: `${brief}\n\n【作者初始设定】\n${settings || "（无额外设定，请按题材合理创作）"}${customBlock}` },
        ], {
          temperature: 0.7,
          maxRetry: 1,
          validate: (c) => c.length >= 80,
        });
      },
      foundation_volume: async (stepIdx) => {
        this.stage(isScript ? "规划幕场结构" : "规划分卷卷纲");
        volume_map = await runLlmStep("foundation_volume", stepIdx, (skillName) => [
          { role: "system", content: this.skill(skillName, {}, kind) },
          { role: "user", content: `${brief}\n\n【故事框架】\n${story_frame || "（待补充）"}${customBlock}` },
        ], {
          temperature: 0.6,
          maxRetry: 1,
          validate: (c) => c.length >= 60,
        });
      },
      foundation_roles: async (stepIdx) => {
        this.stage("生成角色卡");
        const raw = await runLlmStep("foundation_roles", stepIdx, (skillName) => [
          { role: "system", content: this.skill(skillName, {}, kind) },
          { role: "user", content: `${brief}\n\n【故事框架】\n${story_frame || "（待补充）"}\n\n【结构】\n${volume_map || "（待补充）"}${customBlock}` },
        ], {
          temperature: 0.7,
          maxRetry: 1,
          validate: (c) => parseRoles(c).length >= 1,
        });
        roles = parseRoles(raw);
      },
      foundation_rules: async (stepIdx) => {
        this.stage("生成创作规则");
        book_rules = await runLlmStep("foundation_rules", stepIdx, (skillName) => [
          { role: "system", content: this.skill(skillName, {}, kind) },
          { role: "user", content: `${brief}\n\n【故事框架】\n${story_frame || "（待补充）"}\n类型：${isScript ? "剧本" : "长篇小说"}${customBlock}` },
        ], { temperature: 0.5, maxRetry: 1, validate: (c) => c.length >= 40 });
      },
      foundation_hooks: async (stepIdx) => {
        this.stage(isScript ? "生成戏剧钩子清单" : "生成伏笔清单");
        pending_hooks = await runLlmStep("foundation_hooks", stepIdx, (skillName) => [
          { role: "system", content: this.skill(skillName, {}, kind) },
          { role: "user", content: `${brief}\n\n【故事框架】\n${story_frame || "（待补充）"}\n\n【结构】\n${volume_map || "（待补充）"}${customBlock}` },
        ], { temperature: 0.6, maxRetry: 1, validate: (c) => c.length >= 40 });
      },
      foundation_style: async (stepIdx) => {
        this.stage("生成文风指南");
        style_guide = await runLlmStep("foundation_style", stepIdx, (skillName) => [
          { role: "system", content: this.skill(skillName, {}, kind) },
          { role: "user", content: `${brief}\n\n【作者设定】\n${settings || "（无）"}\n\n【故事框架摘要】\n${(story_frame || "（待补充）").slice(0, 2000)}\n类型：${isScript ? "剧本对白风格" : "小说叙事"}${customBlock}` },
        ], { temperature: 0.5, maxRetry: 1, validate: (c) => c.length >= 40 });
      },
    };

    this.progress({
      msg: "正在初始化书籍目录与创作骨架",
      percent: 1,
      remaining: labelsOf(loop).join("、") || "设定各节",
      elapsedSec: 0,
      phase: "init",
    });

    let stepIdx = 0;
    for (const id of loop) {
      if (steps[id]) {
        await steps[id](stepIdx);
        stepIdx += 1;
      }
    }

    this.progress({
      msg: "全部设定已生成，正在写入 Markdown 文件",
      percent: 96,
      remaining: "无",
      elapsedSec: 0,
      phase: "write",
    });

    await this.writeFoundationFiles(bookId, {
      story_frame: story_frame || "（未生成，请补充）",
      volume_map: volume_map || "（未生成，请补充）",
      book_rules: book_rules || "（未生成，请补充）",
      pending_hooks: pending_hooks || "（未生成，请补充）",
      style_guide: style_guide || "（未生成，请补充）",
      roles: roles.length ? roles : [{ tier: "主要角色", name: "主角", content: "（待补充）" }],
    });

    // 轻量控制文档，兼容旧路径读取
    const story = join(this.state.bookDir(bookId), "story");
    await writeFile(join(story, "brief.md"), `${brief}\n\n${settings}`, "utf8").catch(() => {});
    await writeFile(join(story, "author_intent.md"), settings || "按既定框架推进主线。", "utf8").catch(() => {});
    await writeFile(join(story, "current_focus.md"), "开篇建立人物与核心冲突。", "utf8").catch(() => {});

    this.progress({
      msg: "设定入库完成，准备反显确认",
      percent: 100,
      remaining: "无",
      elapsedSec: 0,
      phase: "done",
    });
  }

  async reviseFoundation(bookId, feedback) {
    const book = await this.state.loadBookConfig(bookId);
    const f = await this.readFoundation(bookId);
    const rolesTxt = (f.roles || []).map((r) => `【${r.tier}/${r.name}】\n${r.content}`).join("\n\n");
    this.stage("按反馈修订设定");
    const resp = await this.chat("foundation-reviewer", [
      { role: "system", content: this.skill("设定修订", {}, book.kind === "script" ? "script" : "longform") },
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
    const summaries = await this.loadChapterSummaries(bookId);
    const custom = this.customBundle();
    const rolesTxt = (f.roles || []).slice(0, 8).map((r) => `【${r.tier}】${r.name}\n${r.content.slice(0, 600)}`).join("\n\n");
    const isScript = book.kind === "script";
    const unit = isScript ? "场" : "章";
    const outlineTxt = outline
      ? `第${outline.n}${unit} ${outline.title}\n核心：${outline.summary}\n梗概：${outline.detail}`
      : `（无预置${unit}纲，请按结构推进下一合理情节）`;

    this.stage(isScript ? "撰写分场剧本" : "撰写正文");
    const resp = await this.chat("writer", [
      { role: "system", content: this.skill(isScript ? "分场剧本写手" : "正文写手", { wordCount: book.chapterWordCount || 3000 }, isScript ? "script" : "longform") },
      {
        role: "user",
        content: `${this.bookBrief(book)}
类型：${isScript ? "剧本" : "长篇小说"}

【故事框架】
${f.story_frame.slice(0, 4000)}

【结构】
${f.volume_map.slice(0, 3000)}

【创作规则】
${f.book_rules.slice(0, 2000)}

【文风指南】
${f.style_guide.slice(0, 1500)}

【钩子/伏笔】
${f.pending_hooks.slice(0, 1500)}

【角色】
${rolesTxt}

【本${unit}大纲】
${outlineTxt}

【历史摘要】
${summaries || "（尚无）"}

【近篇摘录】
${recent || "（开篇）"}

${custom || ""}

【额外指令】
${context || this.externalContext || "（无）"}

请按格式输出第 ${n} ${unit}。`,
      },
    ], { temperature: 0.75 });

    const parsed = parseChapterOutput(resp.content, outline?.title || `第${n}章`);
    const saved = await this.saveChapter(bookId, n, parsed.title, parsed.content, "draft");
    await this.appendChapterSummary(bookId, n, parsed.title, parsed.content, outline);
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
    const custom = this.customBundle();
    const isScript = book.kind === "script";

    this.stage(isScript ? "审计分场剧本" : "审计章节连贯性");
    const resp = await this.chat("auditor", [
      { role: "system", content: this.skill(isScript ? "剧本审计" : "章节审计", {}, isScript ? "script" : "longform") },
      {
        role: "user",
        content: `${this.bookBrief(book)}

【故事框架要点】
${f.story_frame.slice(0, 2500)}

【创作规则】
${f.book_rules.slice(0, 1500)}

【本篇大纲】
${outline ? `${outline.title}｜${outline.summary}\n${outline.detail}` : "（无）"}

【前文】
${recent || "（无）"}

${custom || ""}

【正文】
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
    const custom = this.customBundle();
    const isScript = book.kind === "script";

    this.stage(isScript ? "修订分场剧本" : "按审计意见修订");
    const resp = await this.chat("reviser", [
      { role: "system", content: this.skill(isScript ? "剧本修订" : "章节修订", {}, isScript ? "script" : "longform") },
      {
        role: "user",
        content: `${this.bookBrief(book)}

【创作规则】
${f.book_rules.slice(0, 1500)}

【文风指南】
${f.style_guide.slice(0, 1200)}

${custom || ""}

【审计问题】
${issues}

【原文】
${stripChapterStruct(ch.content).slice(0, 12000)}

请输出修订后的内容。`,
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
