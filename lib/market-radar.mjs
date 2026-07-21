// ============================================================================
// 网文小说生成器 · 作者 Jace
// 热点小说内容指导：抓取番茄/起点热榜，再交给 LLM 压成约 150 字热门框架建议
// 输出为短文案指导，而非完整 JSON 推荐列表
// © Jace · MIT License
// ============================================================================

/**
 * @typedef {{ title: string, author: string, category: string, extra: string }} RankingEntry
 * @typedef {{ platform: string, entries: RankingEntry[] }} PlatformRankings
 */

const UA = "Mozilla/5.0 (compatible; JaceNovel/0.2; +local)";

async function fetchFanqieSide(sideType, label, channelLabel) {
  /** @type {RankingEntry[]} */
  const entries = [];
  try {
    const url = `https://api-lf.fanqiesdk.com/api/novel/channel/homepage/rank/rank_list/v2/?aid=13&limit=12&offset=0&side_type=${sideType}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return entries;
    const data = await res.json();
    const list = data?.data?.result;
    if (!Array.isArray(list)) return entries;
    for (const item of list) {
      entries.push({
        title: String(item.book_name ?? ""),
        author: String(item.author ?? ""),
        category: String(item.category ?? ""),
        extra: `[番茄·${channelLabel}·${label}]`,
      });
    }
  } catch { /* skip */ }
  return entries;
}

function dedupeEntries(entries, max = 15) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (!e.title || seen.has(e.title)) continue;
    seen.add(e.title);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

async function fetchFanqie() {
  // side_type：10 男频热门、13 男频黑马；11/12 女频热门类
  const male = dedupeEntries([
    ...(await fetchFanqieSide(10, "热门榜", "男频")),
    ...(await fetchFanqieSide(13, "黑马榜", "男频")),
  ]);
  const female = dedupeEntries([
    ...(await fetchFanqieSide(11, "热门榜", "女频")),
    ...(await fetchFanqieSide(12, "黑马榜", "女频")),
  ]);
  const legacy = dedupeEntries([
    ...(await fetchFanqieSide(10, "热门榜", "综合")),
    ...(await fetchFanqieSide(13, "黑马榜", "综合")),
  ]);
  /** @type {PlatformRankings[]} */
  const parts = [];
  if (male.length) parts.push({ platform: "番茄小说·男频", entries: male });
  if (female.length) parts.push({ platform: "番茄小说·女频", entries: female });
  if (!male.length && !female.length && legacy.length) {
    parts.push({ platform: "番茄小说", entries: legacy });
  }
  return parts;
}

async function fetchQidian() {
  /** @type {PlatformRankings[]} */
  const out = [];
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    Referer: "https://m.qidian.com/rank/",
    Accept: "application/json, text/plain, */*",
  };
  try {
    const home = await fetch("https://m.qidian.com/rank/", { headers });
    const setCookie = home.headers.getSetCookie?.() || [];
    const cookieStr = setCookie.map((c) => c.split(";")[0]).join("; ");
    const csrf = (cookieStr.match(/_csrfToken=([^;]+)/) || [])[1]
      || ((await home.text()).match(/_csrfToken\s*[:=]\s*["']?([^"'\s&]+)/) || [])[1]
      || "";
    for (const gender of ["male", "female"]) {
      /** @type {RankingEntry[]} */
      const entries = [];
      for (const path of ["hotsaleslist", "yuepiaolist", "readindexlist"]) {
        try {
          const qs = new URLSearchParams({ gender, catId: "-1", pageNum: "1" });
          if (csrf) qs.set("_csrfToken", csrf);
          const res = await fetch(`https://m.qidian.com/majax/rank/${path}?${qs}`, {
            headers: { ...headers, Cookie: cookieStr || `_csrfToken=${csrf}` },
          });
          if (!res.ok) continue;
          const data = await res.json();
          const list = data?.data?.records || data?.data?.list || [];
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            const title = String(item.bName || item.bookName || item.title || "").trim();
            if (!title) continue;
            entries.push({
              title,
              author: String(item.bAuth || item.author || ""),
              category: String(item.cat || item.category || item.catName || ""),
              extra: `[起点·${gender === "male" ? "男频" : "女频"}·${path}]`,
            });
          }
        } catch { /* skip */ }
      }
      const seen = new Set();
      const uniq = [];
      for (const e of entries) {
        if (seen.has(e.title)) continue;
        seen.add(e.title);
        uniq.push(e);
        if (uniq.length >= 15) break;
      }
      out.push({ platform: gender === "male" ? "起点中文网·男频" : "起点中文网·女频", entries: uniq });
    }
  } catch { /* skip */ }
  return out;
}

