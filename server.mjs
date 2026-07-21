// jace 开源小说生成器 — 自动写作工作台（后端）
// Node http + SSE。写作 / 审计 / 状态由本仓库自研引擎 lib/engine.mjs 提供。
// 许可：MIT（本仓库自包含，无第三方写作引擎依赖）。

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { PipelineRunner, createLLMClient, StateManager, chatCompletion, loadSkillPrompt, loadCustomSkillsBundle } from "./lib/engine.mjs";
import { DEFAULT_PIPELINE_SKILLS, SKILL_GROUP_DEFS } from "./lib/default-skills.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DATA_ROOT = join(HERE, "data");             // 本工作台的项目数据根目录
const PUBLIC = join(HERE, "public");
const PORT = Number(process.env.NOVEL_PORT || 4568);

// ---------- LLM 配置：用户自行配置，绝不硬编码密钥 ----------
// 读取优先级：环境变量 > data/config.json > 内置默认（默认无密钥）。
// 密钥只在服务端读取，永不写入日志、永不返回给前端。
const CONFIG_PATH = join(DATA_ROOT, "config.json");
const DEFAULT_LLM = {
  // 默认对接 DeepSeek，但 baseUrl / 模型均可改，任意 OpenAI 兼容接口都能用
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  // 每个模型：id=模型标识，label=显示名称，type=模型类型，thinking=是否支持深度思考
  models: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", type: "text", thinking: true },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", type: "text", thinking: true },
  ],
  fastModel: "deepseek-v4-flash",
  strongModel: "deepseek-v4-pro",
  temperature: 0.7,
};
// 补全模型字段（老配置可能缺 type/thinking）
function normModels(models) {
  const arr = Array.isArray(models) && models.length ? models : DEFAULT_LLM.models;
  return arr.filter((m) => m && m.id).map((m) => ({
    id: String(m.id),
    label: String(m.label || m.id),
    type: m.type || "text",
    thinking: m.thinking !== false,
  }));
}
// 只读配置文件（不叠加环境变量）——供设置界面回显与写回
function loadLLMConfigRaw() {
  let cfg = { ...DEFAULT_LLM };
  try { if (existsSync(CONFIG_PATH)) cfg = { ...cfg, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) }; } catch { /* ignore */ }
  cfg.models = normModels(cfg.models);
  return cfg;
}
// 实际生效配置（叠加环境变量覆盖，便于容器 / CI 部署且不落盘密钥）
function loadLLMConfig() {
  const cfg = loadLLMConfigRaw();
  cfg.apiKey = process.env.NOVEL_API_KEY || process.env.OPENAI_API_KEY || cfg.apiKey || "";
  cfg.baseUrl = process.env.NOVEL_BASE_URL || cfg.baseUrl;
  if (process.env.NOVEL_MODEL) cfg.fastModel = process.env.NOVEL_MODEL;
  if (process.env.NOVEL_MODEL_STRONG) cfg.strongModel = process.env.NOVEL_MODEL_STRONG;
  return cfg;
}
function hasApiKey() { return !!loadLLMConfig().apiKey; }

function makeClient() {
  const cfg = loadLLMConfig();
  if (!cfg.apiKey) {
    throw new Error("尚未配置 API Key：请在首页「设置」中填写，或设置环境变量 NOVEL_API_KEY / OPENAI_API_KEY。");
  }
  return createLLMClient({
    provider: "openai",
    service: "openai-compatible",
    configSource: "env",
    baseUrl: cfg.baseUrl,
    model: cfg.fastModel,
    apiFormat: "chat",
    stream: true,
    apiKey: cfg.apiKey,
    temperature: cfg.temperature ?? 0.7,
  });
}

const MODEL = loadLLMConfig().fastModel;

// ---------- 分阶段模型配置（每个写作阶段可单独选模型）----------
const MODEL_CONFIG_PATH = join(DATA_ROOT, "model-config.json");
// 各写作阶段 → 可读标签，前端据此渲染
export const MODEL_STAGES = [
  { key: "architect", label: "大纲/世界观生成" },
  { key: "foundation-reviewer", label: "设定审核" },
  { key: "planner", label: "章纲规划" },
  { key: "outline-auditor", label: "大纲审计" },
  { key: "outline-reviser", label: "大纲修订" },
  { key: "panel-updater", label: "人物面板更新" },
  { key: "writer", label: "正文创作" },
  { key: "auditor", label: "章节审查" },
  { key: "reviser", label: "章节修订" },
  { key: "length-normalizer", label: "字数归一化" },
  { key: "state-validator", label: "状态校验" },
];
function availableModels() { return loadLLMConfig().models; }
// 默认分配：偏重质量的阶段（大纲/设定审核/修订/审计）用 Strong，其余用 Fast
function defaultModelConfig() {
  const { fastModel: f, strongModel: s } = loadLLMConfig();
  return {
    "architect": s, "foundation-reviewer": s, "planner": f,
    "outline-auditor": s, "outline-reviser": s, "panel-updater": f,
    "writer": f, "auditor": f, "reviser": s,
    "length-normalizer": f, "state-validator": f,
  };
}
function loadModelConfig() {
  const base = defaultModelConfig();
  try {
    if (existsSync(MODEL_CONFIG_PATH)) {
      return { ...base, ...JSON.parse(readFileSync(MODEL_CONFIG_PATH, "utf8")) };
    }
  } catch { /* ignore */ }
  return base;
}

// ---------- 题材设置：题材列表 + 是否启用人物面板 ----------
const GENRES_PATH = join(DATA_ROOT, "genres.json");
const DEFAULT_GENRES = [
  { id: "other", label: "通用/自定义", panel: false },
  { id: "xianxia", label: "仙侠", panel: true },
  { id: "xuanhuan", label: "玄幻", panel: true },
  { id: "urban", label: "都市", panel: false },
  { id: "litrpg", label: "游戏/LitRPG", panel: true },
  { id: "progression", label: "升级流", panel: true },
  { id: "cultivation", label: "修真", panel: true },
  { id: "sci-fi", label: "科幻", panel: false },
  { id: "horror", label: "恐怖", panel: false },
  { id: "isekai", label: "异世界", panel: true },
  { id: "romantasy", label: "浪漫奇幻", panel: false },
  { id: "system-apocalypse", label: "系统末世", panel: true },
  { id: "tower-climber", label: "爬塔", panel: true },
  { id: "dungeon-core", label: "地下城核心", panel: true },
  { id: "cozy", label: "治愈日常", panel: false },
];
function loadGenres() {
  try {
    if (existsSync(GENRES_PATH)) {
      const a = JSON.parse(readFileSync(GENRES_PATH, "utf8"));
      if (Array.isArray(a) && a.length) return a.filter((g) => g && g.id).map((g) => ({ id: String(g.id), label: String(g.label || g.id), panel: !!g.panel }));
    }
  } catch { /* ignore */ }
  return DEFAULT_GENRES;
}
function panelGenreSet() { return new Set(loadGenres().filter((g) => g.panel).map((g) => g.id)); }

// ---------- 自动写作配置：全局默认与运行时轮数 ----------
const WRITING_CFG_PATH = join(DATA_ROOT, "writing-config.json");
const DEFAULT_WRITING = {
  targetChapters: 200,        // 建书默认目标章数
  chapterWordCount: 3000,     // 建书默认每章字数
  outlineAuditMaxRounds: 2,   // 章纲结构审计最多修订轮数
  autoReviewMaxRounds: 3,     // 正文自动审改最多轮数
};
function loadWritingConfig() {
  let c = { ...DEFAULT_WRITING };
  try { if (existsSync(WRITING_CFG_PATH)) c = { ...c, ...JSON.parse(readFileSync(WRITING_CFG_PATH, "utf8")) }; } catch { /* ignore */ }
  return c;
}

// ---------- Skills：data/skills/<组>/*.md，全部可查看/编辑，pipeline 组运行时真实生效 ----------
const SKILLS_DIR = join(DATA_ROOT, "skills");
const SKILL_GROUPS = SKILL_GROUP_DEFS;
const DEFAULT_SKILLS = { pipeline: DEFAULT_PIPELINE_SKILLS };
const safeSkillName = (n) => String(n || "").replace(/[^\w.\- 一-鿿]/g, "").replace(/\.\.+/g, "").trim();
const skillFilePath = (group, name) => join(SKILLS_DIR, group, `${safeSkillName(name)}.md`);

