// ============================================================================
// 网文小说生成器 · 作者 Jace
// 将 data/error-catalog.json 同步嵌入 public/app.js（离线报错自查，无需额外请求）
// © Jace · MIT License
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CATALOG_PATH = join(ROOT, "data/error-catalog.json");
const APP_JS_PATH = join(ROOT, "public/app.js");
const BEGIN = "// @error-catalog-begin";
const END = "// @error-catalog-end";

export function syncErrorCatalogJs() {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  let appJs = readFileSync(APP_JS_PATH, "utf8");
  const block = `${BEGIN}\nconst JACE_ERROR_CATALOG = ${JSON.stringify(catalog, null, 2)};\n${END}`;
  if (!appJs.includes(BEGIN) || !appJs.includes(END)) {
    throw new Error(`public/app.js 缺少 ${BEGIN} / ${END} 标记`);
  }
  appJs = appJs.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block);
  writeFileSync(APP_JS_PATH, appJs, "utf8");
}

try {
  if (import.meta.url === pathToFileURL(process.argv[1]).href) syncErrorCatalogJs();
} catch { /* 被 server 导入时不执行 */ }
