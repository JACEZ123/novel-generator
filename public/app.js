// ============================================================================
// 网文小说生成器 · 作者 Jace
// 前端状态机（原生 JS）
// © Jace · MIT License
// ============================================================================
const S = {
  kind: "longform", bookId: null, foundation: null,
  chapter: 1, preAudit: null, postAudit: null,
  confirmStage: "draft", selectedTab: null, ac: null,
  book: null, total: 0, chaptersData: [], outlines: [], chapterTitle: null,
  hotChannels: [], hotChannelId: null, hotTypeId: null, hotOverview: "",
  foundationGenAc: null,
  apiReady: false,
};
const $ = (id) => document.getElementById(id);
const openModal = (id) => $(id).classList.add("on");
const closeModal = (id) => $(id).classList.remove("on");

function genFoundationBtnLabel() {
  return S.kind === "script" ? "生成剧本结构与人物" : "生成大纲与世界观";
}

function closeSettingsModal() {
  if (S.foundationGenAc) cancelGenFoundation();
  closeModal("m-settings");
}

function resetGenFoundationUI() {
  const label = genFoundationBtnLabel();
  const gen = $("btn-gen");
  const cancel = $("btn-gen-cancel");
  if (gen) { gen.textContent = label; }
  if (cancel) cancel.classList.add("hidden");
  syncApiGatedButtons();
}

function cancelGenFoundation() {
  if (S.foundationGenAc) {
    S.foundationGenAc.abort();
    S.foundationGenAc = null;
  }
  resetGenFoundationUI();
  foundationProg?.stop("已取消生成（请求已中断）");
}
const esc = (s) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 进度反馈：当前行醒目 + 上一行淡出，让等待过程可见
function showProgress(elId, msg) {
  const el = $(elId); if (!el) return;
  el.classList.remove("hidden");
  const prevCur = el.querySelector(".cur")?.textContent;
  el.innerHTML = `<span class="cur">${esc(msg)}</span>` + (prevCur ? `<span class="past">上一步：${esc(prevCur)}</span>` : "");
}
function hideProgress(elId) { const el = $(elId); if (el) { el.classList.add("hidden"); el.innerHTML = ""; } }

// ---------- API 阶段进度（细粒度：文案 + 耗时 + ETA + 百分比 + 剩余项）----------
const API_PHASE = {
  RANK: "榜单抓取中",
  CALL: "API调用中",
  RECEIVE: "API返回中",
  SUMMARIZE: "内容总结中",
  THINK: "思路构思中",
  RENDER: "反显中",
};

/** 各长流程预计总耗时基线（秒，偏保守） */
const ETA_BASELINE_SEC = {
  hotGuide: 120,
  hotFill: 60,
  foundation: 600,
  reviseFoundation: 180,
  outline: 120,
  outlineAudit: 240,
  write: 180,
  audit: 300,
  panel: 30,
};

function formatEtaSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `约 ${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `约 ${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `约 ${h} 小时 ${rm} 分钟` : `约 ${h} 小时`;
}

function estimateRemainSec(etaSec, percent, elapsedSec) {
  const eta = Math.max(0, Number(etaSec) || 0);
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const elapsed = Math.max(0, Number(elapsedSec) || 0);
  if (!eta && pct < 15) return null;
  const fromBaseline = eta ? Math.max(0, Math.round(eta * (1 - pct / 100))) : null;
  let fromPace = null;
  if (pct >= 15 && elapsed > 0) {
    fromPace = Math.max(0, Math.round(elapsed * (100 - pct) / pct));
  }
  if (fromBaseline == null && fromPace == null) return null;
  if (fromBaseline == null) return fromPace;
  if (fromPace == null) return fromBaseline;
  return Math.max(fromBaseline, fromPace);
}

function startApiProgress(elOrId, opts = {}) {
  const el = typeof elOrId === "string" ? $(elOrId) : elOrId;
  const state = {
    phase: "",
    percent: null,
    remaining: "",
    etaSec: opts.etaSec != null ? Number(opts.etaSec) : null,
    rich: false,
    t0: Date.now(),
    stepT0: Date.now(),
    timer: null,
    el,
  };
  const render = () => {
    if (!state.el) return;
    state.el.classList.remove("hidden");
    const totalS = Math.max(0, Math.floor((Date.now() - state.t0) / 1000));
    const stepS = Math.max(0, Math.floor((Date.now() - state.stepT0) / 1000));
    if (state.rich) {
      const pct = state.percent != null ? Math.max(0, Math.min(100, Number(state.percent) || 0)) : null;
      const pctTxt = pct != null ? `${pct}%` : "—";
      const rem = state.remaining
        ? `<div class="genprog-rem">剩余：${esc(state.remaining)}</div>`
        : "";
      const bar = pct != null
        ? `<div class="genprog-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>`
        : "";
      let etaBits = "";
      if (state.etaSec != null && state.etaSec > 0) {
        etaBits += ` · 预计总耗时${formatEtaSec(state.etaSec)}`;
        const left = estimateRemainSec(state.etaSec, pct ?? 0, totalS);
        if (left != null && (pct == null || pct < 100)) {
          etaBits += ` · 预计剩余${formatEtaSec(left)}`;
        }
      }
      state.el.innerHTML = `
        <div class="genprog-cur">${esc(state.phase || "处理中…")}</div>
        <div class="genprog-meta">本步 ${stepS}s · 合计 ${totalS}s · 整体 ${pctTxt}${etaBits}</div>
        ${bar}
        ${rem}`;
      return;
    }
    state.el.innerHTML = state.phase
      ? `<span class="cur api-phase">${esc(state.phase)} · ${totalS}s</span>`
      : "";
  };
  state.timer = setInterval(render, 250);
  return {
    set(phase) {
      state.rich = false;
      state.phase = phase;
      state.stepT0 = Date.now();
      render();
    },
    detail(info = {}) {
      state.rich = true;
      if (info.msg) state.phase = String(info.msg);
      if (info.percent != null && info.percent !== "") state.percent = Number(info.percent);
      if (info.remaining != null) state.remaining = String(info.remaining);
      if (info.etaSec != null && info.etaSec !== "") state.etaSec = Number(info.etaSec);
      if (info.resetStep || /正在结合|重新生成|初始化|正在获取/.test(String(info.msg || ""))) {
        state.stepT0 = Date.now();
      }
      render();
    },
    stop(finalText) {
      clearInterval(state.timer);
      if (!state.el) return;
      const totalS = Math.max(0, Math.floor((Date.now() - state.t0) / 1000));
      if (finalText) {
        const etaNote = state.etaSec ? `（预计曾为${formatEtaSec(state.etaSec)}）` : "";
        state.el.innerHTML = `<span class="cur">${esc(finalText)}</span><span class="past">实际耗时 ${totalS}s${etaNote}</span>`;
      } else {
        state.el.classList.add("hidden");
        state.el.innerHTML = "";
      }
    },
    hide() {
      clearInterval(state.timer);
      if (state.el) {
        state.el.classList.add("hidden");
        state.el.innerHTML = "";
      }
    },
    el: state.el,
  };
}

/** 本机读写类短提示（无百分比 / 无 ETA） */
function flashProgress(elOrId, msg, { ok = true, ms = 2200 } = {}) {
  const el = typeof elOrId === "string" ? $(elOrId) : elOrId;
  if (!el) return;
  el.classList.remove("hidden");
  el.innerHTML = `<span class="cur" style="${ok ? "" : "color:var(--color-destructive)"}">${esc(msg)}</span>`;
  if (ms > 0) {
    clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(() => {
      if (ok) { el.classList.add("hidden"); el.innerHTML = ""; }
    }, ms);
  }
}

function mapStageToPhase(msg) {
  const m = String(msg || "");
  if (/规划|构思|章纲|推理|思考|推导|理解/.test(m)) return API_PHASE.THINK;
  if (/审计|总结|修订|评估|校验|格式处理|不符合规范/.test(m)) return API_PHASE.SUMMARIZE;
  if (/生成|写作|撰写|调用|启动|提交|发送|结合 skill/.test(m)) return API_PHASE.CALL;
  if (/返回|接收/.test(m)) return API_PHASE.RECEIVE;
  return API_PHASE.RECEIVE;
}