/** @param {PlatformRankings[]} rankings */
export function formatRankingsForPrompt(rankings) {
  const sections = rankings
    .filter((r) => r.entries.length > 0)
    .map((r) => {
      const lines = r.entries
        .filter((e) => e.title)
        .slice(0, 15)
        .map((e) => `- ${e.title}${e.author ? `（${e.author}）` : ""}${e.category ? ` [${e.category}]` : ""} ${e.extra}`);
      return `### ${r.platform}\n${lines.join("\n")}`;
    });
  return sections.length
    ? sections.join("\n\n")
    : "（未能获取到实时排行数据，请基于你对近半年网文市场的常识分析）";
}

export async function fetchMarketRankings(onProgress) {
  const report = (msg, percent) => {
    try { onProgress?.({ msg, percent }); } catch { /* */ }
  };
  report("正在获取热点类型：番茄男频 / 番茄女频", 8);
  const fanqieParts = await fetchFanqie();
  report("正在获取热点类型：起点男频 / 起点女频", 16);
  const qidianParts = await fetchQidian();
  const rankings = [...fanqieParts, ...qidianParts];
  const total = rankings.reduce((n, r) => n + r.entries.length, 0);
  report(`热榜汇总完成（共 ${total} 条）`, 25);
  return { rankings, total, rankingsText: formatRankingsForPrompt(rankings) };
}

/** 压到约 maxLen 个汉字（含标点按字符计），严格不超过 maxLen */
export function clampGuideText(text, maxLen = 150) {
  let s = String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^【?热点小说内容指导】?\s*/u, "").replace(/^指导[：:]\s*/u, "");
  if (s.length <= maxLen) return s;
  const slice = s.slice(0, maxLen);
  const cut = Math.max(slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("；"), slice.lastIndexOf("，"));
  if (cut >= Math.floor(maxLen * 0.55)) return slice.slice(0, cut + 1);
  const body = slice.slice(0, Math.max(1, maxLen - 1)).replace(/[，、；：:\s]+$/u, "");
  return `${body}…`.slice(0, maxLen);
}

