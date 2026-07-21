// ============================================================================
// 网文小说生成器 · 作者 Jace
// Loop 节点定义与默认流程（建书 / 自动连写 / 人工写作）
// © Jace · MIT License
// ============================================================================

/** Loop 节点定义与默认流程（建书 / 自动连写 / 人工写作） */

export const LOOP_NODE_DEFS = {
  foundation_frame: { label: "故事框架与世界观", category: "foundation", desc: "生成全书骨架与核心设定" },
  foundation_volume: { label: "分卷卷纲 / 幕场结构", category: "foundation", desc: "规划分卷或幕场结构" },
  foundation_roles: { label: "角色卡", category: "foundation", desc: "生成主要角色设定" },
  foundation_rules: { label: "创作规则", category: "foundation", desc: "全书创作约束与禁忌" },
  foundation_hooks: { label: "伏笔 / 戏剧钩子", category: "foundation", desc: "伏笔清单或戏剧钩子" },
  foundation_style: { label: "文风指南", category: "foundation", desc: "叙事风格与语言要求" },
  outline_generate: { label: "生成章纲（每组5章）", category: "chapter", desc: "进入新一组时生成章纲" },
  outline_manual: { label: "人工确认章纲", category: "chapter", desc: "弹窗审阅、编辑章纲（人工模式）", modes: ["manual"] },
  outline_audit: { label: "章纲自动审计", category: "chapter", desc: "结构审计并按意见自动修订" },
  write: { label: "撰写正文", category: "chapter", required: true, desc: "核心写作步骤，不可删除" },
  chapter_manual: { label: "人工审阅正文", category: "chapter", desc: "草稿完成后人工确认（人工模式）", modes: ["manual"] },
  chapter_auto_review: { label: "正文自动审改", category: "chapter", desc: "审计并按等级自动修订循环" },
  panel_update: { label: "更新人物面板", category: "chapter", desc: "定稿后同步人物属性面板" },
};

export const DEFAULT_LOOPS = {
  foundation: ["foundation_frame", "foundation_volume", "foundation_roles", "foundation_rules", "foundation_hooks", "foundation_style"],
  auto: ["outline_generate", "outline_audit", "write", "chapter_auto_review", "panel_update"],
  manual: ["outline_generate", "outline_manual", "write", "chapter_manual", "chapter_auto_review", "panel_update"],
};

const MODES = ["foundation", "auto", "manual"];
const REQUIRED = { foundation: [], auto: ["write"], manual: ["write"] };

/** 去重、过滤未知 id、补全必填节点 */
export function normalizeLoop(mode, nodes) {
  const m = MODES.includes(mode) ? mode : "auto";
  const defs = LOOP_NODE_DEFS;
  const allowed = Object.keys(defs).filter((id) => {
    const d = defs[id];
    if (d.modes && !d.modes.includes(m)) return false;
    if (m === "foundation" && d.category !== "foundation") return false;
    if (m !== "foundation" && d.category === "foundation") return false;
    return true;
  });
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(nodes) ? nodes : []) {
    if (!allowed.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const req of REQUIRED[m] || []) {
    if (!seen.has(req)) out.push(req);
  }
  return out.length ? out : [...DEFAULT_LOOPS[m]];
}

export function normalizeLoops(loops) {
  const src = loops && typeof loops === "object" ? loops : {};
  return {
    foundation: normalizeLoop("foundation", src.foundation ?? DEFAULT_LOOPS.foundation),
    auto: normalizeLoop("auto", src.auto ?? DEFAULT_LOOPS.auto),
    manual: normalizeLoop("manual", src.manual ?? DEFAULT_LOOPS.manual),
  };
}

export function hasLoopNode(loops, mode, id) {
  const list = normalizeLoops(loops)[mode] || DEFAULT_LOOPS[mode] || [];
  return list.includes(id);
}

export function loopNodeLabel(id) {
  return LOOP_NODE_DEFS[id]?.label || id;
}