async function seedSkills() {
  const dir = join(SKILLS_DIR, "pipeline");
  await mkdir(dir, { recursive: true }).catch(() => {});
  for (const [name, content] of Object.entries(DEFAULT_PIPELINE_SKILLS)) {
    const p = skillFilePath("pipeline", name);
    if (!existsSync(p)) await writeFile(p, content, "utf8").catch(() => {});
  }
  // 清理历史遗留的参考组（已不再使用）
  await rm(join(SKILLS_DIR, "engine"), { recursive: true, force: true }).catch(() => {});
  await mkdir(join(SKILLS_DIR, "custom"), { recursive: true }).catch(() => {});
}

function skillPrompt(name, vars = {}) {
  return loadSkillPrompt(DATA_ROOT, name, vars);
}

// 引擎阶段（agent）名 → 中文友好名（用于进度反馈）
function friendlyAgent(agent) {
  return ({
    architect: "架构师·生成大纲与世界观", "foundation-reviewer": "设定审核员",
    planner: "章节规划师", writer: "正文写手", auditor: "连贯性审查员",
    reviser: "章节修订员", "length-normalizer": "字数归一", "state-validator": "状态校验",
    "chapter-analyzer": "章节分析", radar: "市场雷达", composer: "上下文组装",
  })[agent] || agent;
}
// 引擎原始阶段日志 → 更口语化的中文（尽量保留原意，加图标）
function friendlyStage(msg) {
  const map = [
    [/architect|大纲|story_frame|骨架/i, "🏗 生成故事框架与世界观…"],
    [/volume_map|卷纲/i, "🗺 规划分卷卷纲（OKR）…"],
    [/role|角色/i, "👤 生成角色卡…"],
    [/review|审核|reviewer|评分/i, "🔍 审核设定质量…"],
    [/规划下一章|plan.*chapter|意图/i, "📋 规划本章章纲与意图…"],
    [/compos|组装|上下文/i, "🧩 组装章节上下文…"],
    [/audit|审计|连贯/i, "🔎 审计章节连贯性…"],
    [/revis|修订/i, "✏ 按审计意见修订…"],
    [/normaliz|字数/i, "📏 校准字数…"],
    [/state|状态/i, "💾 更新故事状态…"],
  ];
  for (const [re, label] of map) if (re.test(msg)) return label;
  return msg;
}

// 简单 logger，把阶段信息推进可选的 sink
function makeLogger(sink) {
  const mk = (prefix) => ({
    info: (m) => sink?.({ level: "info", msg: `${prefix}${m}` }),
    warn: (m) => sink?.({ level: "warn", msg: `${prefix}${m}` }),
    error: (m) => sink?.({ level: "error", msg: `${prefix}${m}` }),
    child: (name) => mk(`[${name}] `),
  });
  return mk("");
}

// 构造一个 PipelineRunner（每次操作新建，注入本次的 externalContext / 流式回调）
function makeRunner({ externalContext, onDelta, onStage, reviewMode, onRequest } = {}) {
  return new PipelineRunner({
    client: makeClient(),
    model: MODEL,
    projectRoot: DATA_ROOT,
    modelOverrides: loadModelConfig(), // 分阶段模型（字符串=换模型，复用同一客户端）
    externalContext,
    chapterReviewMode: reviewMode ?? "manual", // 逐步交互：默认手动分步，由前端显式触发审计
    logger: makeLogger(onStage),
    onTextDelta: onDelta,
    onRequest, // 纯观测：把实际发给模型的 messages 冒出来（用于输入记录留存 prompt）
    onStreamProgress: onStage
      ? (p) => onStage({ level: "progress", msg: `streaming ${Math.round(p.elapsedMs / 1000)}s ${p.totalChars}字`, chars: p.totalChars })
      : undefined,
  });
}

