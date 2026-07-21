// ============================================================================
// 网文小说生成器 · 作者 Jace
// 报错自查：错误码 / 关键词 → 原因与处理建议（数据来自 data/error-catalog.json）
// © Jace · MIT License
// ============================================================================

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** @typedef {{ code: string, title: string, scene?: string, cause: string, fix: string, keywords?: string[] }} ErrorEntry */

export const ERROR_CATALOG = JSON.parse(
  readFileSync(join(HERE, "../data/error-catalog.json"), "utf8"),
);

import { lookupErrorsInCatalog } from "./error-lookup.mjs";

const TITLE_BY_CODE = new Map(ERROR_CATALOG.map((e) => [e.code, e.title]));

/** @param {string} code */
export function errorTitle(code) {
  return TITLE_BY_CODE.get(String(code)) || "操作失败";
}

/**
 * 统一错误格式：中文说明 [报错码]
 * @param {string} code
 * @param {string} [detail]
 */
export function appErr(code, detail = "") {
  const c = String(code);
  const title = errorTitle(c);
  const d = String(detail || "").trim();
  const body = d && !d.includes(title) ? `${title}：${d}` : title;
  const text = `${body} [${c}]`;
  return { ok: false, code: c, error: text, message: text };
}

/**
 * @param {unknown} err
 * @returns {string | null}
 */
export function inferErrorCode(err) {
  const msg = String(err?.message ?? err ?? "");
  const lower = msg.toLowerCase();
  if (/未配置.*api\s*key|尚未配置.*密钥|no_key/i.test(lower)) return "NO_KEY";
  if (/no route|not found|接口不存在/.test(lower)) return "E109";
  if (/unexpected token|is not valid json|json\.parse|syntaxerror/i.test(lower)) return "JSON";
  if (/abort|aborted|取消/.test(lower)) return "ABORT";
  if (/401|unauthorized|invalid.*key|authentication|认证/.test(lower)) return "401";
  if (/402|insufficient|余额|quota|额度|token/.test(lower)) return "402";
  if (/429|rate limit|过于频繁/.test(lower)) return "429";
  if (/timeout|etimedout|超时/.test(lower)) return "TIMEOUT";
  if (/fetch failed|network|econnreset|enotfound|failed to fetch|网络/.test(lower)) return "E001";
  return null;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function detailFromException(err) {
  const msg = String(err?.message ?? err ?? "").trim();
  if (!msg) return "";
  if (/[\u4e00-\u9fff]/.test(msg)) return msg.slice(0, 160);
  return "";
}

/**
 * @param {string} code
 * @param {unknown} err
 */
export function appErrFromException(code, err) {
  const inferred = inferErrorCode(err);
  const useCode = inferred || String(code);
  const detail = detailFromException(err);
  return appErr(useCode, detail);
}

/**
 * @param {string} raw
 * @returns {ErrorEntry[]}
 */
export function lookupErrors(raw) {
  return lookupErrorsInCatalog(ERROR_CATALOG, raw);
}

/**
 * @param {{ code?: string|number, error?: string, message?: string }} d
 */
export function normalizeErrorPayload(d) {
  const code = d?.code != null && d.code !== "" ? String(d.code) : "";
  const raw = String(d?.error || d?.message || "").trim();
  if (raw && code && raw.includes(`[${code}]`)) {
    return { code, error: raw, message: raw };
  }
  if (code) return appErr(code, raw && /[\u4e00-\u9fff]/.test(raw) ? raw : "");
  if (raw) return { code: "", error: raw, message: raw };
  return appErr("E002", "连接中断");
}