// @error-catalog-begin
const JACE_ERROR_CATALOG = [
  {
    "code": "1001",
    "title": "建书 / 生成设定失败",
    "scene": "新建长篇小说 → 填写初始设定 → 点击「生成大纲与世界观」时。",
    "cause": "调用 AI 生成世界观/卷纲/角色卡时失败。常见原因：① 尚未在设置中配置 API Key；② Key 无效或余额不足；③ 强模型不可用；④ 网络中断。",
    "fix": "1. 页面左侧 → 设置 → 模型服务 → 填写并保存 API Key（Base URL 保持默认或按你的服务商修改）。\n2. 终端停止服务后重新运行 npm start，浏览器 Ctrl+F5 刷新。\n3. 回到建书弹窗，重新点击「生成大纲与世界观」。\n4. 若仍失败，在设置 → 阶段模型 中换用其他强模型后重试。",
    "keywords": [
      "foundation",
      "建书",
      "生成设定",
      "1001"
    ]
  },
  {
    "code": "1002",
    "title": "章节写作失败",
    "scene": "确认章纲后 → 逐章写作 / 自动连写正文时。",
    "cause": "撰写某一章正文时模型返回错误或连接中断。常见原因：① API Key 或额度问题；② 上下文过长；③ 快模型配置错误。",
    "fix": "1. 左侧 → 设置 → 模型服务，确认 API Key 有效且有余额。\n2. 左侧 → 设置 → 阶段模型，检查「正文写手」绑定的快模型是否可用。\n3. 若已写章数很多，可先定稿较少章节或新开书测试。\n4. 保存进度后稍后重试该章写作。",
    "keywords": [
      "write",
      "写作",
      "1002"
    ]
  },
  {
    "code": "1003",
    "title": "读取设定失败",
    "scene": "打开已有作品、刷新右侧设定卡片时。",
    "cause": "书籍目录或设定文件（story_frame.md、卷纲等）损坏或缺失。",
    "fix": "1. 检查项目目录 data/books/你的书名/ 是否完整。\n2. 若有备份，恢复该文件夹。\n3. 无法恢复时，用相同书名重新建书并粘贴保留的设定文本。",
    "keywords": [
      "1003",
      "读取设定"
    ]
  },
  {
    "code": "1004",
    "title": "章节修订失败",
    "scene": "章节草稿 → 选择「修订」或「重写」并提交意见后。",
    "cause": "按你的意见让 AI 改稿时模型调用失败，多为 API Key/额度或模型不可用。",
    "fix": "1. 左侧 → 设置 → 模型服务，确认 API Key。\n2. 可先在章节编辑区手动修改正文并保存，跳过本次 AI 修订。\n3. 换用其他快模型后重新提交修订意见。",
    "keywords": [
      "1004",
      "修订"
    ]
  },
  {
    "code": "1006",
    "title": "设定修订失败",
    "scene": "设定确认弹窗 → 填写修订意见 →「按意见重生成设定」时。",
    "cause": "根据你的反馈重生成世界观/卷纲时模型调用失败。",
    "fix": "1. 确认 API Key 与强模型可用（设置 → 模型服务 / 阶段模型）。\n2. 精简修订意见后重试。\n3. 也可在设定弹窗内手动编辑各分区内容保存。",
    "keywords": [
      "1006",
      "设定修订"
    ]
  },
  {
    "code": "1007",
    "title": "章纲生成失败",
    "scene": "确认世界观后 → 生成近 5 章章纲，或组末生成下一组章纲时。",
    "cause": "规划章纲时模型调用失败，多为 planner 阶段模型或 API 配置问题。",
    "fix": "1. 左侧 → 设置 → 阶段模型，检查「章纲生成」所用模型。\n2. 确认 API Key 有效。\n3. 重新打开章纲弹窗，点击重新生成。",
    "keywords": [
      "1007",
      "章纲"
    ]
  },
  {
    "code": "1008",
    "title": "自动审改失败",
    "scene": "章节草稿 →「继续（进入自动审计）」或「自动纠正」时。",
    "cause": "正文多轮审计/修订循环中某次模型调用失败。",
    "fix": "1. 检查 API Key 与额度。\n2. 左侧 → 设置 → 自动写作，可适当减少审计轮次。\n3. 改用手动审阅：使用草稿版本，自行编辑后定稿。",
    "keywords": [
      "1008",
      "审改",
      "审计"
    ]
  },
  {
    "code": "1009",
    "title": "章纲审计失败",
    "scene": "章纲弹窗 →「自动纠正」或组末提交章纲自动审计时。",
    "cause": "章纲结构审计或按审计意见修订章纲时模型调用失败。",
    "fix": "1. 左侧 → 设置 → 阶段模型，检查章纲审计/修订相关阶段模型。\n2. 确认 API Key。\n3. 可手动编辑章纲后点「确认章纲」跳过自动审计。",
    "keywords": [
      "1009",
      "章纲审计"
    ]
  },
  {
    "code": "1010",
    "title": "人物面板更新失败",
    "scene": "章节定稿后自动更新网游人物属性面板时。",
    "cause": "依据正文让 AI 更新面板 JSON 时调用失败。",
    "fix": "1. 确认 API Key 与快模型配置。\n2. 右侧人物面板 → 编辑，手动改 JSON 后保存。\n3. 定稿不受影响，可稍后再点「依据正文更新面板」。",
    "keywords": [
      "1010",
      "人物面板"
    ]
  },
  {
    "code": "1011",
    "title": "热点指导解析失败",
    "scene": "建书弹窗 →「热点小说内容指导」生成市场综述与 TAB 时。",
    "cause": "模型返回的内容无法解析为 JSON。常见原因：① API Key 未配或无效导致返回异常页；② 模型太弱未按格式输出；③ 技能 prompt 被改坏。",
    "fix": "1. 左侧 → 设置 → 模型服务 → 配置 API Key → 保存。\n2. 重启 npm start，刷新页面后重试「热点小说内容指导」。\n3. 设置 → 阶段模型，将 architect 换为更强模型。\n4. 设置 → 技能，检查「热点小说内容指导」未被改乱（可恢复默认）。",
    "keywords": [
      "1011",
      "热点指导"
    ]
  },
  {
    "code": "1012",
    "title": "热点一键生成失败",
    "scene": "热点指导完成后 → 选择频向/类型 →「AI 一键生成」书名与设定时。",
    "cause": "根据热点框架生成书名/题材/初始设定时模型调用或解析失败。多为 API Key、额度或模型问题。",
    "fix": "1. 确认已选择男频/女频和具体热点类型 TAB。\n2. 左侧 → 设置 → 模型服务 → 配置 API Key。\n3. 重启服务后重试一键生成。\n4. 也可手动填写书名与初始设定，跳过一键生成。",
    "keywords": [
      "1012",
      "一键生成",
      "热点"
    ]
  },
  {
    "code": "1013",
    "title": "榜单抓取失败",
    "scene": "点击「热点小说内容指导」时，拉取番茄/起点热榜阶段（无需 API Key）。",
    "cause": "访问外网排行榜接口失败（网络、防火墙或对方限流）。",
    "fix": "1. 检查本机能否正常上网。\n2. 稍后重试；榜单失败时 AI 会按常识生成，不影响后续步骤。\n3. 若仅榜单失败但已配置 API Key，可继续等待模型生成综述。",
    "keywords": [
      "1013",
      "榜单",
      "热榜"
    ]
  },
  {
    "code": "NO_KEY",
    "title": "未配置 API Key",
    "scene": "任何需要 AI 的功能：热点指导、生成设定、写作、审计等。",
    "cause": "本工具只在「设置 → 模型服务」中读取 API Key，当前检测到未配置。环境变量不会生效。",
    "fix": "1. 页面左侧 → 设置 → 模型服务。\n2. 填入你的 API Key，按需修改 Base URL（默认 DeepSeek 兼容接口）。\n3. 点击保存。\n4. 重启 npm start，刷新页面后再使用 AI 功能。",
    "keywords": [
      "api key",
      "密钥",
      "NO_KEY",
      "未配置"
    ]
  },
  {
    "code": "401",
    "title": "认证失败",
    "scene": "任意 AI 请求返回时（热点指导、建书、写作等）。",
    "cause": "API Key 错误、已过期或被服务商拒绝。",
    "fix": "1. 登录模型服务商控制台，确认 Key 状态正常。\n2. 左侧 → 设置 → 模型服务，更新 API Key 并保存。\n3. 重启 npm start 后重试。",
    "keywords": [
      "401",
      "unauthorized",
      "认证",
      "authentication"
    ]
  },
  {
    "code": "402",
    "title": "余额不足",
    "scene": "自动连写或长时间生成过程中突然停止。",
    "cause": "模型账户余额或 Token 额度已用尽。",
    "fix": "1. 到服务商控制台充值，或更换有余额的 API Key。\n2. 左侧 → 设置 → 自动写作，可开启「额度不足时停止」避免无效重试。\n3. 更新 Key 后重启服务继续写作。",
    "keywords": [
      "402",
      "余额",
      "额度",
      "quota",
      "insufficient"
    ]
  },
  {
    "code": "429",
    "title": "请求过于频繁",
    "scene": "连续自动写作或短时间内多次点击生成时。",
    "cause": "触发模型服务商限流。",
    "fix": "1. 等待 1～2 分钟后重试。\n2. 降低自动连写频率，或暂停自动任务。\n3. 若经常遇到，升级套餐或更换服务商。",
    "keywords": [
      "429",
      "rate limit",
      "频繁"
    ]
  },
  {
    "code": "500",
    "title": "服务端错误",
    "scene": "任意操作时服务端或上游模型返回 500。",
    "cause": "本机 Node 服务异常，或上游模型服务内部错误。",
    "fix": "1. 查看运行 npm start 的终端窗口完整报错。\n2. Ctrl+C 停止后重新 npm start。\n3. 刷新页面重试；持续出现请检查模型服务商状态页。",
    "keywords": [
      "500",
      "服务端"
    ]
  },
  {
    "code": "ABORT",
    "title": "请求已取消",
    "scene": "生成过程中点击「取消生成」或关闭页面/断网时。",
    "cause": "用户主动中断，或浏览器连接断开。",
    "fix": "1. 重新点击刚才的生成按钮即可。\n2. 若是建书中途取消，半成品书籍目录会被清理，需重新生成。\n3. 写作中途取消，已生成内容一般已保存，可继续该章。",
    "keywords": [
      "abort",
      "取消",
      "ABORT"
    ]
  },
  {
    "code": "TIMEOUT",
    "title": "请求超时",
    "scene": "生成大纲、长章纲或正文时等待过久。",
    "cause": "网络慢或模型响应时间过长。",
    "fix": "1. 检查网络稳定性。\n2. 设置 → 阶段模型，换用更快的模型（如 Flash）。\n3. 稍后重试；避免同时开多个生成任务。",
    "keywords": [
      "timeout",
      "超时",
      "TIMEOUT"
    ]
  },
  {
    "code": "JSON",
    "title": "响应格式错误",
    "scene": "热点指导、一键生成、或服务未正确响应时。",
    "cause": "浏览器期望 JSON，但收到了纯文本（如 no route）或 HTML 错误页。常见于：① 服务未重启，新接口不存在；② API Key 未配导致异常响应；③ 模型输出非 JSON。",
    "fix": "1. 终端 Ctrl+C 停止，重新 npm start。\n2. 左侧 → 设置 → 模型服务 → 配置 API Key → 保存。\n3. 浏览器 Ctrl+F5 强制刷新后重试。\n4. 热点类功能可换更强 architect 模型。",
    "keywords": [
      "json",
      "parse",
      "unexpected token",
      "not valid json",
      "响应格式"
    ]
  },
  {
    "code": "E001",
    "title": "网络请求失败",
    "scene": "页面加载后任意功能请求本机服务时。",
    "cause": "浏览器连不上 localhost 服务（npm start 未运行、端口不对、或防火墙拦截）。",
    "fix": "1. 在项目目录终端执行 npm start，看到「运行在 http://localhost:xxxx」。\n2. 浏览器访问终端显示的同一地址。\n3. 刷新页面后重试。",
    "keywords": [
      "网络",
      "fetch failed",
      "E001"
    ]
  },
  {
    "code": "E002",
    "title": "流式连接中断",
    "scene": "生成大纲、章纲、正文等流式输出过程中。",
    "cause": "SSE 长连接意外断开（网络波动、服务崩溃、休眠断网）。",
    "fix": "1. 查看终端是否还在运行 npm start。\n2. 重新发起生成；已输出部分可能已保存。\n3. 保持电脑不休眠，使用稳定网络。",
    "keywords": [
      "流式",
      "中断",
      "E002"
    ]
  },
  {
    "code": "E100",
    "title": "查询条件为空",
    "scene": "报错自查弹窗未输入内容就点查询时。",
    "cause": "未填写报错码或关键词。",
    "fix": "输入页面上的完整报错原文（含方括号里的码），或输入报错码、关键词后查询。",
    "keywords": [
      "E100"
    ]
  },
  {
    "code": "E101",
    "title": "缺少书名",
    "scene": "建书弹窗未填书名就点生成时。",
    "cause": "书名为必填项。",
    "fix": "在初始设定弹窗顶部填写书名，再点击「生成大纲与世界观」。",
    "keywords": [
      "E101",
      "书名"
    ]
  },
  {
    "code": "E102",
    "title": "缺少必要参数",
    "scene": "恢复作品、保存章节、提交反馈等操作时。",
    "cause": "请求缺少 bookId 等必填字段，多为页面状态过期。",
    "fix": "1. Ctrl+F5 刷新页面。\n2. 左侧作品列表重新点开该书。\n3. 仍失败则重启 npm start 后重试。",
    "keywords": [
      "E102",
      "bookId",
      "参数"
    ]
  },
  {
    "code": "E103",
    "title": "请先选择热点类型",
    "scene": "热点指导后未选 TAB 就点「AI 一键生成」时。",
    "cause": "一键生成需要明确的频向和热点类型。",
    "fix": "1. 先点「热点小说内容指导」等待综述出现。\n2. 点男频/女频，再点下方具体热点类型 TAB。\n3. 最后点「AI 一键生成」。",
    "keywords": [
      "E103",
      "热点类型"
    ]
  },
  {
    "code": "E104",
    "title": "题材列表不能为空",
    "scene": "设置 → 题材设置 → 保存时。",
    "cause": "提交的题材列表为空或格式无效。",
    "fix": "左侧 → 设置 → 题材设置，至少保留一个题材（如都市、玄幻），再保存。",
    "keywords": [
      "E104",
      "题材"
    ]
  },
  {
    "code": "E105",
    "title": "缺少名称",
    "scene": "技能管理新增/保存时。",
    "cause": "技能名称为空。",
    "fix": "在技能编辑区填写名称后保存。",
    "keywords": [
      "E105"
    ]
  },
  {
    "code": "E106",
    "title": "名称非法",
    "scene": "技能管理保存时。",
    "cause": "技能名称含非法字符。",
    "fix": "使用中文或字母数字命名，避免 / \\ 等特殊符号。",
    "keywords": [
      "E106"
    ]
  },
  {
    "code": "E107",
    "title": "该技能没有内置默认",
    "scene": "技能管理点「恢复默认」时。",
    "cause": "该技能为自定义新增，无内置模板。",
    "fix": "仅内置技能可恢复默认；自定义技能请手动编辑或删除后重新添加。",
    "keywords": [
      "E107"
    ]
  },
  {
    "code": "E108",
    "title": "请求参数错误",
    "scene": "保存章纲、面板、章节等提交数据时。",
    "cause": "提交的数据格式不正确或字段缺失。",
    "fix": "1. 刷新页面重试。\n2. 检查是否漏填必填项。\n3. 编辑 JSON 类内容时确认格式合法。",
    "keywords": [
      "E108",
      "参数错误"
    ]
  },
  {
    "code": "E109",
    "title": "接口不存在",
    "scene": "常见于「热点小说内容指导」、生成大纲/设定、写作等需要调用后端的环节；也可能是服务未更新或端口不对。",
    "cause": "浏览器请求的 API 地址在后端不存在。最常见：① 尚未配置 API Key，部分流程会先请求失败；② 代码更新后未重启 npm start，旧服务没有新接口；③ 浏览器打开的端口与终端不一致；④ 代理/网关返回了 no route。",
    "fix": "1. 页面左侧 → 设置 → 模型服务 → 填写并保存你的 API Key。\n2. 终端 Ctrl+C 停止当前服务，重新执行 npm start。\n3. 用终端显示的地址（如 http://localhost:4568）打开页面，Ctrl+F5 强制刷新。\n4. 再重试「热点小说内容指导」或生成操作。",
    "keywords": [
      "no route",
      "not found",
      "404",
      "E109",
      "接口不存在"
    ]
  },
  {
    "code": "E404",
    "title": "章节不存在",
    "scene": "打开或编辑某一章正文时。",
    "cause": "该章文件已被删除或尚未生成。",
    "fix": "1. 回到项目总览确认已写章数。\n2. 从列表重新进入存在的章节。\n3. 若需该章，重新生成或写作。",
    "keywords": [
      "E404",
      "章节不存在"
    ]
  },
  {
    "code": "E500",
    "title": "服务内部错误",
    "scene": "任意 API 请求时服务端未捕获的异常。",
    "cause": "本机 server.mjs 处理请求时抛出错误。",
    "fix": "1. 查看 npm start 终端的完整报错栈。\n2. 重启服务后重试。\n3. 将终端报错与报错码一并用于排查。",
    "keywords": [
      "E500",
      "内部错误"
    ]
  }
];
// @error-catalog-end

function errorCatalogList() {
  return Array.isArray(JACE_ERROR_CATALOG) && JACE_ERROR_CATALOG.length ? JACE_ERROR_CATALOG : [];
}

function lookupErrorsLocal(raw) {
  const q = String(raw || "").trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  const bracketCode = (q.match(/\[([^\]]+)\]/) || [])[1]?.trim() || null;
  const looksLikeCode = /^([A-Z]{1,6}\d*|\d{4}|NO_KEY|JSON|ABORT|TIMEOUT)$/i.test(q);

  if (bracketCode) {
    const exact = errorCatalogList().filter((e) =>
      e.code === bracketCode || e.code.toLowerCase() === bracketCode.toLowerCase(),
    );
    if (exact.length) return exact;
  }

  const hits = [];
  for (const e of errorCatalogList()) {
    const label = `${e.title} [${e.code}]`;
    const labelLower = label.toLowerCase();
    if (e.code === q || e.code.toLowerCase() === qLower) { hits.push(e); continue; }
    if (q === label || qLower === labelLower || q.includes(label) || label.includes(q)) {
      hits.push(e); continue;
    }
    if (q.includes(e.title) || e.title.includes(q)) { hits.push(e); continue; }
    if (e.scene && (q.includes(e.scene) || e.scene.includes(q))) { hits.push(e); continue; }
    if ((e.keywords || []).some((k) => q.includes(k) || qLower.includes(String(k).toLowerCase()))) {
      hits.push(e); continue;
    }
    if (e.cause.includes(q) || e.fix.includes(q)) {
      if (looksLikeCode && e.code !== q && e.code.toLowerCase() !== qLower) continue;
      hits.push(e);
    }
  }
  const seen = new Set();
  return hits.filter((e) => { if (seen.has(e.code)) return false; seen.add(e.code); return true; });
}

function inferClientErrorCode(msg) {
  const lower = String(msg || "").toLowerCase();
  if (/未配置.*api\s*key|尚未配置.*密钥|no_key/.test(lower)) return "NO_KEY";
  if (/no route|not found|接口不存在/.test(lower)) return "E109";
  if (/unexpected token|is not valid json|json\.parse|syntaxerror/.test(lower)) return "JSON";
  if (/401|unauthorized|invalid.*key|authentication|认证/.test(lower)) return "401";
  if (/402|insufficient|余额|quota|额度/.test(lower)) return "402";
  if (/429|rate limit|过于频繁/.test(lower)) return "429";
  if (/timeout|etimedout|超时/.test(lower)) return "TIMEOUT";
  if (/fetch failed|network|econnreset|enotfound|网络|failed to fetch/.test(lower)) return "E001";
  if (/abort|aborted|取消/.test(lower)) return "ABORT";
  return null;
}

function errorTitleLocal(code) {
  const hit = errorCatalogList().find((e) => e.code === String(code));
  return hit?.title || "操作失败";
}

function clientErrText(code, detail = "") {
  const c = String(code);
  const title = errorTitleLocal(c);
  const d = String(detail || "").trim();
  const body = d && !d.includes(title) && /[\u4e00-\u9fff]/.test(d) ? `${title}：${d}` : title;
  return `${body} [${c}]`;
}

function clientErr(code, detail = "") {
  const c = String(code);
  const text = clientErrText(c, detail);
  return { code: c, error: text, message: text };
}

async function readJsonResponse(resp) {
  const text = await resp.text();
  const trimmed = text.trim();
  if (!trimmed) {
    if (!resp.ok) return { ok: false, ...clientErr(resp.status === 404 ? "E109" : "E500") };
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lower = trimmed.toLowerCase();
    if (lower.includes("no route") || lower.includes("not found")) {
      return { ok: false, ...clientErr("E109") };
    }
    return { ok: false, ...clientErr("JSON") };
  }
}

/** 统一 fetch + JSON 解析，失败抛中文 [报错码] */
async function apiFetch(url, opts = {}) {
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch {
    throw Object.assign(new Error(clientErr("E001").error), clientErr("E001"));
  }
  const data = await readJsonResponse(resp);
  if (!resp.ok || data.ok === false) {
    const err = data.error ? { code: data.code, error: data.error, message: data.message || data.error } : clientErr(resp.status === 404 ? "E109" : "E500");
    throw Object.assign(new Error(err.error), err);
  }
  return data;
}

async function fetchJsonPhased(url, opts, progressElOrProg, phases = {}) {
  const prog = progressElOrProg?.set ? progressElOrProg : (progressElOrProg ? startApiProgress(progressElOrProg) : null);
  const p = { call: API_PHASE.CALL, receive: API_PHASE.RECEIVE, parse: API_PHASE.SUMMARIZE, render: API_PHASE.RENDER, ...phases };
  if (prog) prog.set(p.call);
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    if (prog) prog.hide();
    throw Object.assign(new Error(clientErr("E001").error), { code: "E001" });
  }
  if (prog) prog.set(p.receive);
  const data = await readJsonResponse(resp);
  if (!resp.ok || data.ok === false) {
    const err = data.error ? data : clientErr(resp.status === 404 ? "E109" : "E500");
    if (prog) prog.hide();
    throw Object.assign(new Error(err.error), { code: err.code });
  }
  if (prog) prog.set(p.parse);
  await new Promise((r) => setTimeout(r, 30));
  if (prog) prog.set(p.render);
  return { ok: true, status: resp.status, data };
}

function toUserError(e) {
  if (!e) return clientErr("E002").error;
  if (e.error && typeof e.error === "string") return e.error;
  const msg = String(e.message || "").trim();
  if (msg && msg.includes("[") && /[\u4e00-\u9fff]/.test(msg)) return msg;
  const inferred = typeof inferClientErrorCode === "function" ? inferClientErrorCode(msg) : null;
  const code = e.code ? String(e.code) : inferred;
  if (code) return clientErr(code, /[\u4e00-\u9fff]/.test(msg) ? msg : "").error;
  return clientErr("JSON").error;
}

function formatErrorDisplay(d) {
  if (typeof d === "string") d = { message: d };
  const code = d?.code != null && d.code !== "" ? String(d.code) : "";
  const raw = String(d?.error || d?.message || "").trim();
  if (raw && code && raw.includes(`[${code}]`)) return { text: raw, code };
  if (raw && raw.includes("[") && /[\u4e00-\u9fff]/.test(raw)) return { text: raw, code: code || "" };
  const inferred = raw ? inferClientErrorCode(raw) : null;
  const useCode = code || inferred;
  if (useCode) {
    const extra = raw && /[\u4e00-\u9fff]/.test(raw) && !raw.includes("[") ? raw : "";
    return { text: clientErr(useCode, extra).error, code: useCode };
  }
  return { text: clientErr("E002").error, code: "E002" };
}