function extractJsonObject(raw) {
  let s = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/** @param {{ id: string, label: string, types: { id: string, label: string, guide: string }[] }[]} channels */
function channelsToLegacyTabs(channels) {
  const tabs = [];
  for (const ch of channels) {
    for (const t of ch.types || []) {
      tabs.push({
        id: t.id,
        label: `${ch.label}·${t.label}`,
        channel: ch.id,
        typeLabel: t.label,
        guide: t.guide,
      });
    }
  }
  return tabs;
}

function parseChannelTypes(ch, fallbackId) {
  const chRaw = String(ch.channel || ch.id || "").toLowerCase();
  const label = String(ch.label || "").trim();
  const isFemale = /female|女/.test(chRaw) || label.includes("女");
  const channelId = isFemale ? "female" : (fallbackId || "male");
  const types = [];
  const src = Array.isArray(ch.types) ? ch.types : (ch.guide ? [{ label: label || (channelId === "female" ? "女频热点" : "男频热点"), guide: ch.guide }] : []);
  for (const [ti, t] of src.entries()) {
    const typeLabel = String(t.label || t.name || `类型${ti + 1}`).trim().slice(0, 14);
    const guide = clampGuideText(t.guide || t.text || t.desc || "", 150);
    if (!typeLabel || !guide) continue;
    types.push({ id: `${channelId}-t${ti}`, label: typeLabel, guide });
  }
  return {
    id: channelId,
    label: channelId === "female" ? "女频" : "男频",
    types: types.slice(0, 5),
  };
}

/** 解析热点结果：综述 + 男频/女频频道 + 各频道下热点类型 */
export function parseHotGuideResult(raw) {
  const empty = { overview: "", channels: [], tabs: [] };
  try {
    const j = extractJsonObject(raw);
    const overview = clampGuideText(j.overview || j.summary || j.综述 || "", 150);

    if (Array.isArray(j.channels) && j.channels.length) {
      const channels = j.channels.map((ch, ci) => parseChannelTypes(ch, ci === 1 ? "female" : "male")).filter((ch) => ch.types.length);
      if (overview || channels.length) {
        const tabs = channelsToLegacyTabs(channels);
        return { overview: overview || channels[0]?.types[0]?.guide || "", channels, tabs };
      }
    }

    const arr = Array.isArray(j.tabs) ? j.tabs : [];
    const byChannel = { male: /** @type {{ id: string, label: string, types: { id: string, label: string, guide: string }[] } | null} */ (null), female: null };
    for (const t of arr) {
      const chRaw = String(t.channel || t.id || t.label || "").toLowerCase();
      const label = String(t.label || "").trim();
      const guide = clampGuideText(t.guide || t.text || t.desc || "", 150);
      if (!guide) continue;
      const isFemale = /female|女/.test(chRaw) || label.includes("女");
      const isMale = /male|男/.test(chRaw) || label.includes("男");
      const channelId = isFemale ? "female" : (isMale ? "male" : null);
      if (!channelId) continue;
      const typeLabel = String(t.type || t.typeLabel || label.replace(/^[男女]频[·•]?\s*/, "") || `${channelId === "female" ? "女频" : "男频"}热点`).slice(0, 14);
      const ch = byChannel[channelId] || { id: channelId, label: channelId === "female" ? "女频" : "男频", types: [] };
      ch.types.push({ id: `${channelId}-t${ch.types.length}`, label: typeLabel, guide });
      byChannel[channelId] = ch;
    }
    if (!byChannel.male || !byChannel.female) {
      for (const t of arr) {
        const guide = clampGuideText(t.guide || t.text || "", 150);
        if (!guide) continue;
        const label = String(t.label || "").trim();
        const isFemale = label.includes("女");
        const channelId = isFemale ? "female" : "male";
        if (!byChannel[channelId]) {
          byChannel[channelId] = { id: channelId, label: channelId === "female" ? "女频" : "男频", types: [] };
        }
        if (!byChannel[channelId].types.some((x) => x.guide === guide)) {
          byChannel[channelId].types.push({
            id: `${channelId}-t${byChannel[channelId].types.length}`,
            label: label.replace(/^[男女]频[·•]?\s*/, "") || "热点方向",
            guide,
          });
        }
      }
    }
    const channels = [byChannel.male, byChannel.female].filter(Boolean).map((ch) => ({
      ...ch,
      types: (ch.types || []).slice(0, 5),
    })).filter((ch) => ch.types.length);
    if (overview || channels.length) {
      const tabs = channelsToLegacyTabs(channels);
      return { overview: overview || channels[0]?.types[0]?.guide || "", channels, tabs };
    }
  } catch { /* fallback */ }
  const guide = clampGuideText(raw, 150);
  if (!guide) return empty;
  const channels = [
    { id: "male", label: "男频", types: [{ id: "male-t0", label: "综合热点", guide }] },
    { id: "female", label: "女频", types: [{ id: "female-t0", label: "综合热点", guide }] },
  ];
  return { overview: guide, channels, tabs: channelsToLegacyTabs(channels) };
}

/** @deprecated 兼容旧调用 */
export function parseHotGuideTabs(raw) {
  return parseHotGuideResult(raw).tabs;
}

/** 将模型返回的题材解析为合法 genre id */
export function resolveGenreId(input, genres = []) {
  const raw = String(input || "").trim();
  const list = Array.isArray(genres) ? genres : [];
  const ids = list.map((g) => g.id);
  const fallback = ids.includes("other") ? "other" : (ids[0] || "other");
  if (!raw) return fallback;

  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, "");
  const nRaw = norm(raw);

  const byId = list.find((g) => g.id === raw || norm(g.id) === nRaw);
  if (byId) return byId.id;

  const byLabel = list.find((g) => g.label === raw || g.label.includes(raw) || raw.includes(g.label));
  if (byLabel) return byLabel.id;

  const aliases = {
    都市: "urban", 玄幻: "xuanhuan", 仙侠: "xianxia", 修真: "cultivation",
    游戏: "litrpg", litrpg: "litrpg", 升级流: "progression", 升级: "progression",
    科幻: "sci-fi", scifi: "sci-fi", 恐怖: "horror", 异世界: "isekai",
    浪漫奇幻: "romantasy", 系统末世: "system-apocalypse", 末世: "system-apocalypse",
    爬塔: "tower-climber", 地下城: "dungeon-core", 治愈: "cozy", 日常: "cozy",
    通用: "other", 自定义: "other",
  };
  for (const [k, v] of Object.entries(aliases)) {
    if (raw.includes(k) || nRaw === norm(k)) {
      if (ids.includes(v)) return v;
    }
  }

  return fallback;
}

/** 解析一键生成字段 */
export function parseHotFill(raw, genres = []) {
  const j = extractJsonObject(raw);
  const title = String(j.title || "").trim().replace(/[《》「」『』]/g, "").slice(0, 40);
  const genreRaw = j.genreId ?? j.genre ?? j.genreLabel ?? j.题材 ?? j.题材id ?? "";
  const genreId = resolveGenreId(genreRaw, genres);
  const settings = String(j.settings || j.setting || "").trim().slice(0, 4000);
  if (!title || !settings) throw new Error("一键生成结果不完整");
  return { title, genreId, settings };
}