// ---------- 工具 ----------
const slug = (t) => t.trim().replace(/[\/\\:*?"<>|]/g, "").replace(/\s+/g, "-").slice(0, 60) || "book";

async function readFoundation(bookId) {
  const base = join(DATA_ROOT, "books", bookId, "story");
  const pick = async (rel) => { try { return await readFile(join(base, rel), "utf8"); } catch { return ""; } };
  return {
    story_frame: await pick("outline/story_frame.md"),
    volume_map: await pick("outline/volume_map.md"),
    book_rules: await pick("book_rules.md"),
    pending_hooks: await pick("pending_hooks.md"),
    style_guide: await pick("style_guide.md"),
    roles: await readRoles(bookId),
  };
}
// ===== 网游人物属性面板：存储 / 默认 / 更新 =====
const PANEL_PATH = (bookId) => join(DATA_ROOT, "books", bookId, "story", "character-panel.json");
function defaultPanel(book) {
  return {
    nickname: "", level: 1,
    attributes: { 力量: 0, 敏捷: 0, 智力: 0, 体质: 0, 防御: 0, 物理攻击力: 0, 法术攻击力: 0, 法力值: 0, 血量: 0 },
    equipment: [], // [{name, effect}]
    skills: [],    // [{name, effect}]
    updatedAtChapter: 0,
  };
}
// 该书是否启用人物面板（按题材设置里的 panel 标志，或已存在面板文件）
function panelEnabled(book) { return !!book && (panelGenreSet().has(book.genre) || existsSync(PANEL_PATH(book.id))); }
async function readPanel(bookId, book) {
  try { return JSON.parse(await readFile(PANEL_PATH(bookId), "utf8")); } catch { return defaultPanel(book || { id: bookId }); }
}
async function writePanel(bookId, panel) {
  await writeFile(PANEL_PATH(bookId), JSON.stringify(panel, null, 2), "utf8");
}
function panelToText(p) {
  if (!p) return "";
  const a = p.attributes || {};
  const attrs = Object.entries(a).map(([k, v]) => `  ${k}：${v}`).join("\n");
  const eq = (p.equipment || []).map((e) => `  【${e.name}】${e.effect || ""}`).join("\n") || "  （无）";
  const sk = (p.skills || []).map((e) => `  【${e.name}】${e.effect || ""}`).join("\n") || "  （无）";
  return `人物昵称：【${p.nickname || "（待定）"}】\n人物等级：lv${p.level ?? 1}\n人物属性：\n${attrs}\n装备：\n${eq}\n技能：\n${sk}`;
}
// 用 LLM 从本章正文 + 当前面板，产出更新后的面板 JSON
function buildPanelUpdatePrompt(panel, chapterContent) {
  const sys = skillPrompt("人物面板更新");
  const user = `【当前人物面板 JSON】\n${JSON.stringify(panel, null, 2)}\n\n【本章正文】\n${(chapterContent || "").slice(0, 8000)}\n\n请直接输出更新后的人物面板 JSON（只要 JSON 本身）。`;
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}
function parsePanelJson(raw, fallback) {
  try {
    let s = (raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    const p = JSON.parse(s);
    // 合并进 fallback，保证字段齐全
    return {
      nickname: p.nickname ?? fallback.nickname ?? "",
      level: p.level ?? fallback.level ?? 1,
      attributes: { ...fallback.attributes, ...(p.attributes || {}) },
      equipment: Array.isArray(p.equipment) ? p.equipment : (fallback.equipment || []),
      skills: Array.isArray(p.skills) ? p.skills : (fallback.skills || []),
    };
  } catch { return null; }
}
// 提交：读第 n 章最终正文，让 LLM 更新面板并保存（本章通过后调用）
async function commitPanel(bookId, n) {
  const book = await new StateManager(DATA_ROOT).loadBookConfig(bookId);
  if (!panelEnabled(book)) return null;
  const cur = await readPanel(bookId, book);
  const ch = await readChapter(bookId, n);
  if (!ch) return cur;
  const messages = buildPanelUpdatePrompt(cur, stripChapterStruct(ch.content));
  const model = loadModelConfig()["panel-updater"] || loadLLMConfig().fastModel;
  const resp = await chatCompletion(makeClient(), model, messages, { temperature: 0.2 });
  const updated = parsePanelJson(resp?.content ?? "", cur);
  if (!updated) return cur;
  updated.updatedAtChapter = n;
  await writePanel(bookId, updated);
  return updated;
}

// 各设定分节 → 对应文件相对路径（供编辑保存）
const FOUNDATION_SECTION_PATH = {
  story_frame: "outline/story_frame.md",
  volume_map: "outline/volume_map.md",
  book_rules: "book_rules.md",
  pending_hooks: "pending_hooks.md",
  style_guide: "style_guide.md",
};
async function readRoles(bookId) {
  const rolesDir = join(DATA_ROOT, "books", bookId, "story", "roles");
  const out = [];
  for (const sub of ["主要角色", "次要角色"]) {
    const d = join(rolesDir, sub);
    try {
      for (const f of await readdir(d)) {
        if (f.endsWith(".md")) out.push({ tier: sub, name: f.replace(/\.md$/, ""), content: await readFile(join(d, f), "utf8") });
      }
    } catch { /* none */ }
  }
  return out;
}
async function readChapter(bookId, n) {
  const dir = join(DATA_ROOT, "books", bookId, "chapters");
  try {
    const files = await readdir(dir);
    const pad = String(n).padStart(4, "0");
    const f = files.find((x) => x.startsWith(pad) && x.endsWith(".md"));
    if (f) return { title: f.slice(5).replace(/\.md$/, ""), content: await readFile(join(dir, f), "utf8") };
  } catch { /* none */ }
  return null;
}
async function chapterCount(bookId) {
  const idx = join(DATA_ROOT, "books", bookId, "chapters", "index.json");
  try { const a = JSON.parse(await readFile(idx, "utf8")); return a.length ? Math.max(...a.map((c) => c.number)) : 0; }
  catch { return 0; }
}

// ---------- 近 N 章章纲：生成 / 解析 / 存取 / 注入 ----------
const OUTLINE_FILE = (bookId) => join(DATA_ROOT, "books", bookId, "story", "chapter-outline.json");
async function loadChapterOutlines(bookId) {
  try { return JSON.parse(await readFile(OUTLINE_FILE(bookId), "utf8")); } catch { return []; }
}
async function saveChapterOutlines(bookId, outlines) {
  await writeFile(OUTLINE_FILE(bookId), JSON.stringify(outlines, null, 2), "utf8");
}
// 用 planner 阶段配置的模型，基于 foundation 生成 startN..startN+count-1 章的章纲
function buildOutlinePrompt(foundation, book, startN, count, feedback, prev, recentText) {
  const rolesTxt = (foundation.roles || []).map((r) => `【${r.tier}】${r.name}`).join("、");
  const isScript = book.kind === "script";
  const sys = skillPrompt(isScript ? "分场大纲生成" : "章纲生成", { count, startN });
  const custom = loadCustomSkillsBundle(DATA_ROOT);
  const fmt = isScript
    ? `严格按以下格式输出，不要有多余文字：
=== 第N场 ===
标题：<不超过12字>
一句话：<本场核心戏剧事件>
梗概：<3-5句，含场景地点/冲突/对白重心/场末钩子>
（每场一个 === 第N场 === 块，共 ${count} 场，从第 ${startN} 场开始）`
    : `严格按以下格式输出，不要有多余文字：
=== 第N章 ===
标题：<不超过12字>
一句话：<本章核心事件，一句话>
梗概：<3-5句，含场景/冲突/转折/章末钩子>
（每章一个 === 第N章 === 块，共 ${count} 章，从第 ${startN} 章开始）`;
  const unit = isScript ? "场" : "章";
  const user = `# 作品\n${book.title}（${book.genre}｜${isScript ? "剧本" : "长篇"}｜目标${book.targetChapters}${unit}）

# 故事框架
${foundation.story_frame || "(空)"}

# ${isScript ? "幕场结构" : "卷纲 / OKR"}
${foundation.volume_map || "(空)"}

# 角色
${rolesTxt || "(空)"}

# 设定规则
${foundation.book_rules || "(空)"}
${prev ? `\n# 已确认的前序${unit}纲（保持连贯，不要重复）\n${prev}` : ""}
${recentText ? `\n# 前文摘录\n${recentText}` : ""}
${custom ? `\n${custom}` : ""}
${feedback ? `\n# 用户修改意见（务必执行）\n${feedback}` : ""}

请为第 ${startN} 到第 ${startN + count - 1} ${unit}生成大纲。\n\n${fmt}`;
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}
function parseOutlines(raw) {
  // 兼容「第N章」与剧本「第N场」
  const blocks = raw.split(/===\s*第\s*(\d+)\s*(?:章|场)\s*===/).slice(1);
  const out = [];
  for (let i = 0; i < blocks.length; i += 2) {
    const n = Number(blocks[i]);
    const body = blocks[i + 1] || "";
    const title = (body.match(/标题[：:]\s*(.+)/) || [])[1]?.trim() || "";
    const summary = (body.match(/一句话[：:]\s*(.+)/) || [])[1]?.trim() || "";
    const detail = (body.match(/梗概[：:]\s*([\s\S]*?)(?=\n\s*(?:标题|一句话|===)|$)/) || [])[1]?.trim() || "";
    out.push({ n, title, summary, detail });
  }
  return out;
}
async function generateOutlines(bookId, startN, count, feedback, onDelta) {
  const book = await new StateManager(DATA_ROOT).loadBookConfig(bookId);
  const foundation = await readFoundation(bookId);
  const prevAll = await loadChapterOutlines(bookId);
  const prev = prevAll.filter((o) => o.n < startN).map((o) => `第${o.n}章 ${o.title}：${o.summary}`).join("\n");
  // 前文承接：取新组之前最多 5 章的正文（每章截断，控制 token）
  const recent = [];
  for (let i = Math.max(1, startN - 5); i < startN; i++) {
    const ch = await readChapter(bookId, i);
    if (ch) recent.push(`【第${i}章 ${ch.title}】\n${stripChapterStruct(ch.content).slice(0, 1600)}`);
  }
  const recentText = recent.join("\n\n");
  const messages = buildOutlinePrompt(foundation, book, startN, count, feedback, prev, recentText);
  const model = loadModelConfig().planner || MODEL;
  const resp = await chatCompletion(makeClient(), model, messages, { temperature: 0.7, onTextDelta: onDelta });
  const raw = resp?.content ?? resp?.text ?? "";
  return { raw, outlines: parseOutlines(raw) };
}
// ===== 大纲（章纲）结构审计 + 修订（你提供的 prompt，输出对齐生成格式）=====
function buildOutlineAuditPrompt(foundation, book, startN, endN, prevOutlines, groupOutlines, recentText) {
  const sys = skillPrompt("章纲结构审计", { count: endN - startN + 1, startN, endN });
  const olText = groupOutlines.map((o) => `第${o.n}章 ${o.title}\n一句话：${o.summary}\n梗概：${o.detail}`).join("\n\n");
  const user = `【小说总纲】\n${foundation.story_frame || "(空)"}\n\n【当前分卷大纲】\n${foundation.volume_map || "(空)"}\n\n【当前审查范围】第 ${startN}-${endN} 章（全书目标 ${book.targetChapters} 章）\n\n【前文上下文】\n${prevOutlines || "(无)"}\n${recentText ? `\n【前文章节正文】\n${recentText}` : ""}\n\n【当前${endN - startN + 1}章小纲】\n${olText}\n\n请审查并按格式输出。`;
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}
function buildOutlineRevisePrompt(foundation, book, startN, endN, groupOutlines, auditText, count) {
  const sys = skillPrompt("章纲修订", { count, startN, endN });
  const olText = groupOutlines.map((o) => `第${o.n}章 ${o.title}\n一句话：${o.summary}\n梗概：${o.detail}`).join("\n\n");
  const user = `【小说总纲】\n${foundation.story_frame || "(空)"}\n\n【当前分卷大纲】\n${foundation.volume_map || "(空)"}\n\n【当前范围】第 ${startN}-${endN} 章\n\n【原始${count}章小纲】\n${olText}\n\n【结构审计意见】\n${auditText}\n\n请按规定格式输出修订后的 ${count} 章小纲。`;
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}
// 解析审计文本：是否合格 + 严重/警告条数
function parseOutlineAudit(raw) {
  const verdictLine = (raw.match(/【总体判断】([^\n]*)/) || [])[1] || "";
  const severe = (raw.match(/严重/g) || []).length;
  // 合格判定：总体判断含"合格"且不含"不合格/大修/严重偏离"
  const passed = /合格/.test(verdictLine) && !/不合格|大修|严重偏离/.test(verdictLine);
  return { passed, verdictLine: verdictLine.trim(), severeMentions: severe, raw };
}
async function auditOutlineGroup(bookId, startN, count, onDelta) {
  const book = await new StateManager(DATA_ROOT).loadBookConfig(bookId);
  const foundation = await readFoundation(bookId);
  const endN = startN + count - 1;
  const all = await loadChapterOutlines(bookId);
  const group = all.filter((o) => o.n >= startN && o.n <= endN);
  const prevOutlines = all.filter((o) => o.n < startN).map((o) => `第${o.n}章 ${o.title}：${o.summary}`).join("\n");
  const recent = [];
  for (let i = Math.max(1, startN - 5); i < startN; i++) { const ch = await readChapter(bookId, i); if (ch) recent.push(`【第${i}章】\n${stripChapterStruct(ch.content).slice(0, 1200)}`); }
  const messages = buildOutlineAuditPrompt(foundation, book, startN, endN, prevOutlines, group, recent.join("\n\n"));
  const model = loadModelConfig()["outline-auditor"] || loadLLMConfig().strongModel;
  const resp = await chatCompletion(makeClient(), model, messages, { temperature: 0.4, onTextDelta: onDelta });
  return parseOutlineAudit(resp?.content ?? "");
}
async function reviseOutlineGroup(bookId, startN, count, auditText, onDelta) {
  const book = await new StateManager(DATA_ROOT).loadBookConfig(bookId);
  const foundation = await readFoundation(bookId);
  const endN = startN + count - 1;
  const all = await loadChapterOutlines(bookId);
  const group = all.filter((o) => o.n >= startN && o.n <= endN);
  const messages = buildOutlineRevisePrompt(foundation, book, startN, endN, group, auditText, count);
  const model = loadModelConfig()["outline-reviser"] || loadLLMConfig().strongModel;
  const resp = await chatCompletion(makeClient(), model, messages, { temperature: 0.6, onTextDelta: onDelta });
  const revised = parseOutlines(resp?.content ?? "");
  if (revised.length) {
    const prev = all.filter((o) => o.n < startN || o.n > endN);
    await saveChapterOutlines(bookId, [...prev, ...revised].sort((a, b) => a.n - b.n));
  }
  return revised;
}

// 去掉章节正文里的结构块标记，只留散文
function stripChapterStruct(md) {
  let s = md || "";
  const cc = s.match(/===\s*CHAPTER_CONTENT\s*===\s*([\s\S]*)$/);
  if (cc) s = cc[1];
  return s.replace(/===\s*(PRE_WRITE_CHECK|CHAPTER_TITLE|CHAPTER_CONTENT)\s*===/g, "").trim();
}

// 单次审计（带阶段回调），返回 AuditResult（含 chapterNumber）
async function runner_auditOnce(bookId, chapterNumber, onMsg) {
  const runner = makeRunner({ onStage: (s) => onMsg?.(friendlyStage(s.msg || "")) });
  return runner.auditDraft(bookId, chapterNumber);
}

// ===== 后台自动连写任务（不依赖页面连接，关掉页面也继续）=====
const autoJobs = new Map(); // bookId -> { running, stop, current, msg, error, done, startedAt, lastProgressAt, completed }
function prog(job, msg) { job.msg = msg; job.lastProgressAt = Date.now(); }
async function runAutoLoop(bookId, job) {
  try {
    const state = new StateManager(DATA_ROOT);
    const book = await state.loadBookConfig(bookId);
    const target = book.targetChapters ?? 200;
    while (!job.stop && (await chapterCount(bookId)) < target) {
      const targetN = (await chapterCount(bookId)) + 1;
      job.current = targetN;
      // 进入新一组（6/11/16…）且该组章纲缺失 → 先生成+审计该组
      if (targetN > 5 && targetN % 5 === 1) {
        const outs = await loadChapterOutlines(bookId);
        if (!outs.some((o) => o.n === targetN)) {
          prog(job, `📋 生成并审计第 ${targetN}-${targetN + 4} 章章纲…`);
          const { outlines } = await generateOutlines(bookId, targetN, 5, "");
          const prev = (await loadChapterOutlines(bookId)).filter((o) => o.n < targetN || o.n >= targetN + 5);
          await saveChapterOutlines(bookId, [...prev, ...outlines].sort((a, b) => a.n - b.n));
          let r2 = 0, aud;
          const maxOl = loadWritingConfig().outlineAuditMaxRounds || 2;
          while (r2 < maxOl && !job.stop) { r2++; aud = await auditOutlineGroup(bookId, targetN, 5); prog(job, `🔎 章纲第 ${r2} 轮审计：${aud.passed ? "合格" : "修订中"}`); if (aud.passed) break; await reviseOutlineGroup(bookId, targetN, 5, aud.raw); }
          const all2 = await loadChapterOutlines(bookId);
          all2.forEach((o) => { if (o.n >= targetN && o.n < targetN + 5) { o.audited = true; o.confirmed = true; } });
          await saveChapterOutlines(bookId, all2);
        }
      }
      if (job.stop) break;
      const ol = (await loadChapterOutlines(bookId)).find((o) => o.n === targetN);
      const olCtx = ol ? `【本章章纲（用户已确认，须遵循）】\n第${ol.n}章 ${ol.title}\n核心事件：${ol.summary}\n梗概：${ol.detail}` : undefined;
      prog(job, `✍ 自动写作第 ${targetN} 章${ol ? "（按已确认章纲）" : ""}…`);
      const runner = makeRunner({ reviewMode: "auto", externalContext: olCtx, onStage: (s) => { prog(job, friendlyStage(s.msg || "")); } });
      const r = await runner.writeNextChapter(bookId);
      if (job.stop) break;
      await commitPanel(bookId, r.chapterNumber).catch(() => {}); // 网游面板：本章后更新
      prog(job, `已完成第 ${r.chapterNumber} 章（${r.status}）`);
      if (r.status === "state-degraded") { job.error = `第${r.chapterNumber}章 state 降级，已停止`; break; }
    }
    const finalCount = await chapterCount(bookId);
    job.completed = finalCount >= target;
    prog(job, job.error ? job.msg : (job.stop ? "已手动停止。" : "🎉 全书写作完成。"));
  } catch (e) {
    job.error = String(e?.message ?? e);
  } finally {
    job.running = false; job.done = true; job.endedAt = Date.now();
  }
}

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function sseInit(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // 禁止任何中间层缓冲，保证 token 实时到达
  });
  res.flushHeaders?.();
  res.write(": connected\n\n"); // 立即冲刷一帧，建立流
}

// ---------- 信息留存：记录用户所有输入（初始设定/设定反馈/章节意见）----------
let _logQueue = Promise.resolve(); // 串行化追加，避免并发 append 交错
function logInput(bookId, entry) {
  if (!bookId) return _logQueue;
  _logQueue = _logQueue.then(async () => {
    const dir = join(DATA_ROOT, "books", bookId);
    await mkdir(dir, { recursive: true }).catch(() => {});
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    await writeFile(join(dir, "user-inputs.jsonl"), line, { flag: "a" }).catch(() => {});
  }).catch(() => {});
  return _logQueue;
}
async function readInputs(bookId) {
  try {
    const raw = await readFile(join(DATA_ROOT, "books", bookId, "user-inputs.jsonl"), "utf8");
    return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    // ---- 静态资源 ----
    if (req.method === "GET" && (path === "/" || !path.startsWith("/api"))) {
      const file = path === "/" ? "index.html" : path.slice(1);
      const full = join(PUBLIC, file);
      if (existsSync(full)) {
        res.writeHead(200, { "Content-Type": MIME[extname(full)] ?? "application/octet-stream" });
        res.end(await readFile(full));
        return;
      }
      res.writeHead(404); res.end("not found"); return;
    }

    // ---- 建书 + 生成基础设定（大纲/世界观/人设/伏笔）----
    if (req.method === "POST" && path === "/api/foundation") {
      const b = await body(req);
      const { kind = "longform", title, genre = "other", targetChapters = 200, chapterWordCount = 3000, settings = "" } = b;
      if (!title) return sendJson(res, 400, { error: "缺少标题" });
      const bookId = slug(title);
      await mkdir(join(DATA_ROOT, "books"), { recursive: true });
      // 已存在则先清掉（重来）
      await rm(join(DATA_ROOT, "books", bookId), { recursive: true, force: true }).catch(() => {});
      const now = new Date().toISOString();
      const bookConfig = {
        id: bookId, title, platform: "tomato", genre, kind,
        status: "outlining", targetChapters, chapterWordCount, language: "zh",
        createdAt: now, updatedAt: now,
      };
      await logInput(bookId, { type: "初始设定", text: `【${title}｜${genre}｜${targetChapters}章×${chapterWordCount}字】\n${settings}` });
      sseInit(res);
      let aborted = false;
      req.on("close", () => { aborted = true; });
      try {
        // 建书时把实际发给模型的 prompt 留存到输入记录（按 agent 分条）+ 实时进度反馈
        let reqSeq = 0;
        const onRequest = ({ agent, messages }) => {
          reqSeq += 1;
          const text = messages.map((m) => `〖${m.role}〗\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n\n");
          logInput(bookId, { type: `建书Prompt·${agent}·#${reqSeq}`, text }).catch(() => {});
          if (!aborted) sseSend(res, "stage", { msg: `📡 已向模型发送「${friendlyAgent(agent)}」请求，等待生成…` });
        };
        const onStage = (s) => { if (!aborted && s?.msg) sseSend(res, "stage", { msg: friendlyStage(s.msg) }); };
        sseSend(res, "stage", { msg: "📖 正在初始化书籍与创作骨架…" });
        const runner = makeRunner({ externalContext: settings, onRequest, onStage });
        await runner.initBook(bookConfig);
        if (aborted) return;
        const foundation = await readFoundation(bookId);
        sseSend(res, "done", { bookId, kind, foundation });
        res.end();
      } catch (e) {
        if (!aborted) { sseSend(res, "error", { code: 1001, message: String(e?.message ?? e) }); res.end(); }
      }
      return;
    }

    // ---- 修订基础设定（用户反馈重生成）----
    if (req.method === "POST" && path === "/api/foundation/revise") {
      const { bookId, feedback } = await body(req);
      if (!bookId || !feedback) return sendJson(res, 400, { error: "缺少 bookId 或反馈" });
      await logInput(bookId, { type: "设定修订意见", text: feedback });
      try {
        const runner = makeRunner({});
        await runner.reviseFoundation(bookId, feedback);
        return sendJson(res, 200, { bookId, foundation: await readFoundation(bookId) });
      } catch (e) {
        return sendJson(res, 500, { code: 1006, error: String(e?.message ?? e) });
      }
    }

    // ---- 生成近 N 章章纲（POST + SSE 流式）----
    if (req.method === "POST" && path === "/api/chapter-outline") {
      const { bookId, startN = 1, count = 5, feedback } = await body(req);
      if (!bookId) { res.writeHead(400); res.end("no bookId"); return; }
      if (feedback) await logInput(bookId, { type: `章纲修改意见·第${startN}起`, text: feedback });
      sseInit(res);
      let aborted = false;
      req.on("close", () => { aborted = true; });
      try {
        sseSend(res, "stage", { msg: `正在规划第 ${startN}-${startN + count - 1} 章章纲…` });
        const { outlines } = await generateOutlines(bookId, startN, count,
          feedback, (t) => { if (!aborted) sseSend(res, "delta", { t }); });
        if (aborted) return;
        // 合并保存：替换本次范围内的章纲
        const prev = (await loadChapterOutlines(bookId)).filter((o) => o.n < startN || o.n >= startN + count);
        const merged = [...prev, ...outlines].sort((a, b) => a.n - b.n);
        await saveChapterOutlines(bookId, merged);
        sseSend(res, "done", { outlines });
        res.end();
      } catch (e) {
        if (!aborted) { sseSend(res, "error", { code: 1007, message: String(e?.message ?? e) }); res.end(); }
      }
      return;
    }
    // ---- 生成 + 审计下一组章纲（SSE）：生成→审计→不合格则修订→重审→循环到合格 ----
    if (req.method === "POST" && path === "/api/outline-audit") {
      const { bookId, startN, count = 5, markDone = false } = await body(req);
      if (!bookId || !startN) { res.writeHead(400); res.end("no bookId/startN"); return; }
      sseInit(res);
      let aborted = false;
      req.on("close", () => { aborted = true; });
      const MAX = loadWritingConfig().outlineAuditMaxRounds || 2;
      try {
        // 1) 若该组还没有章纲，先生成
        const existing = await loadChapterOutlines(bookId);
        if (!existing.some((o) => o.n === startN)) {
          sseSend(res, "stage", { msg: `📋 正在生成第 ${startN}-${startN + count - 1} 章章纲…` });
          const { outlines } = await generateOutlines(bookId, startN, count, "", (t) => !aborted && sseSend(res, "delta", { t }));
          const prev = (await loadChapterOutlines(bookId)).filter((o) => o.n < startN || o.n >= startN + count);
          await saveChapterOutlines(bookId, [...prev, ...outlines].sort((a, b) => a.n - b.n));
          if (aborted) return;
        }
        // 2) 审计 → 修订 循环
        let round = 0, audit;
        while (round < MAX && !aborted) {
          round += 1;
          sseSend(res, "stage", { msg: `🔎 第 ${round} 轮章纲审计中…` });
          audit = await auditOutlineGroup(bookId, startN, count, (t) => !aborted && sseSend(res, "delta", { t }));
          if (aborted) return;
          sseSend(res, "audit", { round, passed: audit.passed, verdict: audit.verdictLine, raw: audit.raw });
          if (audit.passed) break;
          sseSend(res, "stage", { msg: `✏ 章纲不合格，按审计意见修订中（第 ${round} 次）…` });
          await reviseOutlineGroup(bookId, startN, count, audit.raw, (t) => !aborted && sseSend(res, "delta", { t }));
          if (aborted) return;
        }
        // 标记该组审计状态；仅在"确认"时(markDone)标 confirmed（供项目视图判定"组末已过大纲"）
        const allOut = await loadChapterOutlines(bookId);
        allOut.forEach((o) => { if (o.n >= startN && o.n < startN + count) { o.audited = true; if (markDone) o.confirmed = true; } });
        await saveChapterOutlines(bookId, allOut);
        const finalOutlines = allOut.filter((o) => o.n >= startN && o.n < startN + count);
        sseSend(res, "done", { startN, count, passed: !!audit?.passed, rounds: round, outlines: finalOutlines });
        res.end();
      } catch (e) {
        if (!aborted) { sseSend(res, "error", { code: 1009, message: String(e?.message ?? e) }); res.end(); }
      }
      return;
    }

    // ---- 保存用户编辑后的章纲 ----
    if (req.method === "POST" && path === "/api/chapter-outline/save") {
      const { bookId, outlines } = await body(req);
      if (!bookId || !Array.isArray(outlines)) return sendJson(res, 400, { error: "参数错误" });
      const merged = [...outlines].sort((a, b) => a.n - b.n);
      await saveChapterOutlines(bookId, merged);
      await logInput(bookId, { type: "确认章纲", text: merged.map((o) => `第${o.n}章 ${o.title}：${o.summary}`).join("\n") });
      return sendJson(res, 200, { ok: true, outlines: merged });
    }
    // ---- 读取已存章纲 ----
    if (req.method === "GET" && path === "/api/chapter-outline") {
      return sendJson(res, 200, { outlines: await loadChapterOutlines(url.searchParams.get("bookId")) });
    }

    // ---- 流式写作：写下一章草稿（POST + SSE，正文 token 实时推送）----
    // 用 POST 而非 GET：context 可能包含整章正文（几千字），放 URL 会超长导致连接失败。
    if (req.method === "POST" && path === "/api/write") {
      const { bookId, context, rewrite, note } = await body(req);
      if (!bookId) { res.writeHead(400); res.end("no bookId"); return; }
      if (note) await logInput(bookId, { type: rewrite ? "重写/修订章节" : "写作指令", text: note });
      if (rewrite) { const cur = await chapterCount(bookId); if (cur > 0) await removeChapter(bookId, cur).catch(() => {}); }
      // 注入用户已确认的本章章纲，作为写手/规划师的直接章节指令
      const targetN = (await chapterCount(bookId)) + 1;
      const outline = (await loadChapterOutlines(bookId)).find((o) => o.n === targetN);
      const outlineNote = outline
        ? `【本章章纲（用户已确认，须遵循）】\n第${outline.n}章 ${outline.title}\n核心事件：${outline.summary}\n梗概：${outline.detail}`
        : "";
      // 网游面板：注入当前面板，保证数值连续；每 5 章要求正文里展示一次
      let panelNote = "";
      try {
        const bookCfg = await new StateManager(DATA_ROOT).loadBookConfig(bookId);
        if (panelEnabled(bookCfg)) {
          const panel = await readPanel(bookId, bookCfg);
          const showInProse = targetN % 5 === 0;
          panelNote = `【当前人物属性面板（本章涉及的数值变化必须与此连续、合理）】\n${panelToText(panel)}\n【面板要求】本章结束后系统会依据正文自动更新人物面板。${showInProse ? "★本章（第" + targetN + "章，5的倍数）必须在正文合适处自然地完整展示一次人物面板，方便读者了解当前养成进度。" : "本章无需在正文中罗列面板。"}`;
        }
      } catch { /* 无 book 配置则跳过 */ }
      const fullContext = [panelNote, outlineNote, context].filter(Boolean).join("\n\n") || undefined;
      sseInit(res);
      let aborted = false;
      req.on("close", () => { aborted = true; });
      const runner = makeRunner({
        externalContext: fullContext,
        onDelta: (t) => { if (!aborted) sseSend(res, "delta", { t }); },
        onStage: (s) => { if (!aborted) sseSend(res, "stage", s); },
        reviewMode: "manual",
      });
      try {
        const result = await runner.writeDraft(bookId, fullContext);
        if (aborted) { const n = await chapterCount(bookId); await removeChapter(bookId, n).catch(() => {}); return; }
        const ch = await readChapter(bookId, result.chapterNumber);
        sseSend(res, "done", { chapterNumber: result.chapterNumber, title: ch?.title ?? result.title, content: ch?.content ?? "" });
        res.end();
      } catch (e) {
        if (!aborted) { sseSend(res, "error", { code: 1002, message: String(e?.message ?? e) }); res.end(); }
      }
      return;
    }

    // ---- 审计当前草稿（返回问题清单；不改正文）----
    if (req.method === "POST" && path === "/api/audit") {
      const { bookId, chapterNumber } = await body(req);
      try {
        const runner = makeRunner({});
        const audit = await runner.auditDraft(bookId, chapterNumber);
        return sendJson(res, 200, { audit });
      } catch (e) {
        return sendJson(res, 500, { code: 1003, error: String(e?.message ?? e) });
      }
    }

    // ---- 读取输入记录（信息留存）----
    if (req.method === "GET" && path === "/api/logs") {
      return sendJson(res, 200, { inputs: await readInputs(url.searchParams.get("bookId")) });
    }
    // ---- 读取当前书的基础设定（右侧卡片用）----
    if (req.method === "GET" && path === "/api/foundation") {
      const bookId = url.searchParams.get("bookId");
      return sendJson(res, 200, { foundation: await readFoundation(bookId) });
    }
    // ---- 读取某章的章纲（Planner 生成的 chapter_memo）----
    if (req.method === "GET" && path === "/api/plan") {
      const bookId = url.searchParams.get("bookId");
      const n = Number(url.searchParams.get("n"));
      const pad = String(n).padStart(4, "0");
      let memo = "";
      try {
        const raw = await readFile(join(DATA_ROOT, "books", bookId, "story", "runtime", `chapter-${pad}.plan.md`), "utf8");
        memo = String(raw || "").trim();
      } catch { /* 尚未生成 */ }
      return sendJson(res, 200, { plan: memo });
    }

    // ---- 自动审改闭环：审计→按等级修订→重新审计→循环到通过（最多3轮），全程推送 ----
    if (req.method === "POST" && path === "/api/auto-review") {
      const { bookId, chapter } = await body(req);
      const chapterNumber = chapter ? Number(chapter) : undefined;
      if (!bookId) { res.writeHead(400); res.end("no bookId"); return; }
      sseInit(res);
      let aborted = false;
      req.on("close", () => { aborted = true; });
      const MAX_ROUNDS = loadWritingConfig().autoReviewMaxRounds || 3;
      const packAudit = (a) => ({ passed: !!a.passed, score: a.score ?? null, summary: a.summary ?? "", issues: (a.issues || []).map((i) => (typeof i === "string" ? { severity: "问题", description: i } : { severity: i.severity, description: i.description })) });
      try {
        // 第 1 轮审计
        sseSend(res, "stage", { msg: "🔎 第 1 轮审计中（连贯性 / 设定一致性 / 节奏爽感）…" });
        let audit = await runner_auditOnce(bookId, chapterNumber, (m) => !aborted && sseSend(res, "stage", { msg: m }));
        if (aborted) return;
        sseSend(res, "audit", { round: 1, ...packAudit(audit) });
        let round = 1;
        while (!audit.passed && round < MAX_ROUNDS && !aborted) {
          round += 1;
          const n = (audit.issues || []).length;
          sseSend(res, "stage", { msg: `✏ 发现 ${n} 条问题，按等级自动修订中（第 ${round - 1} 次修订）…` });
          const reviser = makeRunner({
            onDelta: (t) => { if (!aborted) sseSend(res, "delta", { t }); },
            onStage: (s) => { if (!aborted) sseSend(res, "stage", { msg: friendlyStage(s.msg || "") }); },
          });
          await reviser.reviseDraft(bookId, chapterNumber);
          if (aborted) return;
          sseSend(res, "stage", { msg: `🔎 第 ${round} 轮审计中…` });
          audit = await runner_auditOnce(bookId, chapterNumber, (m) => !aborted && sseSend(res, "stage", { msg: m }));
          if (aborted) return;
          sseSend(res, "audit", { round, ...packAudit(audit) });
        }
        const ch = await readChapter(bookId, audit.chapterNumber ?? chapterNumber);
        sseSend(res, "done", {
          chapterNumber: audit.chapterNumber ?? chapterNumber,
          title: ch?.title, content: ch?.content ?? "",
          passed: !!audit.passed, rounds: round, finalAudit: packAudit(audit),
        });
        res.end();
      } catch (e) {
        if (!aborted) { sseSend(res, "error", { code: 1008, message: String(e?.message ?? e) }); res.end(); }
      }
      return;
    }

    // ---- 修订当前章（按审计问题自动改，POST + 流式）----
    if (req.method === "POST" && path === "/api/revise") {
      const { bookId, chapter } = await body(req);
      const chapterNumber = chapter ? Number(chapter) : undefined;
      if (!bookId) { res.writeHead(400); res.end("no bookId"); return; }
      sseInit(res);
      let aborted = false;
      req.on("close", () => { aborted = true; });
      const runner = makeRunner({
        onDelta: (t) => { if (!aborted) sseSend(res, "delta", { t }); },
        onStage: (s) => { if (!aborted) sseSend(res, "stage", s); },
      });
      try {
        const result = await runner.reviseDraft(bookId, chapterNumber);
        const ch = await readChapter(bookId, result.chapterNumber ?? chapterNumber);
        if (!aborted) { sseSend(res, "done", { chapterNumber: result.chapterNumber ?? chapterNumber, title: ch?.title, content: ch?.content ?? "", audit: result.auditResult }); res.end(); }
      } catch (e) {
        if (!aborted) { sseSend(res, "error", { code: 1004, message: String(e?.message ?? e) }); res.end(); }
      }
      return;
    }

    // ---- 读某章正文 ----
    if (req.method === "GET" && path === "/api/chapter") {
      const bookId = url.searchParams.get("bookId");
      const n = Number(url.searchParams.get("n"));
      return sendJson(res, 200, { chapter: await readChapter(bookId, n), total: await chapterCount(bookId) });
    }

    // ---- 自动完成：从下一章循环 writeNextChapter（auto审改）到 targetChapters（POST+SSE）----
    // ---- 自动连写：后台启动（不依赖页面连接，关掉页面也继续）----
    if (req.method === "POST" && path === "/api/auto/start") {
      const { bookId } = await body(req);
      if (!bookId) return sendJson(res, 400, { error: "no bookId" });
      const existing = autoJobs.get(bookId);
      if (existing && existing.running) return sendJson(res, 200, { ok: true, running: true, already: true });
      const job = { running: true, stop: false, current: await chapterCount(bookId) + 1, msg: "🚀 自动连写已启动…", error: null, done: false, completed: false, startedAt: Date.now(), lastProgressAt: Date.now() };
      autoJobs.set(bookId, job);
      runAutoLoop(bookId, job); // 不 await：后台跑
      return sendJson(res, 200, { ok: true, running: true });
    }
    // ---- 自动连写：查询状态（前端轮询）----
    if (req.method === "GET" && path === "/api/auto/status") {
      const bookId = url.searchParams.get("bookId");
      const job = autoJobs.get(bookId);
      const total = await chapterCount(bookId);
      let target = 0; try { target = (await new StateManager(DATA_ROOT).loadBookConfig(bookId)).targetChapters ?? 0; } catch { /* */ }
      if (!job) return sendJson(res, 200, { running: false, total, target, completed: target ? total >= target : false });
      const stalledSec = job.running ? Math.round((Date.now() - (job.lastProgressAt || job.startedAt)) / 1000) : 0;
      return sendJson(res, 200, { running: job.running, current: job.current, msg: job.msg, error: job.error, done: job.done, completed: !!job.completed, total, target, stalledSec });
    }
    // ---- 自动连写：停止 ----
    if (req.method === "POST" && path === "/api/auto/stop") {
      const { bookId } = await body(req);
      const job = autoJobs.get(bookId);
      if (job) job.stop = true;
      return sendJson(res, 200, { ok: true });
    }

    // ---- 覆盖某章正文（用于"使用审计前版本"回写、或手动编辑）----
    if (req.method === "POST" && path === "/api/set-chapter") {
      const { bookId, n, content } = await body(req);
      const dir = join(DATA_ROOT, "books", bookId, "chapters");
      const files = await readdir(dir).catch(() => []);
      const pad = String(n).padStart(4, "0");
      const f = files.find((x) => x.startsWith(pad) && x.endsWith(".md"));
      if (!f) return sendJson(res, 404, { error: "章节不存在" });
      await writeFile(join(dir, f), content, "utf8");
      return sendJson(res, 200, { ok: true });
    }

    // ---- 模型配置：读 ----
    if (req.method === "GET" && path === "/api/model-config") {
      return sendJson(res, 200, { stages: MODEL_STAGES, models: availableModels(), config: loadModelConfig() });
    }
    // ---- 模型配置：存 ----
    if (req.method === "POST" && path === "/api/model-config") {
      const { config } = await body(req);
      const dflt = defaultModelConfig();
      const valid = new Set(availableModels().map((m) => m.id));
      const clean = {};
      for (const s of MODEL_STAGES) {
        const v = config?.[s.key];
        clean[s.key] = valid.has(v) ? v : dflt[s.key];
      }
      await writeFile(MODEL_CONFIG_PATH, JSON.stringify(clean, null, 2), "utf8");
      return sendJson(res, 200, { ok: true, config: clean });
    }

    // ---- LLM 密钥/端点配置：读（密钥永远掩码，绝不明文返回）----
    if (req.method === "GET" && path === "/api/config") {
      const eff = loadLLMConfig();          // 含环境变量覆盖后的生效值
      const raw = loadLLMConfigRaw();       // 文件里的原始值（判断 key 来源）
      const k = eff.apiKey || "";
      const keyHint = k ? `${k.slice(0, 3)}****${k.slice(-2)}` : "";
      const keyFromEnv = !!(process.env.NOVEL_API_KEY || process.env.OPENAI_API_KEY);
      return sendJson(res, 200, {
        hasKey: !!k, keyHint, keyFromEnv,
        baseUrl: eff.baseUrl,
        models: eff.models,
        fastModel: eff.fastModel,
        strongModel: eff.strongModel,
        temperature: eff.temperature ?? 0.7,
        // 仅告知文件里是否已存密钥，不返回内容
        fileHasKey: !!raw.apiKey,
      });
    }
    // ---- LLM 密钥/端点配置：存（写入 data/config.json；apiKey 为空则保留原值，不清空）----
    if (req.method === "POST" && path === "/api/config") {
      const b = await body(req);
      const cur = loadLLMConfigRaw();
      const next = { ...cur };
      if (typeof b.baseUrl === "string" && b.baseUrl.trim()) next.baseUrl = b.baseUrl.trim();
      if (Array.isArray(b.models) && b.models.length) next.models = normModels(b.models);
      if (typeof b.fastModel === "string" && b.fastModel.trim()) next.fastModel = b.fastModel.trim();
      if (typeof b.strongModel === "string" && b.strongModel.trim()) next.strongModel = b.strongModel.trim();
      if (b.temperature != null && !Number.isNaN(Number(b.temperature))) next.temperature = Number(b.temperature);
      // 密钥：仅当传入非空字符串时更新；传 clearKey:true 才清空；否则保持原值（便于只改其它字段）
      if (typeof b.apiKey === "string" && b.apiKey.trim()) next.apiKey = b.apiKey.trim();
      else if (b.clearKey === true) next.apiKey = "";
      await mkdir(DATA_ROOT, { recursive: true }).catch(() => {});
      await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
      return sendJson(res, 200, { ok: true, hasKey: hasApiKey() });
    }
    // ---- 是否已就绪（前端进入时判断是否需要先去「设置」配置密钥）----
    if (req.method === "GET" && path === "/api/ready") {
      return sendJson(res, 200, { ready: hasApiKey() });
    }

    // ---- 题材设置：读 ----
    if (req.method === "GET" && path === "/api/genres") {
      return sendJson(res, 200, { genres: loadGenres() });
    }
    // ---- 题材设置：存 ----
    if (req.method === "POST" && path === "/api/genres") {
      const { genres } = await body(req);
      if (!Array.isArray(genres) || !genres.length) return sendJson(res, 400, { error: "题材列表不能为空" });
      const clean = genres.filter((g) => g && g.id).map((g) => ({ id: String(g.id).trim(), label: String(g.label || g.id).trim(), panel: !!g.panel }));
      await mkdir(DATA_ROOT, { recursive: true }).catch(() => {});
      await writeFile(GENRES_PATH, JSON.stringify(clean, null, 2), "utf8");
      return sendJson(res, 200, { ok: true, genres: clean });
    }

    // ---- 自动写作配置：读 ----
    if (req.method === "GET" && path === "/api/writing-config") {
      return sendJson(res, 200, { config: loadWritingConfig() });
    }
    // ---- 自动写作配置：存 ----
    if (req.method === "POST" && path === "/api/writing-config") {
      const { config } = await body(req);
      const cur = loadWritingConfig();
      const next = { ...cur };
      const num = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d; };
      if (config?.targetChapters != null) next.targetChapters = num(config.targetChapters, 1, 100000, cur.targetChapters);
      if (config?.chapterWordCount != null) next.chapterWordCount = num(config.chapterWordCount, 300, 20000, cur.chapterWordCount);
      if (config?.outlineAuditMaxRounds != null) next.outlineAuditMaxRounds = num(config.outlineAuditMaxRounds, 0, 5, cur.outlineAuditMaxRounds);
      if (config?.autoReviewMaxRounds != null) next.autoReviewMaxRounds = num(config.autoReviewMaxRounds, 1, 8, cur.autoReviewMaxRounds);
      await mkdir(DATA_ROOT, { recursive: true }).catch(() => {});
      await writeFile(WRITING_CFG_PATH, JSON.stringify(next, null, 2), "utf8");
      return sendJson(res, 200, { ok: true, config: next });
    }

    // ---- 技能：按组列出（含内置补种）----
    if (req.method === "GET" && path === "/api/skills") {
      await seedSkills();
      const groups = [];
      for (const g of SKILL_GROUPS) {
        let files = [];
        try { files = (await readdir(join(SKILLS_DIR, g.id))).filter((f) => f.endsWith(".md")).sort(); } catch { /* */ }
        groups.push({ id: g.id, label: g.label, skills: files.map((f) => f.replace(/\.md$/, "")) });
      }
      return sendJson(res, 200, { groups });
    }
    // ---- 技能：读单个 ----
    if (req.method === "GET" && path === "/api/skill") {
      const group = SKILL_GROUPS.some((g) => g.id === url.searchParams.get("group")) ? url.searchParams.get("group") : "custom";
      const name = safeSkillName(url.searchParams.get("name"));
      if (!name) return sendJson(res, 400, { error: "缺少名称" });
      let content = "";
      try { content = await readFile(skillFilePath(group, name), "utf8"); } catch { /* 新建 */ }
      const isBuiltin = !!DEFAULT_SKILLS[group]?.[name];
      return sendJson(res, 200, { group, name, content, builtin: isBuiltin, hasDefault: isBuiltin });
    }
    // ---- 技能：保存 ----
    if (req.method === "POST" && path === "/api/skill/save") {
      const { group: rawGroup, name, content } = await body(req);
      const group = SKILL_GROUPS.some((g) => g.id === rawGroup) ? rawGroup : "custom";
      const n = safeSkillName(name);
      if (!n) return sendJson(res, 400, { error: "名称非法" });
      await mkdir(join(SKILLS_DIR, group), { recursive: true }).catch(() => {});
      await writeFile(skillFilePath(group, n), content ?? "", "utf8");
      return sendJson(res, 200, { ok: true, group, name: n });
    }
    // ---- 技能：恢复默认（仅内置技能）----
    if (req.method === "POST" && path === "/api/skill/reset") {
      const { group, name } = await body(req);
      const dflt = DEFAULT_SKILLS[group]?.[safeSkillName(name)];
      if (dflt == null) return sendJson(res, 400, { error: "该技能没有内置默认" });
      await mkdir(join(SKILLS_DIR, group), { recursive: true }).catch(() => {});
      await writeFile(skillFilePath(group, name), dflt, "utf8");
      return sendJson(res, 200, { ok: true, content: dflt });
    }
    // ---- 技能：删除（内置技能删除后下次列出会恢复默认）----
    if (req.method === "POST" && path === "/api/skill/delete") {
      const { group: rawGroup, name } = await body(req);
      const group = SKILL_GROUPS.some((g) => g.id === rawGroup) ? rawGroup : "custom";
      const n = safeSkillName(name);
      if (!n) return sendJson(res, 400, { error: "名称非法" });
      await rm(skillFilePath(group, n), { force: true }).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    // ---- 保存编辑后的设定分节（世界观/卷纲/伏笔/规则/文风）----
    if (req.method === "POST" && path === "/api/foundation/save-section") {
      const { bookId, section, content } = await body(req);
      const rel = FOUNDATION_SECTION_PATH[section];
      if (!bookId || !rel) return sendJson(res, 400, { error: "参数错误" });
      await writeFile(join(DATA_ROOT, "books", bookId, "story", rel), content ?? "", "utf8");
      await logInput(bookId, { type: `编辑设定·${section}`, text: (content || "").slice(0, 200) + "…" });
      return sendJson(res, 200, { ok: true });
    }
    // ---- 保存编辑后的角色卡 ----
    if (req.method === "POST" && path === "/api/role/save") {
      const { bookId, tier, name, content } = await body(req);
      if (!bookId || !tier || !name) return sendJson(res, 400, { error: "参数错误" });
      const dir = join(DATA_ROOT, "books", bookId, "story", "roles", tier);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name}.md`), content ?? "", "utf8");
      return sendJson(res, 200, { ok: true });
    }
    // ---- 保存编辑后的章节正文 ----
    if (req.method === "POST" && path === "/api/chapter/save") {
      const { bookId, n, content } = await body(req);
      const dir = join(DATA_ROOT, "books", bookId, "chapters");
      const files = await readdir(dir).catch(() => []);
      const pad = String(n).padStart(4, "0");
      const f = files.find((x) => x.startsWith(pad) && x.endsWith(".md"));
      if (!f) return sendJson(res, 404, { error: "章节不存在" });
      await writeFile(join(dir, f), content, "utf8");
      return sendJson(res, 200, { ok: true });
    }

    // ---- 删除第 n 章（及其之后章节），回滚到上一节点 ----
    if (req.method === "POST" && path === "/api/chapter/delete") {
      const { bookId, n } = await body(req);
      if (!bookId || !n) return sendJson(res, 400, { error: "参数错误" });
      await removeChapter(bookId, Number(n));
      return sendJson(res, 200, { ok: true, total: await chapterCount(bookId) });
    }

    // ---- 人物面板：读取 ----
    if (req.method === "GET" && path === "/api/panel") {
      const bookId = url.searchParams.get("bookId");
      const book = await new StateManager(DATA_ROOT).loadBookConfig(bookId).catch(() => ({ id: bookId }));
      return sendJson(res, 200, { enabled: panelEnabled(book), panel: await readPanel(bookId, book) });
    }
    // ---- 人物面板：本章通过后提交更新（LLM 依据最终正文更新并保存）----
    if (req.method === "POST" && path === "/api/panel/commit") {
      const { bookId, n } = await body(req);
      if (!bookId || !n) return sendJson(res, 400, { error: "参数错误" });
      try { return sendJson(res, 200, { panel: await commitPanel(bookId, n) }); }
      catch (e) { return sendJson(res, 500, { code: 1010, error: String(e?.message ?? e) }); }
    }
    // ---- 人物面板：手动保存（用户编辑）----
    if (req.method === "POST" && path === "/api/panel/save") {
      const { bookId, panel } = await body(req);
      if (!bookId || !panel) return sendJson(res, 400, { error: "参数错误" });
      await writePanel(bookId, panel);
      return sendJson(res, 200, { ok: true });
    }

    // ---- 项目栏：列出所有书 ----
    if (req.method === "GET" && path === "/api/books") {
      const root = join(DATA_ROOT, "books");
      const out = [];
      for (const id of (await readdir(root).catch(() => []))) {
        try {
          const bj = JSON.parse(await readFile(join(root, id, "book.json"), "utf8"));
          const total = await chapterCount(id);
          const sf = join(root, id, "story", "outline", "story_frame.md");
          const hasFoundation = existsSync(sf) && (await stat(sf)).size > 0;
          out.push({ id, title: bj.title || id, genre: bj.genre, kind: bj.kind || "longform", total, hasFoundation, updatedAt: bj.updatedAt });
        } catch { /* 跳过损坏的 */ }
      }
      out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return sendJson(res, 200, { books: out });
    }
    // ---- 恢复某本书的全部进度（设定 + 章纲 + 已写章节）----
    if (req.method === "GET" && path === "/api/resume") {
      const bookId = url.searchParams.get("bookId");
      if (!bookId) return sendJson(res, 400, { error: "缺少 bookId" });
      try {
        const book = await new StateManager(DATA_ROOT).loadBookConfig(bookId);
        const foundation = await readFoundation(bookId);
        const outlines = await loadChapterOutlines(bookId);
        const total = await chapterCount(bookId);
        // 读章节状态（引擎 index.json 里 status: ready-for-review / audit-failed / draft…）
        let idx = [];
        try { idx = JSON.parse(await readFile(join(DATA_ROOT, "books", bookId, "chapters", "index.json"), "utf8")); } catch { /* */ }
        const statusOf = (n) => (idx.find((c) => c.number === n)?.status) || "draft";
        const chapters = [];
        for (let i = 1; i <= total; i++) {
          const c = await readChapter(bookId, i);
          if (c) chapters.push({ n: i, title: c.title, content: c.content, status: statusOf(i) });
        }
        return sendJson(res, 200, { book, foundation, outlines, total, chapters });
      } catch (e) {
        return sendJson(res, 500, { error: String(e?.message ?? e) });
      }
    }

    // ---- 状态 ----
    if (req.method === "GET" && path === "/api/state") {
      const bookId = url.searchParams.get("bookId");
      return sendJson(res, 200, { total: await chapterCount(bookId) });
    }

    res.writeHead(404); res.end("no route");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e?.message ?? e) });
    else try { res.end(); } catch { /* */ }
  }
});

// 删除第 n 章及其之后所有章（不能留空档），并回滚运行时状态到 n-1
async function removeChapter(bookId, n) {
  const dir = join(DATA_ROOT, "books", bookId, "chapters");
  const files = await readdir(dir).catch(() => []);
  for (const f of files) {
    const m = f.match(/^(\d{4})_.*\.md$/);
    if (m && Number(m[1]) >= n) await rm(join(dir, f), { force: true });
  }
  // 从索引移除 >= n
  const idxPath = join(dir, "index.json");
  try {
    const idx = JSON.parse(await readFile(idxPath, "utf8"));
    await writeFile(idxPath, JSON.stringify(idx.filter((c) => c.number < n), null, 2), "utf8");
  } catch { /* */ }
  // 同步回滚引擎运行时状态，避免 current_state 超前于 manifest（报错 1002）
  await rollbackRuntimeState(bookId, n - 1);
}
// 把运行时状态回滚到"已完成到第 keep 章"的一致态（keep=0 表示尚未写任何章）
async function rollbackRuntimeState(bookId, keep) {
  const sdir = join(DATA_ROOT, "books", bookId, "story", "state");
  const setJson = async (file, mut) => {
    const p = join(sdir, file);
    try {
      const obj = JSON.parse(await readFile(p, "utf8"));
      mut(obj);
      await writeFile(p, JSON.stringify(obj, null, 2), "utf8");
    } catch { /* 文件不存在则跳过 */ }
  };
  await setJson("current_state.json", (o) => { if ((o.chapter ?? 0) > keep) o.chapter = keep; });
  await setJson("manifest.json", (o) => { if ((o.lastAppliedChapter ?? 0) > keep) o.lastAppliedChapter = keep; });
  await setJson("chapter_summaries.json", (o) => { if (Array.isArray(o.rows)) o.rows = o.rows.filter((r) => r.chapter <= keep); });
}

seedSkills().catch(() => {});
server.listen(PORT, () => console.log(`jace 开源小说生成器 运行在 http://localhost:${PORT}`));
