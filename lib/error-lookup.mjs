// ============================================================================
// 网文小说生成器 · 作者 Jace
// 报错自查检索与展示辅助
// © Jace · MIT License
// ============================================================================

/** @typedef {{ code: string, title: string, scene?: string, cause: string, fix: string, keywords?: string[] }} ErrorEntry */

/** @param {ErrorEntry} e */
export function formatErrorLabel(e) {
  return `${e.title} [${e.code}]`;
}

/**
 * 支持：报错码、完整原文（如 接口不存在 [E109]）、关键词
 * @param {ErrorEntry[]} catalog
 * @param {string} raw
 * @returns {ErrorEntry[]}
 */
export function lookupErrorsInCatalog(catalog, raw) {
  const q = String(raw || "").trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  const bracketCode = (q.match(/\[([^\]]+)\]/) || [])[1]?.trim() || null;
  const looksLikeCode = /^([A-Z]{1,6}\d*|\d{4}|NO_KEY|JSON|ABORT|TIMEOUT)$/i.test(q);

  if (bracketCode) {
    const exact = catalog.filter((e) =>
      e.code === bracketCode || e.code.toLowerCase() === bracketCode.toLowerCase(),
    );
    if (exact.length) return exact;
  }

  const hits = [];
  for (const e of catalog) {
    const label = formatErrorLabel(e);
    const labelLower = label.toLowerCase();

    if (e.code === q || e.code.toLowerCase() === qLower) { hits.push(e); continue; }
    if (q === label || qLower === labelLower || q.includes(label) || label.includes(q)) {
      hits.push(e); continue;
    }
    if (q.includes(e.title) || e.title.includes(q)) { hits.push(e); continue; }
    if (e.scene && (q.includes(e.scene) || e.scene.includes(q))) { hits.push(e); continue; }
    if (e.keywords?.some((k) => q.includes(k) || qLower.includes(String(k).toLowerCase()))) {
      hits.push(e); continue;
    }
    if (e.cause.includes(q) || e.fix.includes(q)) {
      if (looksLikeCode && e.code !== q && e.code.toLowerCase() !== qLower) continue;
      hits.push(e);
    }
  }

  const seen = new Set();
  return hits.filter((e) => {
    if (seen.has(e.code)) return false;
    seen.add(e.code);
    return true;
  });
}