function errorLookupLink(code) {
  if (!code) return "";
  return ` <a href="javascript:void(0)" onclick="openErrorLookup('${String(code).replace(/'/g, "")}')" style="font-size:12px">报错自查</a>`;
}

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
function renderBookRow(b) {
  const idEnc = encodeURIComponent(b.id);
  const menuOpen = S.openBookMenu === b.id;
  const kind = b.kind === "script" ? "剧本" : "长篇";
  const meta = b.hasFoundation ? `已写 ${b.total} 章` : "设定未完成";
  const active = b.id === S.bookId ? " active" : "";
  const menuCls = menuOpen ? " menu-open" : "";
  let html = `<div class="book-row${menuCls}">`;
  html += `<div class="book-item${active}" onclick="resumeBook('${idEnc}')">`;
  html += `<div class="bk-kind">${kind}</div>`;
  html += `<div class="bk-title">${esc(b.title)}</div>`;
  html += `<div class="bk-meta">${meta}</div></div>`;
  html += `<button type="button" class="book-menu-btn" title="项目操作" onclick="toggleBookMenu(event,'${idEnc}')">&#8943;</button>`;
  if (menuOpen) {
    html += `<div class="book-menu-pop" onclick="event.stopPropagation()">`;
    html += `<button type="button" onclick="resumeBook('${idEnc}');closeBookMenu()">打开项目</button>`;
    html += `<button type="button" onclick="renameBookProject('${idEnc}')">重命名</button>`;
    html += `<button type="button" class="danger" onclick="deleteBookProject('${idEnc}')">删除项目</button>`;
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

function chapRowHtml(c, opts = {}) {
  const s = statusLabel(c.status);
  const preview = firstLines(stripStructure(c.content), 3);
  const chNum = String(c.n).padStart(2, "0");
  const del = opts.showDel
    ? `<button type="button" class="cr-del" onclick="event.stopPropagation();deleteChapter(${c.n})">DEL</button>`
    : "";
  return `<div class="chap-row" data-ch="${chNum}" onclick="openChapter(${c.n})">
    <div class="cr-head">
      <span class="cr-title">第 ${c.n} 章 ${esc(cleanTitle(c.title))}</span>
      <div class="cr-preview">${esc(preview)}</div>
    </div>
    <div class="cr-actions">
      <span class="cr-status ${s.cls}">${s.txt}</span>${del}
    </div>
  </div>`;
}

async function loadBooks() {
  try {
    const d = await apiFetch("/api/books");
    const list = $("book-list");
    const books = d.books || [];
    if (!books.length) {
      list.innerHTML = `<p class="dock-empty">还没有作品，点上方「新建创作」开始。</p>`;
    } else {
      S.booksList = books;
      list.innerHTML = books.map((b) => renderBookRow(b)).join("");
    }
  } catch { /* ignore */ }
}
function toggleBookMenu(ev, idEnc) {
  ev.stopPropagation();
  const id = decodeURIComponent(idEnc);
  S.openBookMenu = S.openBookMenu === id ? null : id;
  loadBooks();
}

function closeBookMenu() {
  if (!S.openBookMenu) return;
  S.openBookMenu = null;
  loadBooks();
}

async function renameBookProject(idEnc) {
  closeBookMenu();
  const bookId = decodeURIComponent(idEnc);
  const cur = (S.booksList || []).find((b) => b.id === bookId)?.title || bookId;
  const title = prompt("新项目名称（仅改显示名，不影响正文与目录）", cur);
  if (title == null) return;
  const t = title.trim();
  if (!t) { alert("名称不能为空"); return; }
  try {
    const d = await apiFetch("/api/book/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId, title: t }),
    });
    if (S.bookId === bookId && S.book) S.book.title = t;
    await loadBooks();
    if (S.bookId === bookId && !$("view-project").classList.contains("hidden")) renderProject();
  } catch (e) {
    alert(bookApiFailHint(e, "重命名"));
  }
}

async function deleteBookProject(idEnc) {
  closeBookMenu();
  const bookId = decodeURIComponent(idEnc);
  const label = (S.booksList || []).find((b) => b.id === bookId)?.title || bookId;
  if (!confirm(`确定删除项目「${label}」？\n将永久删除本地目录与全部章节，不可恢复。`)) return;
  try {
    await apiFetch("/api/book/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId }),
    });
    if (S.bookId === bookId) {
      S.bookId = null; S.book = null; S.foundation = null; S.outlines = []; S.chaptersData = [];
      S.total = 0; S.autoRunning = false;
      goHome();
    } else {
      await loadBooks();
    }
  } catch (e) {
    alert(bookApiFailHint(e, "删除"));
  }
}

/** 项目重命名/删除失败时的友好提示（E109 = 后端路由未加载，非业务校验） */
function bookApiFailHint(e, action) {
  const { text, code } = formatErrorDisplay(e);
  if (code === "E109") {
    return `${action}失败：当前后端未加载项目操作接口。\n请在终端重新执行 npm start 后再试（修改 server.mjs 后必须重启）。`;
  }
  return `${action}失败：${text}`;
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

// ---------- 就绪检查：未配置密钥则提示并禁用需 API 的按钮 ----------
async function checkReady() {
  try {
    const d = await apiFetch("/api/ready");
    S.apiReady = !!d.ready;
    const banner = $("home-need-key");
    if (banner) banner.classList.toggle("hidden", S.apiReady);
    syncApiGatedButtons();
    updateHudStatus(S.apiReady);
    return S.apiReady;
  } catch {
    S.apiReady = false;
    syncApiGatedButtons();
    updateHudStatus(false);
    return false;
  }
}

function initHudClock() {
  const el = $("hud-clock");
  if (!el) return;
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

function updateHudStatus(ready) {
  const el = $("hud-sys-status");
  if (!el) return;
  if (ready) {
    el.classList.remove("hud-pill-warn");
    el.innerHTML = '<span class="pulse-dot"></span>服务就绪';
  } else {
    el.classList.add("hud-pill-warn");
    el.innerHTML = '<span class="pulse-dot warn-dot"></span>未配置密钥';
  }
}

function syncApiGatedButtons() {
  const ready = !!S.apiReady;
  const hotGuide = $("btn-hot-guide");
  const hotFill = $("btn-hot-fill");
  const gen = $("btn-gen");
  if (hotGuide) {
    hotGuide.disabled = !ready;
    hotGuide.title = ready ? "" : "请先在设置 → 模型服务中配置 API Key";
  }
  if (hotFill && !hotFill.classList.contains("hidden")) hotFill.disabled = !ready;
  if (gen && !S.foundationGenAc) {
    gen.disabled = !ready;
    gen.title = ready ? "" : "请先在设置 → 模型服务中配置 API Key";
  }
  const hotHint = $("hot-guide-hint");
  if (hotHint && !ready && $("hot-guide-wrap") && !$("hot-guide-wrap").classList.contains("hidden")) {
    hotHint.style.color = "var(--muted)";
    hotHint.textContent = "请先在设置 → 模型服务中配置 API Key";
  }
}

// ---------- 设置中心（Hub）：左菜单 + 各分区 ----------
function openHub(sec) { hubNav(sec || "models"); openModal("m-hub"); }
function openSettingsConfig() { openHub("models"); }   // 兼容旧入口（提示条按钮等）
function hubNav(sec) {
  const secs = ["models", "stages", "skills", "genres", "writing", "loop"];
  const s = secs.includes(sec) ? sec : "models";
  secs.forEach((x) => {
    $("hub-" + x).classList.toggle("hidden", x !== s);
    document.querySelector(`.hub-navi[data-sec="${x}"]`)?.classList.toggle("sel", x === s);
  });
  ({ models: loadModelsSection, stages: loadStagesSection, skills: loadSkillsSection, genres: loadGenresSection, writing: loadWritingSection, loop: loadLoopSection }[s])();
}

// ---------- 分区：模型服务（密钥 / 请求地址 / 模型列表）----------
function bindCfgKeyField() {
  const keyEl = $("cfg-key");
  if (!keyEl || keyEl.dataset.bound) return;
  keyEl.dataset.bound = "1";
  keyEl.addEventListener("focus", () => {
    if (!S.cfgKeyDirty && S.cfgHasKey && keyEl.value === S.cfgKeyMask) {
      keyEl.value = "";
      S.cfgKeyDirty = true;
    }
  });
  keyEl.addEventListener("blur", () => {
    if (S.cfgKeyDirty && !keyEl.value.trim() && S.cfgHasKey) {
      keyEl.value = S.cfgKeyMask;
      S.cfgKeyDirty = false;
    }
  });
  keyEl.addEventListener("input", () => { S.cfgKeyDirty = true; });
}

async function loadModelsSection() {
  try {
    const c = await apiFetch("/api/config");
    $("cfg-baseurl").value = c.baseUrl || "";
    $("cfg-temp").value = c.temperature ?? 0.7;
    S.cfgHasKey = !!c.hasKey;
    S.cfgKeyMask = c.hasKey ? (c.keyHint || "••••••••••••••••") : "";
    S.cfgKeyDirty = false;
    const keyEl = $("cfg-key");
    keyEl.value = S.cfgKeyMask;
    keyEl.type = "password";
    keyEl.placeholder = S.cfgHasKey ? "" : "请输入 API 密钥";
    bindCfgKeyField();
    S.cfgModels = (c.models || []).map((m) => ({ id: m.id, label: m.label || m.id, type: m.type || "text", thinking: m.thinking !== false }));
    S.cfgFast = c.fastModel; S.cfgStrong = c.strongModel;
    renderCfgModels();
    const st = $("cfg-key-state");
    if (c.hasKey) st.textContent = `（已保存，默认加密显示；留空保存则不改）`;
    else st.textContent = "（未配置）";
    $("cfg-hint").textContent = "";
  } catch { /* ignore */ }
}
function toggleKeyEye() {
  const el = $("cfg-key");
  if (el.type === "password") {
    el.type = "text";
    if (!S.cfgKeyDirty && S.cfgHasKey && !el.value.trim()) el.value = S.cfgKeyMask;
  } else {
    el.type = "password";
  }
}

// 渲染模型卡片列表 + 快/强模型下拉
function renderCfgModels() {
  const list = $("cfg-model-list");
  const models = S.cfgModels || [];
  if (!models.length) {
    list.innerHTML = `<div class="mdl-empty">还没有模型，点右上「＋ 手动添加」新增一个</div>`;
  } else {
    list.innerHTML = models.map((m, i) => `
      <div class="mdl-card">
        <div class="mdl-head">
          <span class="mdl-name">${esc(m.label)}</span>
          <span class="mdl-act">
            <a onclick="openModelEdit(${i})">编辑</a>
            <a class="del" onclick="delCfgModel(${i})">删除</a>
          </span>
        </div>
        <div class="mdl-id">${esc(m.id)}</div>
        <div class="mdl-tags">
          <span class="mdl-tag blue">${m.type === "reasoning" ? "推理模型" : "文本模型"}</span>
          ${m.thinking ? '<span class="mdl-tag">深度思考</span>' : ""}
        </div>
      </div>`).join("");
  }
  // 快/强模型下拉
  const opts = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}（${esc(m.id)}）</option>`).join("");
  const fast = $("cfg-fast"), strong = $("cfg-strong");
  fast.innerHTML = opts; strong.innerHTML = opts;
  if (models.some((m) => m.id === S.cfgFast)) fast.value = S.cfgFast; else if (models[0]) { fast.value = models[0].id; S.cfgFast = models[0].id; }
  if (models.some((m) => m.id === S.cfgStrong)) strong.value = S.cfgStrong; else if (models[0]) { strong.value = models[0].id; S.cfgStrong = models[0].id; }
}
// 打开「编辑模型」弹窗；idx=null 表示新增
function openModelEdit(idx) {
  S.cfgEditIdx = idx;
  const m = (idx == null) ? { label: "", id: "", type: "text", thinking: true } : S.cfgModels[idx];
  $("me-title").textContent = idx == null ? "添加模型" : "编辑模型";
  $("me-label").value = m.label || "";
  $("me-id").value = m.id || "";
  $("me-type").value = m.type || "text";
  document.querySelector(`input[name="me-think"][value="${m.thinking === false ? "0" : "1"}"]`).checked = true;
  openModal("m-model-edit");
}
function saveModelEdit() {
  const id = $("me-id").value.trim();
  if (!id) { alert("模型标识不能为空"); return; }
  const m = {
    id,
    label: $("me-label").value.trim() || id,
    type: $("me-type").value,
    thinking: (document.querySelector('input[name="me-think"]:checked')?.value ?? "1") === "1",
  };
  S.cfgModels = S.cfgModels || [];
  if (S.cfgEditIdx == null) S.cfgModels.push(m); else S.cfgModels[S.cfgEditIdx] = m;
  closeModal("m-model-edit");
  renderCfgModels();
}
function delCfgModel(i) {
  if (!confirm(`删除模型「${S.cfgModels[i]?.label || ""}」？`)) return;
  S.cfgModels.splice(i, 1);
  renderCfgModels();
}
async function saveConfig() {
  if (!(S.cfgModels || []).length) { $("cfg-hint").textContent = "请至少添加一个模型"; return; }
  const keyVal = $("cfg-key").value.trim();
  const payload = {
    baseUrl: $("cfg-baseurl").value.trim(),
    models: S.cfgModels,
    fastModel: $("cfg-fast").value,
    strongModel: $("cfg-strong").value,
    temperature: Number($("cfg-temp").value) || 0.7,
  };
  const keyChanged = keyVal && (!S.cfgHasKey || S.cfgKeyDirty) && keyVal !== S.cfgKeyMask;
  if (keyChanged) payload.apiKey = keyVal;
  else if (!S.cfgHasKey && !keyVal) {
    $("cfg-hint").style.color = "var(--warn)";
    $("cfg-hint").textContent = "请先填写 API 密钥";
    return;
  }
  try {
    const d = await apiFetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (d.ok) {
      $("cfg-hint").style.color = "var(--accent)";
      $("cfg-hint").textContent = d.hasKey ? "已保存，密钥就绪" : "已保存，但仍未检测到密钥";
      checkReady();
      await loadModelsSection();
    } else {
      $("cfg-hint").textContent = "保存失败";
    }
  } catch (e) { $("cfg-hint").textContent = toUserError(e); }
}

// ---------- 分区：Skills 技能管理（data/skills/<组>/*.md）----------
async function loadSkillsSection() {
  try { const d = await apiFetch("/api/skills"); S.skillGroups = d.groups || []; }
  catch { S.skillGroups = []; }
  S.skillSel = null; S.skillSelGroup = null;
  $("sk-name").value = ""; $("sk-content").value = ""; $("sk-hint").textContent = "";
  $("sk-reset").classList.add("hidden");
  renderSkillList();
}
function renderSkillList() {
  const q = ($("sk-search").value || "").trim();
  const list = $("sk-list");
  const groups = S.skillGroups || [];
  let html = "";
  for (const g of groups) {
    const items = (g.skills || []).filter((n) => !q || n.includes(q));
    if (!items.length && q) continue;
    html += `<div class="sk-item" style="cursor:default;background:#fafbfb;font-weight:700;color:var(--accent)">${esc(g.label)}</div>`;
    html += items.map((n) => `<div class="sk-item ${g.id === S.skillSelGroup && n === S.skillSel ? "sel" : ""}" onclick="selectSkill('${g.id}','${encodeURIComponent(n)}')" style="padding-left:26px">${esc(n)}</div>`).join("");
    if (!items.length) html += `<div class="sk-item" style="padding-left:26px;color:var(--muted);cursor:default">（空）</div>`;
  }
  list.innerHTML = html || `<div class="sk-empty">暂无技能</div>`;
}
async function selectSkill(group, enc) {
  const name = decodeURIComponent(enc);
  try {
    const d = await apiFetch(`/api/skill?group=${encodeURIComponent(group)}&name=${encodeURIComponent(name)}`);
    S.skillSel = d.name; S.skillSelGroup = d.group;
    $("sk-name").value = d.name; $("sk-content").value = d.content || "";
    $("sk-reset").classList.toggle("hidden", !d.hasDefault);
    $("sk-hint").style.color = "var(--muted)";
    $("sk-hint").textContent = d.builtin ? "内置技能：可直接修改，保存后立即生效；「恢复默认」可还原" : "";
    renderSkillList();
  } catch { /* ignore */ }
}
function newSkill() {
  S.skillSel = null; S.skillSelGroup = "custom";
  $("sk-name").value = ""; $("sk-content").value = "";
  $("sk-reset").classList.add("hidden");
  $("sk-hint").style.color = "var(--muted)";
  $("sk-hint").textContent = "新建自定义技能：填名称与内容后保存";
  renderSkillList();
}
async function saveSkill() {
  const name = $("sk-name").value.trim();
  if (!name) { $("sk-hint").textContent = "请填技能名称"; return; }
  const group = S.skillSelGroup || "custom";
  const d = await apiFetch("/api/skill/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group, name, content: $("sk-content").value }) });
  if (d.ok) { $("sk-hint").style.color = "var(--accent)"; $("sk-hint").textContent = "已保存（对应长篇/剧本流程立即生效）"; S.skillSel = d.name; S.skillSelGroup = d.group; await refreshSkillGroups(); }
  else { $("sk-hint").style.color = "var(--warn)"; $("sk-hint").textContent = "保存失败：" + (d.error || ""); }
}
async function refreshSkillGroups() { try { const d = await apiFetch("/api/skills"); S.skillGroups = d.groups || []; } catch { /* */ } renderSkillList(); }
async function resetSkill() {
  const name = $("sk-name").value.trim();
  if (!name || !S.skillSelGroup) return;
  if (!confirm(`把「${name}」恢复为内置默认内容？你的修改将被覆盖。`)) return;
  const d = await apiFetch("/api/skill/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: S.skillSelGroup, name }) });
  if (d.ok) { $("sk-content").value = d.content; $("sk-hint").style.color = "var(--accent)"; $("sk-hint").textContent = "已恢复默认"; }
  else { $("sk-hint").style.color = "var(--warn)"; $("sk-hint").textContent = d.error || "恢复失败"; }
}
async function deleteSkill() {
  const name = $("sk-name").value.trim();
  const group = S.skillSelGroup || "custom";
  if (!name || !S.skillSel) { $("sk-hint").textContent = "请先选中一个技能"; return; }
  const builtin = !$("sk-reset").classList.contains("hidden");
  if (!confirm(builtin ? `「${name}」是内置技能，删除后会自动恢复默认内容。继续？` : `删除技能「${name}」？`)) return;
  await fetch("/api/skill/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group, name }) });
  newSkill(); await refreshSkillGroups();
}

// ---------- 分区：题材设置（左列表 + 右编辑说明文本）----------
async function loadGenresSection() {
  try { const d = await apiFetch("/api/genres"); S.genres = d.genres || []; }
  catch { S.genres = []; }
  if (!S.genres.length) S.genres = [{ id: "other", label: "通用/自定义", panel: false, guide: "" }];
  S.genreSel = Math.min(S.genreSel ?? 0, S.genres.length - 1);
  $("gn-hint").textContent = "";
  renderGenreList();
  fillGenreEditor();
}
function renderGenreList() {
  const el = $("gn-list");
  if (!el) return;
  el.innerHTML = (S.genres || []).map((g, i) => {
    const name = g.label || g.id || "(未命名)";
    const mark = g.panel ? " · 面板" : "";
    return `<div class="sk-item ${i === S.genreSel ? "sel" : ""}" onclick="selectGenre(${i})">${esc(name)}<div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(g.id || "")}${mark}</div></div>`;
  }).join("");
}
function selectGenre(i) {
  S.genreSel = i;
  renderGenreList();
  fillGenreEditor();
}
function fillGenreEditor() {
  const g = (S.genres || [])[S.genreSel] || { id: "", label: "", panel: false, guide: "" };
  $("gn-id").value = g.id || "";
  $("gn-label").value = g.label || "";
  $("gn-panel").checked = !!g.panel;
  $("gn-guide").value = g.guide || "";
}
function syncGenreField(field) {
  if (!S.genres?.[S.genreSel]) return;
  if (field === "panel") S.genres[S.genreSel].panel = $("gn-panel").checked;
  else if (field === "id") S.genres[S.genreSel].id = $("gn-id").value;
  else if (field === "label") S.genres[S.genreSel].label = $("gn-label").value;
  else if (field === "guide") S.genres[S.genreSel].guide = $("gn-guide").value;
  if (field === "id" || field === "label" || field === "panel") renderGenreList();
}
function addGenre() {
  S.genres = S.genres || [];
  S.genres.push({ id: "new-genre", label: "新题材", panel: false, guide: "在这里写该题材的说明文本：核心套路、禁忌、节奏与面板要求等。" });
  S.genreSel = S.genres.length - 1;
  renderGenreList();
  fillGenreEditor();
}
function delSelectedGenre() {
  if (!S.genres?.length) return;
  if (S.genres.length <= 1) { $("gn-hint").textContent = "至少保留一个题材"; return; }
  if (!confirm("删除当前题材？")) return;
  S.genres.splice(S.genreSel, 1);
  S.genreSel = Math.max(0, S.genreSel - 1);
  renderGenreList();
  fillGenreEditor();
}
async function saveGenres() {
  // 先把编辑器当前值刷回
  syncGenreField("id"); syncGenreField("label"); syncGenreField("panel"); syncGenreField("guide");
  const genres = (S.genres || []).filter((g) => (g.id || "").trim());
  if (!genres.length) { $("gn-hint").textContent = "至少保留一个题材"; return; }
  const d = await apiFetch("/api/genres", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ genres }) });
  const el = $("gn-hint");
  if (d.ok) {
    el.style.color = "var(--accent)"; el.textContent = "已保存（建书时会注入题材说明）";
    S.genres = d.genres;
    S.genreSel = Math.min(S.genreSel ?? 0, S.genres.length - 1);
    renderGenreList(); fillGenreEditor();
  } else { el.style.color = "var(--warn)"; el.textContent = "保存失败：" + (d.error || ""); }
}

// ---------- 分区：自动写作配置（后台任务停止条件）----------
async function loadWritingSection() {
  try {
    const d = await apiFetch("/api/writing-config");
    const c = d.config || {};
    $("wr-stop-ch").value = c.stopAtChapter ?? 0;
    $("wr-stop-hours").value = c.stopAfterHours ?? 0;
    $("wr-stop-token").checked = c.stopOnTokenError !== false;
    $("wr-stop-quota").checked = c.stopOnQuotaError !== false;
    $("wr-oaudit").value = c.outlineAuditMaxRounds ?? 2;
    $("wr-review").value = c.autoReviewMaxRounds ?? 3;
    $("wr-hint").textContent = "";
  } catch { /* ignore */ }
  const osEl = $("wr-script-os");
  if (osEl && !osEl.dataset.inited) {
    osEl.value = detectScriptOs();
    osEl.dataset.inited = "1";
  }
  await refreshScriptKinds();
}
async function saveWritingConfig() {
  const config = {
    stopAtChapter: Number($("wr-stop-ch").value),
    stopAfterHours: Number($("wr-stop-hours").value),
    stopOnTokenError: $("wr-stop-token").checked,
    stopOnQuotaError: $("wr-stop-quota").checked,
    outlineAuditMaxRounds: Number($("wr-oaudit").value),
    autoReviewMaxRounds: Number($("wr-review").value),
  };
  const d = await apiFetch("/api/writing-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }) });
  const el = $("wr-hint");
  if (d.ok) { el.style.color = "var(--accent)"; el.textContent = "已保存（对之后启动的自动任务生效）"; }
  else { el.style.color = "var(--warn)"; el.textContent = "保存失败"; }
}

// ---------- 分区：Loop 流程配置 ----------
const LOOP_MODES = ["foundation", "auto", "manual"];
const LOOP_FALLBACK_DEFS = {
  foundation_frame: { label: "故事框架与世界观", desc: "生成全书骨架与核心设定" },
  foundation_volume: { label: "分卷卷纲 / 幕场结构", desc: "规划分卷或幕场结构" },
  foundation_roles: { label: "角色卡", desc: "生成主要角色设定" },
  foundation_rules: { label: "创作规则", desc: "全书创作约束与禁忌" },
  foundation_hooks: { label: "伏笔 / 戏剧钩子", desc: "伏笔清单或戏剧钩子" },
  foundation_style: { label: "文风指南", desc: "叙事风格与语言要求" },
  outline_generate: { label: "生成章纲（每组5章）", desc: "进入新一组时生成章纲" },
  outline_manual: { label: "人工确认章纲", desc: "弹窗审阅、编辑章纲（人工模式）" },
  outline_audit: { label: "章纲自动审计", desc: "结构审计并按意见自动修订" },
  write: { label: "撰写正文", required: true, desc: "核心写作步骤，不可删除" },
  chapter_manual: { label: "人工审阅正文", desc: "草稿完成后人工确认（人工模式）" },
  chapter_auto_review: { label: "正文自动审改", desc: "审计并按等级自动修订循环" },
  panel_update: { label: "更新人物面板", desc: "定稿后同步人物属性面板" },
};
const LOOP_FALLBACK_DEFAULTS = {
  foundation: ["foundation_frame", "foundation_volume", "foundation_roles", "foundation_rules", "foundation_hooks", "foundation_style"],
  auto: ["outline_generate", "outline_audit", "write", "chapter_auto_review", "panel_update"],
  manual: ["outline_generate", "outline_manual", "write", "chapter_manual", "chapter_auto_review", "panel_update"],
};

async function ensureLoopConfig() {
  if (S.loopConfig && S.loopDefs) return;
  try {
    const d = await apiFetch("/api/writing-config");
    S.loopConfig = d.config?.loops || { ...LOOP_FALLBACK_DEFAULTS };
    S.loopDefs = d.loopDefs || LOOP_FALLBACK_DEFS;
    S.loopDefaults = d.defaultLoops || LOOP_FALLBACK_DEFAULTS;
  } catch {
    S.loopConfig = { ...LOOP_FALLBACK_DEFAULTS };
    S.loopDefs = LOOP_FALLBACK_DEFS;
    S.loopDefaults = LOOP_FALLBACK_DEFAULTS;
  }
}

function hasLoop(mode, id) {
  const list = S.loopConfig?.[mode] || S.loopDefaults?.[mode] || LOOP_FALLBACK_DEFAULTS[mode] || [];
  return list.includes(id);
}

function loopDef(id) {
  return S.loopDefs?.[id] || LOOP_FALLBACK_DEFS[id] || { label: id, desc: "" };
}

function allowedLoopNodes(mode) {
  const defs = S.loopDefs || LOOP_FALLBACK_DEFS;
  return Object.keys(defs).filter((id) => {
    const d = defs[id];
    if (mode === "foundation") return id.startsWith("foundation_");
    if (d.modes && !d.modes.includes(mode)) return false;
    return !id.startsWith("foundation_");
  });
}

async function loadLoopSection() {
  await ensureLoopConfig();
  S.loopEditMode = S.loopEditMode || "foundation";
  renderLoopModeTabs();
  renderLoopList();
}

function switchLoopMode(mode) {
  if (!LOOP_MODES.includes(mode)) return;
  S.loopEditMode = mode;
  renderLoopModeTabs();
  renderLoopList();
}

function renderLoopModeTabs() {
  document.querySelectorAll("#loop-mode-tabs .loop-mode-tab").forEach((el) => {
    el.classList.toggle("sel", el.dataset.mode === S.loopEditMode);
  });
}

function renderLoopList() {
  const mode = S.loopEditMode;
  const list = S.loopConfig[mode] || [];
  const box = $("loop-list");
  if (!box) return;
  box.innerHTML = list.map((id, i) => {
    const d = loopDef(id);
    const req = d.required || id === "write";
    return `<div class="loop-item" data-i="${i}">
      <span class="loop-ord">${i + 1}</span>
      <div class="loop-info">
        <div class="loop-label">${esc(d.label || id)}${req ? " <span style='color:var(--muted);font-size:11px'>(必填)</span>" : ""}</div>
        <div class="loop-desc">${esc(d.desc || "")}</div>
      </div>
      <div class="loop-acts">
        <button type="button" class="ghost" onclick="moveLoopNode(${i},-1)" ${i === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="ghost" onclick="moveLoopNode(${i},1)" ${i === list.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" style="color:#c0392b" onclick="removeLoopNode(${i})" ${req ? "disabled" : ""}>删除</button>
      </div>
    </div>`;
  }).join("") || `<p class="hint">当前流程为空，请从下方添加节点。</p>`;
  const sel = $("loop-add-select");
  if (sel) {
    const unused = allowedLoopNodes(mode).filter((id) => !list.includes(id));
    sel.innerHTML = unused.length
      ? unused.map((id) => `<option value="${esc(id)}">${esc(loopDef(id).label || id)}</option>`).join("")
      : `<option value="">（无可添加节点）</option>`;
  }
}

function moveLoopNode(i, dir) {
  const mode = S.loopEditMode;
  const list = [...(S.loopConfig[mode] || [])];
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  S.loopConfig[mode] = list;
  renderLoopList();
}

function removeLoopNode(i) {
  const mode = S.loopEditMode;
  const list = [...(S.loopConfig[mode] || [])];
  const id = list[i];
  if (!id || loopDef(id).required || id === "write") return;
  list.splice(i, 1);
  S.loopConfig[mode] = list;
  renderLoopList();
}

function addLoopNode() {
  const mode = S.loopEditMode;
  const id = $("loop-add-select")?.value;
  if (!id) return;
  const list = [...(S.loopConfig[mode] || [])];
  if (list.includes(id)) return;
  list.push(id);
  S.loopConfig[mode] = list;
  renderLoopList();
}

function resetLoopMode() {
  const mode = S.loopEditMode;
  S.loopConfig[mode] = [...(S.loopDefaults?.[mode] || LOOP_FALLBACK_DEFAULTS[mode] || [])];
  renderLoopList();
}

async function saveLoopConfig() {
  const el = $("loop-hint");
  try {
    const d = await apiFetch("/api/writing-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { loops: S.loopConfig } }),
    });
    if (d.ok) {
      S.loopConfig = d.config?.loops || S.loopConfig;
      el.style.color = "var(--accent)";
      el.textContent = "已保存（对之后启动的建书/写作任务生效）";
    } else {
      el.style.color = "var(--warn)";
      el.textContent = "保存失败";
    }
  } catch {
    el.style.color = "var(--warn)";
    el.textContent = "保存失败";
  }
}

function detectScriptOs() {
  const ua = navigator.userAgent || "";
  if (/Mac|iPhone|iPad/i.test(ua)) return "mac";
  return "windows";
}
function updateScriptHowto() {
  const os = $("wr-script-os")?.value || "windows";
  const el = $("wr-script-howto");
  if (!el) return;
  if (os === "mac") {
    el.innerHTML = "下载后在「终端」执行：<code>chmod +x 文件名.sh && ./文件名.sh</code>，或 <code>bash 文件名.sh</code>。<br>"
      + "「防止电脑休眠」会一直占着终端（caffeinate），用 <kbd>Ctrl+C</kbd> 结束即恢复。<br>"
      + "防休眠也可：系统设置 → 电池/电源适配器 → 暂时关闭睡眠。";
  } else {
    el.innerHTML = "下载 <code>.ps1</code> 后：右键 →「使用 PowerShell 运行」；若被拦截，在 PowerShell 里执行：<br>"
      + "<code>powershell -ExecutionPolicy Bypass -File .\\文件名.ps1</code><br>"
      + "「防止电脑休眠 / 恢复休眠」需<strong>管理员</strong> PowerShell。也可：设置 → 系统 → 电源 → 插电时睡眠设为「从不」。";
  }
}
async function refreshScriptKinds() {
  const os = $("wr-script-os")?.value || "windows";
  const sel = $("wr-script-kind");
  if (!sel) return;
  const prev = sel.value;
  try {
    const d = await apiFetch(`/api/scripts?os=${encodeURIComponent(os)}`);
    sel.innerHTML = (d.scripts || []).map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  } catch {
    sel.innerHTML = `<option value="auto-stop">停止当前自动任务</option>`;
  }
  updateScriptHowto();
}
function fillScriptBookFromCurrent() {
  const el = $("wr-script-book");
  if (!el) return;
  if (S.bookId) { el.value = S.bookId; $("wr-script-hint").textContent = "已填入当前书"; }
  else { $("wr-script-hint").textContent = "当前没有打开的书"; }
}
async function downloadAutoScript() {
  const os = $("wr-script-os")?.value || "windows";
  const kind = $("wr-script-kind")?.value || "auto-status";
  const bookId = ($("wr-script-book")?.value || "").trim();
  const q = new URLSearchParams({ os, kind });
  if (bookId) q.set("bookId", bookId);
  const hint = $("wr-script-hint");
  if (hint) { hint.style.color = "var(--accent)"; hint.textContent = "正在下载…"; }
  try {
    const r = await fetch(`/api/scripts/download?${q}`);
    if (!r.ok) {
      let msg = `下载失败 (${r.status})`;
      try { const j = await readJsonResponse(r); if (j.error) msg = j.error; } catch { /* */ }
      throw new Error(msg);
    }
    const cd = r.headers.get("Content-Disposition") || "";
    const m = /filename="([^"]+)"/i.exec(cd);
    const name = m?.[1] || `jace-${kind}.${os === "mac" ? "sh" : "ps1"}`;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (hint) hint.textContent = `已下载 ${name}，按上方说明执行即可`;
  } catch (e) {
    if (hint) { hint.style.color = "var(--warn)"; hint.textContent = toUserError(e); }
  }
}
async function resumeBook(idEnc) {
  const bookId = decodeURIComponent(idEnc);
  try {
    const d = await apiFetch(`/api/resume?bookId=${encodeURIComponent(bookId)}`);
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
    try { auto = await apiFetch(`/api/auto/status?bookId=${encodeURIComponent(bookId)}`); } catch { /* */ }
    if (auto && auto.running) { enterAutoUI(); pollAuto(); }
    else showProject();
    loadBooks();
  } catch (e) { alert("恢复失败：" + toUserError(e)); }
}

// ========== 视图切换 ==========
function toggleContextPanel(forceOpen) {
  const layout = $("ws-layout");
  const fab = $("ctx-expand-fab");
  if (!layout) return;
  const collapsed = layout.classList.contains("ctx-collapsed");
  const open = forceOpen === true ? true : forceOpen === false ? false : collapsed;
  layout.classList.toggle("ctx-collapsed", !open);
  if (fab) fab.style.display = open ? "none" : "inline-flex";
  try { localStorage.setItem("jace_ctx_collapsed", open ? "0" : "1"); } catch { /* */ }
}

let ctxTab = "struct";

function switchCtxTab(tab) {
  ctxTab = tab;
  document.querySelectorAll("#ctx-tabs .intel-tab, #ctx-tabs .ctx-tab").forEach((el) => {
    el.classList.toggle("sel", el.dataset.ctx === tab);
  });
  document.querySelectorAll("#cards .ctx-pane").forEach((el) => {
    el.classList.toggle("active", el.dataset.pane === tab);
  });
  try { localStorage.setItem("jace_ctx_tab", tab); } catch { /* */ }
}

function initContextPanel() {
  try {
    if (localStorage.getItem("jace_ctx_collapsed") === "1") toggleContextPanel(false);
    const saved = localStorage.getItem("jace_ctx_tab");
    if (saved && ["struct", "roles", "rules", "panel"].includes(saved)) ctxTab = saved;
  } catch { /* */ }
}

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
    $("pj-task").innerHTML = `<b>自动连写中</b> · ${esc(S.autoMsg || "运行中…")}`;
    $("pj-actions").innerHTML = `<div class="tab sel" onclick="stopAuto()">停止自动连写</div>`;
    $("pj-chapters").innerHTML = chs.length
      ? chs.map((c) => chapRowHtml(c)).join("")
      : `<p class="dock-empty">正在生成第 1 章…</p>`;
    return;
  }
  // 组末（写完每组第4章：4/9/14…）需先审阅下一组大纲，通过后再写下一章
  const nextGroupStart = Math.floor(lastN / 5) * 5 + 6; // 4→6, 9→11…
  const grp = (S.outlines || []).filter((o) => o.n >= nextGroupStart && o.n < nextGroupStart + 5);
  const needOutlineStep = lastN > 0 && lastN % 5 === 4 && (grp.length === 0 || grp.some((o) => !o.confirmed));
  if (last && !isAudited(last.status)) {
    taskHtml = `当前任务：<b>第 ${last.n} 章</b> · 草稿已生成，待审计`;
    actions = `<div class="tab sel" onclick="openChapter(${last.n})">审阅 / 审计第 ${last.n} 章</div>`;
  } else if (needOutlineStep) {
    taskHtml = `当前任务：<b>第 ${nextGroupStart}-${nextGroupStart + 4} 章大纲</b> · ${grp.length ? "待审阅" : "待生成"}`;
    actions = `<div class="tab sel" onclick="startMidbookOutline(${nextGroupStart})">${grp.length ? "审阅" : "生成"}第 ${nextGroupStart}-${nextGroupStart + 4} 章大纲</div>`
      + `<div class="tab" onclick="writeChapter(${nextN})">跳过，直接写第 ${nextN} 章</div>`;
  } else {
    taskHtml = chs.length
      ? `当前任务：<b>第 ${nextN} 章</b> · 正文编写${target ? `（全书 ${target} 章）` : ""}`
      : "当前任务：<b>第 1 章</b> · 正文编写";
    actions = `<div class="tab sel" onclick="writeChapter(${nextN})">生成第 ${nextN} 章</div>`;
  }
  actions += `<div class="tab" onclick="autoComplete()">自动写到完本</div>`;
  $("pj-task").innerHTML = taskHtml;
  $("pj-actions").innerHTML = actions;
  $("pj-chapters").innerHTML = chs.length
    ? chs.map((c) => chapRowHtml(c, { showDel: true })).join("")
    : `<p class="dock-empty">暂无章节 · 点击上方「生成第 1 章」</p>`;
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
    const d = await apiFetch("/api/chapter/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, n }) });
    if (d.error) throw new Error(d.error);
    // 本地同步：移除 >= n 的章节，当前任务回到"上一节点的下一步"
    S.chaptersData = chs.filter((c) => c.n < n);
    S.total = S.chaptersData.length;
    loadBooks();
    showProject();
  } catch (e) { alert("删除失败：" + toUserError(e)); }
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
    $("cd-actions").innerHTML = `<div class="tab sel" onclick="writeChapter(${n})">生成本章</div>`;
  }
}
// 单章操作按钮：已审计→编辑/重写/修改/重新审计；草稿→审计/修订/重写
function renderChapterActions(status) {
  if (isAudited(status)) {
    $("cd-actions").innerHTML = `
      <div class="tab" onclick="editChapterText()">编辑正文</div>
      <div class="tab" onclick="reReviseChapter()">修改（给意见）</div>
      <div class="tab" onclick="reRewriteChapter()">重写本章</div>
      <div class="tab" onclick="reAuditChapter()">重新审计</div>`;
  } else {
    $("cd-actions").innerHTML = `
      <div class="tab sel" onclick="reAuditChapter()">审计本章</div>
      <div class="tab" onclick="reReviseChapter()">修订（给意见）</div>
      <div class="tab" onclick="reRewriteChapter()">重写本章</div>`;
  }
}
// 单章详情右侧：结构 Tab 展示本章章纲/所属卷；角色/规则/面板走统一分栏
function renderChapterSidebar(n) {
  renderCards({ chapterN: n });
}

/** 本章结构区：聚焦当前章所在 5 章组章纲 + 所属卷 */
function chapterStructHtml(n) {
  const GROUP = 5;
  const outlines = S.outlines || [];
  const groupEnd = Math.ceil(n / GROUP) * GROUP;
  const groupStart = groupEnd - GROUP + 1;
  const inGroup = outlines.filter((o) => o.n >= groupStart && o.n <= groupEnd);
  const before = outlines.filter((o) => o.n < groupStart);
  const olItem = (o, open) => `<details ${open ? "open" : ""}><summary>第${o.n}章 ${esc(o.title)}${o.n === n ? " · 本章" : ""}</summary><p class="ol-sum" style="margin:4px 0">${esc(o.summary)}</p><div class="mdbox" style="max-height:200px">${mdToHtml(o.detail)}</div></details>`;
  const groupHtml = inGroup.length
    ? inGroup.map((o) => olItem(o, o.n === n)).join("")
    : `<p class="ctx-empty">本组（第 ${groupStart}-${groupEnd} 章）尚无章纲。</p>`;
  const beforeHtml = before.length
    ? `<details class="vol-drawer"><summary>展开前 ${before.length} 章章纲（第 1-${groupStart - 1} 章）</summary>${before.map((o) => olItem(o, false)).join("")}</details>`
    : "";
  const vols = splitVolumes(S.foundation?.volume_map || "");
  let volCard = "";
  if (vols.length) {
    const per = Math.max(1, Math.ceil((S.book?.targetChapters || 100) / vols.length));
    const cur = Math.min(vols.length - 1, Math.floor((n - 1) / per));
    const others = vols.map((_, i) => i).filter((i) => i !== cur);
    const otherHtml = others.length
      ? `<details class="vol-drawer"><summary>展开其余 ${others.length} 卷卷纲</summary>${others.map((i) => `<details><summary>${esc(vols[i].title)}</summary><div class="mdbox">${mdToHtml(vols[i].body)}</div></details>`).join("")}</details>`
      : "";
    volCard = `<div class="ref-block"><div class="ref-block-head"><h4>本章所属卷（第 ${cur + 1} 卷）</h4></div><div class="ref-body"><details open><summary>${esc(vols[cur].title)}</summary><div class="mdbox">${mdToHtml(vols[cur].body)}</div></details>${otherHtml}</div></div>`;
  }
  return `
    <div class="ref-block">
      <div class="ref-block-head"><h4>章纲（第 ${groupStart}-${groupEnd} 章，聚焦第 ${n} 章）</h4></div>
      <div class="ref-body">${beforeHtml}${groupHtml}</div>
    </div>
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
  $("cd-actions").innerHTML = `<div class="tab sel" onclick="saveChapterText()">保存正文</div><div class="tab" onclick="openChapter(${S.chapter})">取消</div>`;
}
async function saveChapterText() {
  const content = $("edit-body").value;
  try {
    await fetch("/api/chapter/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, n: S.chapter, content }) });
    const c = (S.chaptersData || []).find((x) => x.n === S.chapter); if (c) c.content = content;
    openChapter(S.chapter);
    flashProgress("stage", "正文已保存");
  } catch (e) {
    flashProgress("stage", "保存失败：" + toUserError(e), { ok: false, ms: 4000 });
  }
}

// ---------- 模型配置 ----------
function openModelConfig() { openHub("stages"); }   // 兼容旧入口
async function loadStagesSection() {
  const d = await apiFetch("/api/model-config");
  $("model-rows").innerHTML = d.stages.map((s) => {
    const opts = d.models.map((m) => `<option value="${m.id}" ${d.config[s.key] === m.id ? "selected" : ""}>${esc(m.label)}</option>`).join("");
    return `<label style="display:flex;align-items:center;gap:12px;margin:8px 0">
      <span style="flex:0 0 130px;color:var(--ink)">${s.label}</span>
      <select data-stage="${s.key}" style="flex:1">${opts}</select></label>`;
  }).join("");
}
async function saveModelConfig() {
  const config = {};
  $("model-rows").querySelectorAll("select").forEach((sel) => { config[sel.dataset.stage] = sel.value; });
  const el = $("stage-hint");
  try {
    const d = await apiFetch("/api/model-config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }),
    });
    el.style.color = "var(--accent)"; el.textContent = "已保存";
  } catch (e) {
    el.style.color = "var(--warn)"; el.textContent = toUserError(e);
  }
}

// ---------- 首页 → 初始设定 ----------
async function openSettings(kind) {
  S.kind = kind;
  S.hotChannels = [];
  S.hotChannelId = null;
  S.hotTypeId = null;
  S.hotOverview = "";
  $("settings-title").textContent = (kind === "longform" ? "长篇小说" : "剧本创作") + " · 初始设定";
  const genBtn = $("btn-gen");
  if (genBtn) genBtn.textContent = kind === "script" ? "生成剧本结构与人物" : "生成大纲与世界观";
  resetGenFoundationUI();
  hideProgress("gen-progress");
  const tWrap = $("f-target")?.parentElement?.querySelector("label");
  const wWrap = $("f-words")?.parentElement?.querySelector("label");
  if (tWrap) tWrap.textContent = kind === "script" ? "目标场数" : "目标章数";
  if (wWrap) wWrap.textContent = kind === "script" ? "每场字数" : "每章字数";
  const hotWrap = $("hot-guide-wrap");
  if (hotWrap) hotWrap.classList.toggle("hidden", kind !== "longform");
  resetHotGuideUI();
  // 建书表单默认章数/字数：剧本略小；不读「自动写作配置」（那是任务停止条件）
  try {
    const g = await apiFetch("/api/genres");
    if (Array.isArray(g.genres) && g.genres.length) {
      $("f-genre").innerHTML = g.genres.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join("");
    }
    if (kind === "script") {
      $("f-target").value = 40;
      $("f-words").value = 1200;
    } else {
      $("f-target").value = 200;
      $("f-words").value = 3000;
    }
  } catch { /* 用页面默认 */ }
  await checkReady();
  openModal("m-settings");
}

function resetHotGuideUI() {
  const hotOut = $("hot-guide-out");
  if (hotOut) { hotOut.classList.add("hidden"); hotOut.textContent = ""; }
  const ov = $("hot-guide-overview");
  if (ov) { ov.classList.add("hidden"); ov.textContent = ""; }
  const tabsWrap = $("hot-guide-tabs-wrap");
  if (tabsWrap) tabsWrap.classList.add("hidden");
  const chTabs = $("hot-guide-channel-tabs");
  if (chTabs) chTabs.innerHTML = "";
  const typeTabs = $("hot-guide-type-tabs");
  if (typeTabs) typeTabs.innerHTML = "";
  const fill = $("btn-hot-fill");
  if (fill) fill.classList.add("hidden");
  const hotHint = $("hot-guide-hint");
  if (hotHint) {
    hotHint.style.color = "var(--muted)";
    hotHint.textContent = "先出约150字市场综述，再选男频/女频与热点类型";
  }
  $("hot-guide-progress")?.classList.add("hidden");
  const hp = $("hot-guide-progress");
  if (hp) hp.innerHTML = "";
}

function getHotChannel() {
  return (S.hotChannels || []).find((c) => c.id === S.hotChannelId) || null;
}

function getHotType() {
  const ch = getHotChannel();
  return (ch?.types || []).find((t) => t.id === S.hotTypeId) || null;
}

function renderHotGuideTabs() {
  const chBox = $("hot-guide-channel-tabs");
  const typeBox = $("hot-guide-type-tabs");
  const tabsWrap = $("hot-guide-tabs-wrap");
  const out = $("hot-guide-out");
  const ov = $("hot-guide-overview");
  const fill = $("btn-hot-fill");
  if (ov) {
    if (S.hotOverview) {
      ov.classList.remove("hidden");
      ov.innerHTML = `<div style="font-size:12px;color:var(--muted);margin-bottom:4px">市场综述 · 约150字</div><div>${esc(S.hotOverview)}</div>`;
    } else {
      ov.classList.add("hidden");
      ov.textContent = "";
    }
  }
  const channels = S.hotChannels || [];
  if (!channels.length || !chBox) {
    if (tabsWrap) tabsWrap.classList.add("hidden");
    if (chBox) chBox.innerHTML = "";
    if (typeBox) typeBox.innerHTML = "";
    if (fill) fill.classList.add("hidden");
    if (out) { out.classList.add("hidden"); out.textContent = ""; }
    return;
  }
  if (tabsWrap) tabsWrap.classList.remove("hidden");
  chBox.innerHTML = channels.map((c) =>
    `<div class="tab ${c.id === S.hotChannelId ? "sel" : ""}" data-id="${esc(c.id)}" onclick="selectHotChannel('${c.id}')">${esc(c.label)}</div>`
  ).join("");
  const ch = getHotChannel();
  const types = ch?.types || [];
  if (typeBox) {
    typeBox.innerHTML = types.map((t) =>
      `<div class="tab ${t.id === S.hotTypeId ? "sel" : ""}" data-id="${esc(t.id)}" onclick="selectHotType('${t.id}')">${esc(t.label)}</div>`
    ).join("");
  }
  const cur = getHotType();
  if (fill) {
    fill.classList.toggle("hidden", !cur);
    fill.disabled = !S.apiReady;
  }
  if (out) {
    if (cur && ch) {
      out.classList.remove("hidden");
      out.innerHTML = `<div style="font-size:12px;color:var(--muted);margin-bottom:4px">${esc(ch.label)} · ${esc(cur.label)} · 约150字</div><div>${esc(cur.guide)}</div>`;
    } else {
      out.classList.add("hidden");
      out.textContent = "";
    }
  }
}

function selectHotChannel(id) {
  S.hotChannelId = id;
  const ch = getHotChannel();
  S.hotTypeId = ch?.types?.[0]?.id || null;
  renderHotGuideTabs();
  const hint = $("hot-guide-hint");
  if (hint && ch) {
    hint.style.color = "var(--accent)";
    hint.textContent = `已选${ch.label}，请点下方热点类型 TAB`;
  }
}

function selectHotType(id) {
  S.hotTypeId = id;
  renderHotGuideTabs();
  const ch = getHotChannel();
  const t = getHotType();
  const hint = $("hot-guide-hint");
  if (hint && ch && t) {
    hint.style.color = "var(--accent)";
    hint.textContent = `已选${ch.label}·${t.label}，可点「AI 一键生成」`;
  }
}

/** @deprecated 兼容旧 onclick */
function selectHotTab(id) {
  const ch = (S.hotChannels || []).find((c) => (c.types || []).some((t) => t.id === id));
  if (ch) { selectHotChannel(ch.id); selectHotType(id); }
}

async function runHotNovelGuide() {
  if (S.kind !== "longform") return;
  if (!S.apiReady) { openSettingsConfig(); return; }
  const btn = $("btn-hot-guide");
  const hint = $("hot-guide-hint");
  if (btn) btn.disabled = true;
  if (hint) { hint.style.color = "var(--muted)"; hint.textContent = "正在探测市场热榜与生成指导…"; }
  S.hotChannels = [];
  S.hotChannelId = null;
  S.hotTypeId = null;
  S.hotOverview = "";
  renderHotGuideTabs();
  const prog = startApiProgress("hot-guide-progress", { etaSec: ETA_BASELINE_SEC.hotGuide });
  prog.detail({
    msg: "正在获取热点类型：男频类型；女频类型",
    percent: 3,
    remaining: "市场综述、男频/女频 TAB",
    etaSec: ETA_BASELINE_SEC.hotGuide,
    resetStep: true,
  });
  const genreSel = $("f-genre");
  const genreLabel = genreSel?.selectedOptions?.[0]?.textContent?.trim() || "";
  await new Promise((resolve) => {
    streamPost("/api/hot-novel-guide", {
      genre: genreSel?.value || "",
      genreLabel,
      title: $("f-title")?.value?.trim() || "",
      settings: $("f-settings")?.value || "",
    }, {
      progressEl: null,
      onStage: (s) => {
        prog.detail({
          msg: s.msg,
          percent: s.percent,
          remaining: s.remaining,
          etaSec: s.etaSec ?? ETA_BASELINE_SEC.hotGuide,
          resetStep: /正在获取|正在结合|重新/.test(String(s.msg || "")),
        });
      },
      onEvent: (ev, d) => {
        if (ev === "done") {
          S.hotOverview = d.overview || "";
          S.hotChannels = Array.isArray(d.channels) && d.channels.length
            ? d.channels
            : normalizeHotChannelsFromTabs(d.tabs || []);
          if (!S.hotOverview && !S.hotChannels.length) {
            prog.stop("");
            if (hint) { hint.style.color = "var(--warn)"; hint.textContent = clientErr("1011").error; }
            resolve();
            return;
          }
          S.hotChannelId = S.hotChannels.find((c) => c.id === "male")?.id || S.hotChannels[0]?.id || null;
          const ch0 = getHotChannel();
          S.hotTypeId = ch0?.types?.[0]?.id || null;
          renderHotGuideTabs();
          const src = (d.sources || []).filter((s) => s.count > 0).map((s) => `${s.platform}${s.count}条`).join(" · ") || "常识兜底";
          if (hint) {
            hint.style.color = "var(--accent)";
            hint.textContent = `综述已出 · 请选频向与热点类型 · ${src}`;
          }
          prog.stop(`完成 · ${src}`);
          resolve();
        } else if (ev === "error" || ev === "abort") {
          prog.stop("");
          if (hint) {
            hint.style.color = "var(--warn)";
            hint.textContent = ev === "abort" ? "已取消" : toUserError(d);
          }
          resolve();
        }
      },
    });
  });
  if (btn) btn.disabled = false;
}

function normalizeHotChannelsFromTabs(tabs) {
  const map = { male: { id: "male", label: "男频", types: [] }, female: { id: "female", label: "女频", types: [] } };
  for (const t of tabs) {
    const chId = t.channel === "female" || String(t.label || "").includes("女") ? "female" : "male";
    map[chId].types.push({
      id: t.id || `${chId}-t${map[chId].types.length}`,
      label: t.typeLabel || String(t.label || "").replace(/^[男女]频[·•]?\s*/, "") || "热点方向",
      guide: t.guide || "",
    });
  }
  return Object.values(map).filter((c) => c.types.length);
}

function applyFormGenre(genreId, genreLabel) {
  const sel = $("f-genre");
  if (!sel) return false;
  const opts = [...sel.options];
  let hit = genreId ? opts.find((o) => o.value === genreId) : null;
  if (!hit && genreLabel) {
    const lab = String(genreLabel).trim();
    hit = opts.find((o) => o.textContent.trim() === lab)
      || opts.find((o) => o.textContent.includes(lab) || lab.includes(o.textContent.trim()));
  }
  if (hit) {
    sel.value = hit.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}

async function runHotNovelFill() {
  if (S.kind !== "longform") return;
  if (!S.apiReady) { openSettingsConfig(); return; }
  const ch = getHotChannel();
  const type = getHotType();
  if (!ch || !type) {
    const hint = $("hot-guide-hint");
    if (hint) { hint.style.color = "var(--warn)"; hint.textContent = "请先选择频向与热点类型 TAB"; }
    return;
  }
  const btn = $("btn-hot-fill");
  const hint = $("hot-guide-hint");
  if (btn) btn.disabled = true;
  if (hint) { hint.style.color = "var(--muted)"; hint.textContent = "AI 正在生成书名、题材与初始设定…"; }
  const prog = startApiProgress("hot-guide-progress", { etaSec: ETA_BASELINE_SEC.hotFill });
  prog.detail({
    msg: `已选：${ch.label} · ${type.label}`,
    percent: 5,
    remaining: "题材列表、书名、初始设定",
    etaSec: ETA_BASELINE_SEC.hotFill,
    resetStep: true,
  });
  await new Promise((resolve) => {
    streamPost("/api/hot-novel-fill", {
      label: `${ch.label}·${type.label}`,
      channelLabel: ch.label,
      typeLabel: type.label,
      guide: type.guide,
      overview: S.hotOverview || "",
    }, {
      progressEl: null,
      onStage: (s) => {
        prog.detail({
          msg: s.msg,
          percent: s.percent,
          remaining: s.remaining,
          etaSec: s.etaSec ?? ETA_BASELINE_SEC.hotFill,
          resetStep: /正在结合|已选|正在加载/.test(String(s.msg || "")),
        });
      },
      onEvent: (ev, d) => {
        if (ev === "done") {
          if (d.title) $("f-title").value = d.title;
          const genreOk = applyFormGenre(d.genreId, d.genreLabel);
          if (d.settings) $("f-settings").value = d.settings;
          if (hint) {
            hint.style.color = "var(--accent)";
            const gLabel = d.genreLabel || (genreOk ? $("f-genre")?.selectedOptions?.[0]?.textContent?.trim() : "") || d.genreId || "";
            hint.textContent = `已填入：${d.title || ""} · ${gLabel || "题材未匹配"}（可再改后再生成大纲）`;
            if (!genreOk && d.genreId) {
              hint.textContent += " · 题材下拉未匹配，请手动选择";
              hint.style.color = "var(--warn)";
            }
          }
          prog.stop("已反显到表单");
          resolve();
        } else if (ev === "error" || ev === "abort") {
          prog.stop("");
          if (hint) {
            hint.style.color = "var(--warn)";
            hint.textContent = ev === "abort" ? "已取消" : toUserError(d);
          }
          resolve();
        }
      },
    });
  });
  if (btn) btn.disabled = false;
}

// ---------- 生成大纲/世界观 ----------
let foundationProg = null;

function genFoundation() {
  const title = $("f-title").value.trim();
  if (!title) { alert("请输入书名"); return; }
  if (!S.apiReady) { openSettingsConfig(); return; }
  if (S.foundationGenAc) cancelGenFoundation();
  const label = genFoundationBtnLabel();
  $("btn-gen").disabled = true;
  $("btn-gen").textContent = "生成中…";
  $("btn-gen-cancel")?.classList.remove("hidden");
  foundationProg = startApiProgress("gen-progress", { etaSec: ETA_BASELINE_SEC.foundation });
  foundationProg.detail({
    msg: "准备开始生成：将依次完成故事框架、卷纲、角色卡等设定",
    percent: 1,
    remaining: "故事框架与世界观、分卷卷纲、角色卡、创作规则、伏笔清单、文风指南",
    etaSec: ETA_BASELINE_SEC.foundation,
    resetStep: true,
  });
  S.foundationGenAc = streamPost("/api/foundation", {
    kind: S.kind, title, genre: $("f-genre").value,
    targetChapters: +$("f-target").value, chapterWordCount: +$("f-words").value,
    settings: $("f-settings").value,
  }, {
    // 由下方 onStage 驱动细粒度进度，避免被「API调用中」覆盖
    progressEl: null,
    onStage: (s) => {
      foundationProg?.detail({
        msg: s.msg,
        percent: s.percent,
        remaining: s.remaining,
        etaSec: s.etaSec ?? ETA_BASELINE_SEC.foundation,
        resetStep: /正在结合|重新生成|初始化|准备开始/.test(String(s.msg || "")),
      });
    },
    onEvent: (ev, d) => {
      if (ev === "done") {
        S.foundationGenAc = null;
        resetGenFoundationUI();
        foundationProg?.stop("完成 · 设定已反显，请确认");
        S.bookId = d.bookId; S.foundation = d.foundation;
        closeModal("m-settings");
        renderFoundation();
        openModal("m-foundation");
        loadBooks();
      } else if (ev === "abort") {
        S.foundationGenAc = null;
        resetGenFoundationUI();
        foundationProg?.stop("已取消生成（请求已中断）");
      } else if (ev === "error") {
        S.foundationGenAc = null;
        resetGenFoundationUI();
        foundationProg?.stop("");
        showError2("gen-progress", d);
        $("btn-gen").textContent = `重新${label}`;
      }
    },
  });
}
function showError2(elId, d) {
  const { text, code } = formatErrorDisplay(d);
  const el = $(elId);
  if (el) {
    el.classList.remove("hidden");
    el.innerHTML = `<span style="color:#c0392b">${esc(text)}</span>${errorLookupLink(code)}`;
  }
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

// 右侧常驻参考：Tab 切换（结构 / 角色 / 规则 / 面板）
// opts.chapterN：正文页时传入，结构 Tab 展示本章章纲；否则展示全书卷纲/世界观
function renderCards(opts = {}) {
  const chapterN = opts.chapterN != null
    ? opts.chapterN
    : (!$("view-chapter")?.classList.contains("hidden") && S.chapter ? S.chapter : null);
  const f = S.foundation;
  if (!f) {
    if (chapterN != null) {
      $("cards").innerHTML = `
        <div class="ctx-pane active" data-pane="struct">${chapterStructHtml(chapterN)}</div>
        <div class="ctx-pane" data-pane="roles"><p class="ctx-empty">暂无角色卡（设定未加载）</p></div>
        <div class="ctx-pane" data-pane="rules"><p class="ctx-empty">暂无规则（设定未加载）</p></div>`;
      switchCtxTab(ctxTab === "panel" ? "struct" : ctxTab);
    }
    return;
  }
  const roles = (f.roles || []).map((r, i) =>
    `<details data-role="${i}"><summary>${esc(r.name)}<span class="rtier">${r.tier === "主要角色" ? "主" : "次"}</span><span class="card-edit" onclick="event.stopPropagation();editRole(${i})">编辑</span></summary><div class="mdbox">${mdToHtml(r.content)}</div></details>`).join("");
  const rolesHtml = roles || `<p class="ctx-empty">初始化时未生成角色卡；<a href="javascript:refreshCards()">点此刷新</a>。</p>`;
  const vols = splitVolumes(f.volume_map);
  const volHtml = vols.length
    ? vols.map((v, i) => `<details ${i === 0 ? "open" : ""}><summary>${esc(v.title)}</summary><div class="mdbox">${mdToHtml(v.body)}</div></details>`).join("")
    : `<div class="mdbox">${f.volume_map ? mdToHtml(f.volume_map) : "（空）"}</div>`;
  const editable = (sec, title, content) =>
    `<div class="ref-block" data-sec="${sec}">
      <div class="ref-block-head"><h4>${title}</h4><button type="button" class="card-edit" onclick="editSection('${sec}')">编辑</button></div>
      <div class="ref-body"><div class="mdbox sec-view">${content ? mdToHtml(content) : "（空）"}</div></div>
    </div>`;
  const inChapter = chapterN != null;
  const panel = panelCardHtml(inChapter);
  const panelTab = $("ctx-tab-panel");
  if (panelTab) panelTab.classList.toggle("hidden", !panel);
  const bookStructPane = `
    <div class="ref-block" data-sec="volume_map">
      <div class="ref-block-head"><h4>卷纲 / 各卷大纲（${vols.length || "—"} 卷）</h4><button type="button" class="card-edit" onclick="editSection('volume_map')">编辑</button></div>
      <div class="ref-body sec-view">${volHtml}</div>
    </div>
    ${editable("story_frame", "世界观 / 故事框架", f.story_frame)}`;
  const structPane = inChapter
    ? `${chapterStructHtml(chapterN)}
       <details class="vol-drawer"><summary>展开全书卷纲与世界观</summary>${bookStructPane}</details>`
    : bookStructPane;
  const rulesPane = `
    ${editable("pending_hooks", "伏笔", f.pending_hooks)}
    ${editable("book_rules", "设定规则", f.book_rules)}
    ${editable("style_guide", "文风", f.style_guide)}`;
  const active = ctxTab;
  const panelVisible = !!panel;
  const effectiveTab = active === "panel" && !panelVisible ? "struct" : active;
  $("cards").innerHTML = `
    <div class="ctx-pane ${effectiveTab === "struct" ? "active" : ""}" data-pane="struct">${structPane}</div>
    <div class="ctx-pane ${effectiveTab === "roles" ? "active" : ""}" data-pane="roles"><div class="ref-body">${rolesHtml}</div></div>
    <div class="ctx-pane ${effectiveTab === "rules" ? "active" : ""}" data-pane="rules">${rulesPane}</div>
    ${panel ? `<div class="ctx-pane ${effectiveTab === "panel" ? "active" : ""}" data-pane="panel">${panel}</div>` : ""}`;
  switchCtxTab(effectiveTab);
}
// 编辑某个设定分节
function editSection(sec) {
  const f = S.foundation || {};
  const cur = f[sec] || "";
  const box = document.querySelector(`#cards .ref-block[data-sec="${sec}"]`) || document.querySelector("#cards .ref-block");
  if (!box) return;
  const view = box.querySelector(".sec-view") || box.querySelector(".ref-body");
  if (!view) return;
  const holder = document.createElement("div");
  holder.className = "card-edit-wrap";
  holder.innerHTML = `<textarea>${esc(cur)}</textarea><div class="toolbar"><button class="primary" onclick="saveSection('${sec}', this)">保存</button><button onclick="renderCards()">取消</button></div>`;
  view.replaceWith(holder);
}
async function saveSection(sec, btn) {
  const content = btn.closest(".card-edit-wrap").querySelector("textarea").value;
  try {
    await fetch("/api/foundation/save-section", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, section: sec, content }) });
    S.foundation[sec] = content;
    btn.textContent = "已保存";
    btn.disabled = true;
    flashProgress("stage", "设定分区已保存");
    setTimeout(() => renderCards(), 700);
  } catch (e) {
    flashProgress("stage", "保存失败：" + toUserError(e), { ok: false, ms: 4000 });
    alert("保存失败：" + toUserError(e));
  }
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
  try {
    await fetch("/api/role/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, tier: r.tier, name: r.name, content }) });
    r.content = content;
    btn.textContent = "已保存";
    btn.disabled = true;
    flashProgress("stage", "角色卡已保存");
    setTimeout(() => renderCards(), 700);
  } catch (e) {
    flashProgress("stage", "保存失败：" + toUserError(e), { ok: false, ms: 4000 });
    alert("保存失败：" + toUserError(e));
  }
}
async function refreshCards() {
  if (!S.bookId) return;
  try {
    const d = await apiFetch(`/api/foundation?bookId=${encodeURIComponent(S.bookId)}`);
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
    const d = await apiFetch(`/api/panel?bookId=${encodeURIComponent(S.bookId)}`);
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
  const manualBtn = inChapter ? `<button style="width:100%;margin-top:8px;font-size:12px" onclick="manualUpdatePanel()">依据本章正文手动更新人物面板</button>` : "";
  return `<div class="cardbox panel-card">
    <h4>人物面板<span class="card-edit" onclick="editPanel()">编辑</span></h4>
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
  box.innerHTML = `<h4>编辑人物面板</h4><textarea id="panel-edit" style="width:100%;min-height:220px;font-family:ui-monospace,monospace;font-size:12px">${esc(JSON.stringify(S.panel, null, 2))}</textarea><div class="toolbar"><button class="primary" onclick="savePanel()">保存</button><button onclick="refreshSidebar()">取消</button></div>`;
}
async function savePanel() {
  try {
    const panel = JSON.parse($("panel-edit").value);
    await fetch("/api/panel/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, panel }) });
    S.panel = panel; refreshSidebar();
    flashProgress("stage", "人物面板已保存");
  } catch (e) {
    flashProgress("stage", "保存失败：" + toUserError(e), { ok: false, ms: 4000 });
    alert("JSON 格式有误：" + toUserError(e));
  }
}
// 本章通过后提交面板更新（第5章起；由 LLM 依据正文更新）
async function commitPanel(n) {
  if (!S.panelEnabled || !n) return;
  const prog = startApiProgress("stage", { etaSec: ETA_BASELINE_SEC.panel });
  try {
    prog.detail({ msg: "正在依据本章正文更新人物面板", percent: 20, remaining: "模型返回、反显", etaSec: ETA_BASELINE_SEC.panel, resetStep: true });
    const d = await apiFetch("/api/panel/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: S.bookId, n }) });
    prog.detail({ msg: "正在反显人物面板", percent: 90, remaining: "无" });
    if (d.panel) { S.panel = d.panel; refreshSidebar(); }
    prog.stop("人物面板已更新");
  } catch {
    prog.hide();
  }
}
// 根据当前视图刷新右侧
function refreshSidebar() {
  if (!$("view-chapter").classList.contains("hidden")) renderChapterSidebar(S.chapter);
  else renderCards();
}

// 输入记录（信息留存）
async function openLogs() {
  if (!S.bookId) { alert("尚未建书"); return; }
  const d = await apiFetch(`/api/logs?bookId=${encodeURIComponent(S.bookId)}`);
  const rows = (d.inputs || []).map((x) => {
    const meta = `<div class="logmeta">${x.at.slice(0, 19).replace("T", " ")} · <b>${esc(x.type)}</b></div>`;
    const isPrompt = /^建书Prompt/.test(x.type || "");
    if (isPrompt) return `<div class="logrow">${meta}<details><summary style="cursor:pointer;color:var(--accent);font-size:13px">展开完整 prompt（${x.text.length} 字）</summary><pre>${esc(x.text)}</pre></details></div>`;
    return `<div class="logrow">${meta}<pre>${esc(x.text)}</pre></div>`;
  }).join("") || "<p style='color:var(--muted)'>暂无记录</p>";
  $("logs-body").innerHTML = rows;
  openModal("m-logs");
}

async function reviseFoundation() {
  const fb = $("f-revise").value.trim();
  if (!fb) { alert("请输入修订意见"); return; }
  const btn = event.target; btn.disabled = true; btn.textContent = "重生成中…";
  const prog = startApiProgress("gen-progress", { etaSec: ETA_BASELINE_SEC.reviseFoundation });
  try {
    prog.detail({ msg: "正在结合 skill「设定修订」组装 Prompt", percent: 10, remaining: "模型返回、分区解析、反显", etaSec: ETA_BASELINE_SEC.reviseFoundation, resetStep: true });
    prog.detail({ msg: "正在发送修订意见给大模型", percent: 25, remaining: "模型返回、分区解析、反显" });
    const d = await apiFetch("/api/foundation/revise", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: S.bookId, feedback: fb }),
    });
    prog.detail({ msg: "大模型已返回，正在解析各设定分区", percent: 75, remaining: "反显" });
    S.foundation = d.foundation;
    prog.detail({ msg: "正在反显修订后的设定", percent: 95, remaining: "无" });
    renderFoundation();
    $("f-revise").value = "";
    prog.stop("设定已反显");
  } catch (e) {
    prog.stop("");
    alert("重生成失败：" + toUserError(e));
  }
  finally { btn.disabled = false; btn.textContent = "按意见重生成设定"; }
}

// ---------- 确认设定 → 生成近5章章纲 → 确认 → 开始写作 ----------
async function startWriting() {
  closeModal("m-foundation");
  $("home").classList.add("hidden");
  $("workspace").classList.remove("hidden");
  S.book = S.book || { title: $("f-title").value.trim(), targetChapters: +$("f-target").value };
  S.total = 0; S.chaptersData = [];
  renderCards();
  await ensureLoopConfig();
  const manual = S.loopConfig?.manual || LOOP_FALLBACK_DEFAULTS.manual;
  if (!manual.includes("outline_generate")) {
    writeChapter(1);
    return;
  }
  S.outlineMode = "initial";
  $("btn-outline-confirm").textContent = "确认章纲，逐章写作";
  $("btn-outline-auto").style.display = "";
  const hint0 = document.querySelector("#m-outline .hint"); if (hint0) hint0.style.display = "";
  S.outlineStart = 1;
  if (manual.includes("outline_manual")) {
    openModal("m-outline");
    $("outline-list").innerHTML = ""; $("outline-audit-log").innerHTML = "";
    genOutlines(1, 5, "");
    return;
  }
  showChapterView();
  $("stage").textContent = "正在生成章纲（已跳过人工确认）…";
  try {
    await genOutlinesPromise(1, 5, "");
    await saveOutlinesAndMaybeAudit(1, false);
    writeChapter(1);
  } catch (e) {
    $("stage").textContent = toUserError(e);
  }
}

// 生成近 N 章章纲（流式）
let outlineProg = null;
function genOutlinesPromise(startN, count, feedback) {
  return new Promise((resolve, reject) => {
    $("outline-range").textContent = `第 ${startN}-${startN + count - 1} 章`;
    $("btn-outline-regen").disabled = true; $("btn-outline-confirm").disabled = true;
    outlineProg = startApiProgress("outline-progress", { etaSec: ETA_BASELINE_SEC.outline });
    outlineProg.detail({
      msg: `正在生成第 ${startN}-${startN + count - 1} 章章纲`,
      percent: 5,
      remaining: "流式返回、解析反显",
      etaSec: ETA_BASELINE_SEC.outline,
      resetStep: true,
    });
    let buf = "";
    S.ac = streamPost("/api/chapter-outline", { bookId: S.bookId, startN, count, feedback }, {
      progressEl: null,
      onStage: (s) => {
        outlineProg?.detail({
          msg: s.msg || s.msg,
          percent: s.percent ?? 20,
          remaining: s.remaining || "解析反显",
          etaSec: s.etaSec ?? ETA_BASELINE_SEC.outline,
        });
      },
      onDelta: (t) => {
        buf += t;
        const pct = Math.min(85, 25 + Math.round(buf.length / 80));
        outlineProg?.detail({
          msg: `大模型正在返回章纲（已接收 ${buf.length} 字）`,
          percent: pct,
          remaining: "解析反显",
          etaSec: ETA_BASELINE_SEC.outline,
        });
      },
      onEvent: (ev, d) => {
        if (ev === "done") {
          outlineProg?.detail({ msg: "正在解析并反显章纲", percent: 95, remaining: "无" });
          S.outlineEdit = d.outlines || [];
          mergeOutlineEdit();
          outlineProg?.stop("章纲已反显");
          $("btn-outline-regen").disabled = false; $("btn-outline-confirm").disabled = false;
          $("outline-feedback").value = "";
          resolve(d);
        } else if (ev === "error") {
          outlineProg?.stop("");
          $("btn-outline-regen").disabled = false; $("btn-outline-confirm").disabled = false;
          reject(d);
        }
      },
    });
  });
}
function genOutlines(startN, count, feedback) {
  $("outline-range").textContent = `第 ${startN}-${startN + count - 1} 章`;
  $("btn-outline-regen").disabled = true; $("btn-outline-confirm").disabled = true;
  outlineProg = startApiProgress("outline-progress", { etaSec: ETA_BASELINE_SEC.outline });
  outlineProg.detail({
    msg: `正在生成第 ${startN}-${startN + count - 1} 章章纲`,
    percent: 5,
    remaining: "流式返回、解析反显",
    etaSec: ETA_BASELINE_SEC.outline,
    resetStep: true,
  });
  let buf = "";
  S.ac = streamPost("/api/chapter-outline", { bookId: S.bookId, startN, count, feedback }, {
    progressEl: null,
    onStage: (s) => {
      outlineProg?.detail({
        msg: s.msg,
        percent: s.percent ?? 20,
        remaining: s.remaining || "解析反显",
        etaSec: s.etaSec ?? ETA_BASELINE_SEC.outline,
      });
    },
    onDelta: (t) => {
      buf += t;
      const pct = Math.min(85, 25 + Math.round(buf.length / 80));
      outlineProg?.detail({
        msg: `大模型正在返回章纲（已接收 ${buf.length} 字）`,
        percent: pct,
        remaining: "解析反显",
        etaSec: ETA_BASELINE_SEC.outline,
      });
    },
    onEvent: (ev, d) => {
      if (ev === "done") {
        outlineProg?.detail({ msg: "正在解析并反显章纲", percent: 95, remaining: "无" });
        S.outlineEdit = d.outlines || [];
        mergeOutlineEdit();
        outlineProg?.stop("章纲已反显");
        renderOutlines();
        $("btn-outline-regen").disabled = false; $("btn-outline-confirm").disabled = false;
        $("outline-feedback").value = "";
      } else if (ev === "error") {
        outlineProg?.stop("");
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
        <span class="ol-edit" onclick="editOutline(${i})">编辑本章</span>
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
async function saveOutlinesAndMaybeAudit(startN, markDone) {
  mergeOutlineEdit();
  try {
    await fetch("/api/chapter-outline/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: S.bookId, outlines: S.outlines || [] }),
    });
  } catch { /* 存失败也继续 */ }
  if (hasLoop("manual", "outline_audit")) {
    await runOutlineAudit(startN, undefined, markDone);
  } else if (markDone) {
    (S.outlines || []).forEach((o) => {
      if (o.n >= startN && o.n < startN + 5) { o.audited = true; o.confirmed = true; }
    });
    await fetch("/api/chapter-outline/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: S.bookId, outlines: S.outlines || [] }),
    }).catch(() => {});
  }
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
  await ensureLoopConfig();
  // 组末章纲（人工审阅后）：按 loop 提交审计 → 完成 → 回项目总览
  if (S.outlineMode === "midbook") {
    S.outlineMode = null;
    showChapterView();
    $("cd-title").textContent = `第 ${S.outlineStart}-${S.outlineStart + 4} 章章纲 · 处理中`;
    $("cd-actions").innerHTML = ""; $("ch-body").textContent = "";
    if (hasLoop("manual", "outline_audit")) {
      await runOutlineAudit(S.outlineStart, undefined, true);
    } else {
      (S.outlines || []).forEach((o) => {
        if (o.n >= S.outlineStart && o.n < S.outlineStart + 5) { o.audited = true; o.confirmed = true; }
      });
      await fetch("/api/chapter-outline/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId: S.bookId, outlines: S.outlines || [] }),
      }).catch(() => {});
    }
    showProject();
    return;
  }
  // 初始章纲：确认后开始写作 / 自动到完本
  if (auto) {
    if (!confirm("将从第 1 章开始自动写到完本，中途不再逐章确认。已确认的章纲仍会被遵循。确定？")) return;
    showChapterView();
    $("stage").textContent = "AUTO RUN · 自动连写已启动…";
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
  } catch (e) { $("stage").textContent = toUserError(e); return; }
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
    try { d = await apiFetch(`/api/auto/status?bookId=${encodeURIComponent(S.bookId)}`); }
    catch { S._autoPoll = setTimeout(tick, 6000); return; }
    S.autoMsg = (d.error ? d.error + " · " : "") + (d.msg || (d.running ? "运行中…" : "已结束"));
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
    const d = await apiFetch(`/api/resume?bookId=${encodeURIComponent(S.bookId)}`);
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
    let head = `第 ${startN}-${endN} 章章纲：自动审计中…`;
    const render = () => {
      box.innerHTML = `<h4>${esc(head)}</h4>` + rounds.map((a) => {
        if (a.error) return `<div class="iss" style="color:#c0392b">第${a.round}轮 ${esc(formatErrorDisplay(a).text)}</div>`;
        return `<div class="iss"><b>第${a.round}轮：${a.passed ? "合格" : "需修订"}</b> ${esc(a.verdict || "")}` +
          (a.raw ? `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:12px;color:var(--accent)">展开完整审计意见</summary><pre style="white-space:pre-wrap;font-size:12px;line-height:1.6;margin:4px 0">${esc(a.raw)}</pre></details>` : "") + `</div>`;
      }).join("");
    };
    render();
    const auditProgEl = logElId === "outline-audit-log" ? "outline-progress" : null;
    const auditProg = auditProgEl
      ? startApiProgress(auditProgEl, { etaSec: ETA_BASELINE_SEC.outlineAudit })
      : null;
    auditProg?.detail({
      msg: head,
      percent: 10,
      remaining: "审计轮次、可能修订",
      etaSec: ETA_BASELINE_SEC.outlineAudit,
      resetStep: true,
    });
    streamPost("/api/outline-audit", { bookId: S.bookId, startN, count: 5, markDone: !!markDone }, {
      progressEl: null,
      onStage: (s) => {
        head = s.msg;
        auditProg?.detail({
          msg: s.msg,
          percent: s.percent ?? 30,
          remaining: s.remaining || "审计/修订",
          etaSec: s.etaSec ?? ETA_BASELINE_SEC.outlineAudit,
        });
        render();
      },
      onEvent: (ev, d) => {
        if (ev === "audit") {
          rounds.push(d);
          auditProg?.detail({
            msg: `第 ${d.round} 轮审计结果：${d.passed ? "合格" : "需修订"}`,
            percent: Math.min(90, 20 + d.round * 25),
            remaining: d.passed ? "收尾" : "修订后再审",
            etaSec: ETA_BASELINE_SEC.outlineAudit,
          });
          render();
        }
        else if (ev === "done") {
          const before = JSON.stringify((S.outlines || []).filter((o) => o.n >= startN && o.n <= endN).map((o) => [o.title, o.summary]));
          const map = new Map((S.outlines || []).map((o) => [o.n, o]));
          (d.outlines || []).forEach((o) => map.set(o.n, o));
          S.outlines = [...map.values()].sort((a, b) => a.n - b.n);
          const after = JSON.stringify((S.outlines || []).filter((o) => o.n >= startN && o.n <= endN).map((o) => [o.title, o.summary]));
          const changed = before !== after;
          head = `第 ${startN}-${endN} 章章纲已就绪（${d.passed ? "审计合格" : "已尽力修订"}，共 ${d.rounds} 轮，${changed ? "章纲已按审计修改" : "无需修改"}）`;
          auditProg?.stop("章纲审计完成");
          render();
          resolve();
        } else if (ev === "error") {
          rounds.push({ round: (rounds.length + 1), ...formatErrorDisplay(d), error: formatErrorDisplay(d).text });
          auditProg?.stop(""); render(); resolve();
        }
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
// 人工模式：组末生成下一组章纲 → 按 loop 决定是否人工审阅
async function startMidbookOutline(startN) {
  await ensureLoopConfig();
  const manual = S.loopConfig?.manual || LOOP_FALLBACK_DEFAULTS.manual;
  if (!manual.includes("outline_generate")) {
    showProject();
    return;
  }
  S.outlineMode = "midbook"; S.outlineStart = startN;
  if (!manual.includes("outline_manual")) {
    showChapterView();
    $("stage").textContent = `正在生成第 ${startN}-${startN + 4} 章章纲…`;
    try {
      await genOutlinesPromise(startN, 5, "");
      await saveOutlinesAndMaybeAudit(startN, true);
      showProject();
    } catch (e) {
      $("stage").textContent = toUserError(e);
    }
    return;
  }
  $("btn-outline-confirm").textContent = hasLoop("manual", "outline_audit")
    ? "确认章纲，提交自动审计"
    : "确认章纲";
  $("btn-outline-auto").style.display = "none";
  const hint = document.querySelector("#m-outline .hint"); if (hint) hint.style.display = "none";
  openModal("m-outline");
  $("outline-list").innerHTML = ""; $("outline-audit-log").innerHTML = "";
  $("outline-range").textContent = `第 ${startN}-${startN + 4} 章`;
  const existing = (S.outlines || []).filter((o) => o.n >= startN && o.n < startN + 5);
  if (existing.length) {
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
function streamPost(url, payload, { onStage, onDelta, onEvent, progressEl }) {
  const ac = new AbortController();
  const prog = progressEl ? startApiProgress(progressEl) : null;
  let gotStream = false;
  (async () => {
    let resp;
    try {
      if (prog) prog.set(API_PHASE.CALL);
      resp = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) { onEvent?.("abort", {}); return; }
      prog?.stop("");
      onEvent("error", clientErr("E001")); return;
    }
    if (!resp.ok) {
      const errData = await readJsonResponse(resp);
      prog?.stop("");
      onEvent("error", errData.error ? errData : clientErr(resp.status === 404 ? "E109" : "E500"));
      return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!gotStream) { gotStream = true; prog?.set(API_PHASE.RECEIVE); }
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
          let obj;
          try { obj = JSON.parse(data); } catch { onEvent?.("error", clientErr("JSON")); continue; }
          if (ev === "stage") {
            if (obj.rich || obj.percent != null) {
              prog?.detail?.(obj);
            } else {
              const phase = mapStageToPhase(obj.msg);
              prog?.set(phase);
            }
            onStage?.(obj);
          } else if (ev === "delta") {
            prog?.set(API_PHASE.RECEIVE);
            onDelta?.(obj.t);
          } else onEvent?.(ev, obj);
        }
      }
    } catch (e) {
      if (ac.signal.aborted) onEvent?.("abort", {});
      else { prog?.stop(""); onEvent?.("error", clientErr("E002")); }
    }
  })();
  return ac;
}

// 流式写一章草稿。opts: {context, rewrite, note}
let writeProg = null;
function streamWrite({ context, rewrite, note }) {
  showChapterView();
  $("cd-title").textContent = `第 ${S.chapter} 章 · 生成中`;
  $("cd-actions").innerHTML = "";
  $("ch-body").textContent = "";
  $("audit-box")?.remove();
  $("btn-pause").classList.remove("hidden");
  writeProg = startApiProgress("stage", { etaSec: ETA_BASELINE_SEC.write });
  writeProg.detail({
    msg: "正在组装本章上下文并准备写作",
    percent: 5,
    remaining: "流式返回正文、反显",
    etaSec: ETA_BASELINE_SEC.write,
    resetStep: true,
  });
  const sf = makeStreamFilter();
  let recvChars = 0;
  S.ac = streamPost("/api/write", { bookId: S.bookId, context, rewrite: !!rewrite, note }, {
    progressEl: null,
    onStage: (s) => {
      writeProg?.detail({
        msg: s.msg,
        percent: s.percent ?? 15,
        remaining: s.remaining || "流式返回正文",
        etaSec: s.etaSec ?? ETA_BASELINE_SEC.write,
      });
    },
    onDelta: (t) => {
      recvChars += t.length;
      const r = sf(t);
      if (r.phase === "check") {
        writeProg?.detail({
          msg: "大模型正在构思本章结构…",
          percent: 18,
          remaining: "返回正文",
          etaSec: ETA_BASELINE_SEC.write,
        });
        $("ch-body").innerHTML = `<div style="color:#b0b8b4;font-size:13px;line-height:1.7;white-space:pre-wrap">${esc(r.raw.slice(-500))}</div>`;
      } else if (r.prose != null) {
        writeProg?.detail({
          msg: `大模型正在返回正文（已接收 ${recvChars} 字）`,
          percent: Math.min(88, 20 + Math.round(recvChars / 120)),
          remaining: "结构清洗、反显",
          etaSec: ETA_BASELINE_SEC.write,
        });
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
        writeProg?.stop("草稿完成 · 反显中");
        onChapterDraftDone(d);
      } else if (ev === "error") {
        S.ac = null; $("btn-pause").classList.add("hidden");
        writeProg?.stop("");
        showError(d);
      }
    },
  });
}

function pauseWrite() {
  if (S.ac) { S.ac.abort(); S.ac = null; }
  $("btn-pause").classList.add("hidden");
  writeProg?.stop("已暂停：已中断本次接口调用");
  $("cd-title").textContent = `第 ${S.chapter} 章 · 已暂停`;
}

function showError(d) {
  const { text, code } = formatErrorDisplay(d);
  $("stage").innerHTML = `<span style="color:#c0392b">${esc(text)}</span>${errorLookupLink(code)}`;
}

// ---------- 报错自查 ----------
function openErrorLookup(prefill) {
  $("err-lookup-input").value = prefill || "";
  $("err-lookup-result").innerHTML = "";
  $("err-lookup-progress").classList.add("hidden");
  $("err-lookup-catalog").innerHTML = "加载中…";
  openModal("m-error-lookup");
  loadErrorCatalog();
  if (prefill) queryErrorLookup();
}

function loadErrorCatalog() {
  const list = errorCatalogList();
  $("err-lookup-catalog").innerHTML = list.length
    ? list.map((e) =>
      `<span style="cursor:pointer;color:var(--accent)" onclick="lookupErrorCode('${String(e.code).replace(/'/g, "")}')">${esc(e.code)}</span> · ${esc(e.title)}`
    ).join("<br>")
    : `<span style="color:var(--warn)">报错列表为空，请运行 npm start 同步 data/error-catalog.json</span>`;
}

function lookupErrorCode(code) {
  $("err-lookup-input").value = code;
  queryErrorLookup();
}

function queryErrorLookup() {
  const q = $("err-lookup-input").value.trim();
  const box = $("err-lookup-result");
  if (!q) {
    box.innerHTML = `<p style="color:var(--warn);font-size:13px">${esc(clientErr("E100").error)}</p>`;
    return;
  }
  const hits = lookupErrorsLocal(q);
  if (!hits.length) {
    box.innerHTML = `<p style="color:var(--muted);font-size:13px">未找到「${esc(q)}」相关条目。请直接粘贴页面完整报错（含 [报错码]），或只输入码如 E109、1001。</p>`;
  } else {
    box.innerHTML = hits.map((e) => `
      <div class="err-hit">
        <div class="err-code">${esc(e.code)}</div>
        <div class="err-title">${esc(e.title)} [${esc(e.code)}]</div>
        ${e.scene ? `<div class="err-scene"><b>常见环节：</b>${esc(e.scene)}</div>` : ""}
        <p><b>可能原因：</b>${esc(e.cause)}</p>
        <p class="err-fix"><b>处理建议：</b>${esc(e.fix)}</p>
      </div>`).join("");
  }
  const prog = $("err-lookup-progress");
  if (prog) {
    prog.classList.remove("hidden");
    prog.innerHTML = `<span class="cur api-phase">已返回 ${hits.length} 条结果 · 离线查询</span>`;
  }
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

async function onChapterDraftDone(d) {
  await ensureLoopConfig();
  const content = d.content;
  if (hasLoop("manual", "chapter_manual")) {
    openChapterConfirm("draft", content, `第 ${d.chapterNumber} 章草稿完成`);
    return;
  }
  if (hasLoop("manual", "chapter_auto_review")) {
    await runAudit("audited");
    return;
  }
  acceptChapter(content);
}

// ---------- 章节确认弹框 ----------
// stage: "draft"(修订/重写/继续) | "audited"(5选项)
function openChapterConfirm(stage, content, title) {
  S.confirmStage = stage; S.selectedTab = null;
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = content;
  let tabs = stage === "draft"
    ? [["自动纠正（AI先自查自改）", "autocorrect", false], ["修订", "revise", true], ["重写", "rewrite", true], ["继续（进入自动审计）", "continue", false]]
    : [["使用审计前版本", "use-pre", false], ["对审计前版本修改", "edit-pre", true],
       ["对审计版本修订", "revise-post", true], ["重写审计版本", "rewrite-post", true],
       ["使用审计后版本", "use-post", false]];
  if (!hasLoop("manual", "chapter_auto_review")) {
    tabs = tabs.filter(([, val]) => !["autocorrect", "continue"].includes(val));
  }
  if (!tabs.length) {
    acceptChapter(content);
    return;
  }
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
    return `<h4>第 ${a.round} 轮审计：${a.passed ? "通过" : "未通过"}${a.score != null ? ` · 评分 ${a.score}` : ""} · ${a.issues.length} 条</h4>${list}`;
  }).join("<hr style='border:none;border-top:1px dashed var(--line);margin:8px 0'>");
}
// 由"继续/重新审计"(afterStage=audited) 或"自动纠正"(afterStage=draft) 触发：自动审改闭环
// afterStage="audited" → 跑完进入版本选择/定稿；"draft" → 跑完回到人工审阅（可再提意见）
function runAudit(afterStage = "audited") {
  S.reviewRounds = [];
  showChapterView();
  $("cd-actions").innerHTML = "";
  $("cd-title").textContent = `第 ${S.chapter} 章 · 自动审改中`;
  $("ch-body").textContent = "";
  $("audit-box")?.remove();
  const auditProg = startApiProgress("stage", { etaSec: ETA_BASELINE_SEC.audit });
  auditProg.detail({
    msg: "正在启动本章自动审改闭环",
    percent: 5,
    remaining: "审计轮次、可能修订",
    etaSec: ETA_BASELINE_SEC.audit,
    resetStep: true,
  });
  const sf0 = { fn: makeStreamFilter() };
  S.ac = streamPost("/api/auto-review", { bookId: S.bookId, chapter: S.chapter }, {
    progressEl: null,
    onStage: (s) => {
      auditProg.detail({
        msg: s.msg,
        percent: s.percent ?? 20,
        remaining: s.remaining || "审改中",
        etaSec: s.etaSec ?? ETA_BASELINE_SEC.audit,
      });
    },
    onDelta: (t) => { const r = sf0.fn(t); $("ch-body").textContent = r.prose != null ? r.prose : (r.raw || ""); },
    onEvent: (ev, d) => {
      if (ev === "audit") {
        S.reviewRounds.push(d);
        renderReviewLog();
        sf0.fn = makeStreamFilter();
        auditProg.detail({
          msg: `第 ${d.round} 轮审计：${d.passed ? "通过" : "未通过"}`,
          percent: Math.min(90, 15 + d.round * 20),
          remaining: d.passed ? "收尾定稿" : "修订后再审",
          etaSec: ETA_BASELINE_SEC.audit,
        });
      } else if (ev === "done") {
        S.ac = null;
        S.postAudit = d.content || S.preAudit;
        if (d.title) S.chapterTitle = cleanTitle(d.title);
        $("ch-body").innerHTML = renderBody(S.postAudit);
        $("cd-title").textContent = `第 ${S.chapter} 章 ${S.chapterTitle || ""} · ${d.passed ? "审计已通过" : "已达最多修订轮次"}`;
        auditProg.stop(d.passed ? `审计通过 · ${d.rounds} 轮` : `已给出最佳版本 · ${d.rounds} 轮`);
        renderReviewLog();
        const hist = (S.reviewRounds || []).map((a) => `第${a.round}轮：${a.passed ? "通过" : a.issues.length + "条问题"}`).join("；");
        if (afterStage === "draft") {
          S.preAudit = S.postAudit;
          $("cd-title").textContent = `第 ${S.chapter} 章 ${S.chapterTitle || ""} · 已自动纠正`;
          openChapterConfirm("draft", S.postAudit, `第 ${S.chapter} 章 · 已自动纠正（${d.passed ? "已通过" : d.rounds + "轮"}），请审阅`);
          $("confirm-body").textContent = S.postAudit + "\n\n——— 自动纠正过程 ———\n" + hist;
        } else {
          openChapterConfirm("audited", S.postAudit, `第 ${S.chapter} 章 · ${d.passed ? "审计通过版本" : "最佳版本"}`);
          $("confirm-body").textContent = S.postAudit + "\n\n——— 审计过程 ———\n" + hist;
        }
      } else if (ev === "error") { S.ac = null; auditProg.stop(""); showError(d); }
    },
  });
}

async function setChapter(n, content) {
  await fetch("/api/set-chapter", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: S.bookId, n, content }),
  });
}

// 锁入正文：定稿本章。若为组末（4/9/14…）则按 loop 处理下一组章纲
function acceptChapter(content) {
  upsertChapter(S.chapter, S.chapterTitle || "", content, "ready-for-review");
  $("stage").textContent = `第 ${S.chapter} 章已定稿，收入正文。`;
  $("audit-box")?.remove();
  loadBooks();
  const doneN = S.chapter;
  if (hasLoop("manual", "panel_update") && S.panelEnabled) {
    $("stage").textContent = `第 ${doneN} 章已定稿，正在更新人物面板…`;
    commitPanel(doneN);
  }
  const nextStart = Math.floor(doneN / 5) * 5 + 6; // 4→6, 9→11…
  const grp = (S.outlines || []).filter((o) => o.n >= nextStart && o.n < nextStart + 5);
  if (doneN % 5 === 4 && (grp.length === 0 || grp.some((o) => !o.confirmed)) && hasLoop("manual", "outline_generate")) {
    startMidbookOutline(nextStart);
  } else {
    showProject();
  }
}

function autoComplete() {
  if (!confirm("将从下一章开始自动连写到完本，中途不再人工确认。确定？")) return;
  showChapterView();
  $("stage").textContent = "AUTO RUN · 自动连写已启动…";
  startAuto();
}

// ---------- 初始化：加载项目栏 + 就绪检查 ----------
document.addEventListener("click", () => closeBookMenu());
loadBooks();
checkReady();
ensureLoopConfig().catch(() => {});
initContextPanel();
initHudClock();
