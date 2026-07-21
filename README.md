# 网文小说生成器 · Web Novel Generator

**中文** | [English](./README.en.md)

**作者 / Author：[Jace](https://github.com/JACEZ123)** · 许可 [MIT](./LICENSE)（允许下载与改编，**须署名来源 Jace**）

本地 AI 长篇网文工作台：从一句话设定出发，完成 **建书 → 大纲/世界观/角色 → 章纲 + 结构审计 → 逐章正文 + 连贯性审计 → 自动连写**，并支持游戏/系统流的**人物属性面板**、断点续写与关网页后台连写。


## 为什么做这个项目

当前用大模型直接「一口气写小说」时，常见问题是：

1. **一致性差**：人物性格、实力体系、时间线容易前后打架。  
2. **幻觉大**：凭空发明设定、遗忘已写伏笔。  
3. **长上下文丢失**：小说越写越长，模型记不住前因后果。  
4. **AI 味难消**：套话、空泛描写、节奏飘。

但与此同时，很多人希望用 AI **写网文做副业**——需要的是可落地的流水线，而不是一次对话碰运气。

本项目把写作拆成多阶段流水线，用 **Skills（可编辑提示词）+ Loop 节点 + 章纲/正文双层审计 + 人物面板注入** 做持续校准与内审，让长篇更可控。对想认真用 AI 写连载的人，它有明确实用价值。

> **Token 提示（重要）**  
> 因含大量校准与内审（建书多步、章纲审计、正文审改闭环、面板更新等），**Token 消耗明显高于「单次对话写一章」**。  
> **建议使用 DeepSeek 等便宜且中文文笔较好的 OpenAI 兼容模型**，在设置中填入 API Key 与 Base URL 即可。

---

## 优势一览

| 优势 | 说明 |
|------|------|
| 多阶段校准 | 世界观 → 卷纲 → 角色 → 规则 → 伏笔 → 文风，再写正文 |
| 双层审计 | 章纲结构审计 + 正文连贯性审计，不合格可自动修订 |
| Skills 热更新 | 全部提示词可在设置中查看/编辑，保存即生效 |
| 人机协作 | 确认设定、确认章纲、草稿后可纠正/重写/进入审计 |
| 长篇记忆辅助 | 章纲、摘要、近章摘录、人物面板持续注入上下文 |
| 本机可控 | 数据与密钥仅存本机；关网页也可后台连写 |

---

## 功能与界面

### 1. 首页工作台

新建长篇 / 剧本、管理作品、一键进入设置。未配置密钥时会明确提示。

<p align="center"><img src="docs/screenshots/01-home.png" alt="首页工作台" width="920" /></p>

### 2. Skills 技能（提示词）

长篇与剧本各有一套流程技能（章纲修订、正文写手、审计等），可改可恢复默认。

<p align="center"><img src="docs/screenshots/02-skills.png" alt="Skills 设置" width="920" /></p>

### 3. Loop 流程节点

调整「建书 / 自动连写 / 人工写作」节点顺序，按你的习惯编排流水线。

<p align="center"><img src="docs/screenshots/03-loop.png" alt="Loop 流程" width="920" /></p>

### 4. 热点指导 + AI 一键生成 / 建书进度

可先拉取热点类型指导，再一键填设定；生成大纲与世界观时展示细粒度进度（百分比、本步/合计耗时、预计剩余等）。

<p align="center"><img src="docs/screenshots/04-foundation-progress.png" alt="建书与进度" width="920" /></p>

### 5. 确认设定（大纲 / 世界观 / 伏笔等）

人工审阅后可按意见重生成，或确认后进入写作。

<p align="center"><img src="docs/screenshots/05-confirm-settings.png" alt="确认设定" width="920" /></p>

### 6. 确认近 5 章章纲

组末章纲可编辑、整体意见重生，并可进入结构审计。

<p align="center"><img src="docs/screenshots/06-confirm-outline.png" alt="确认章纲" width="920" /></p>

### 7. 章节草稿完成

支持自动纠正、修订、重写，或继续进入自动审计。

<p align="center"><img src="docs/screenshots/07-draft-done.png" alt="草稿完成" width="920" /></p>

### 8. 正文连贯性审计

按轮次给出评分与问题清单（设定一致性、节奏、AI 套话等），可驱动修订闭环。

<p align="center"><img src="docs/screenshots/08-audit.png" alt="正文审计" width="920" /></p>

### 其他能力

- **人物属性面板**（游戏 / LitRPG 等题材）：等级、属性、装备、技能，写作时注入，章后可更新。  
- **自动连写 + 看门狗**：任务跑在本机服务进程，关网页继续；可下载防休眠 / 启停脚本。  
- **报错自查**：按错误码 / 关键词检索处置建议。  
- **任意 OpenAI 兼容接口**：DeepSeek、其他国内/海外兼容端均可。  
- **输入记录**：本机留存关键设定与发给模型的 Prompt，便于复盘。

---

## 安装与部署

### 环境要求

- **Node.js ≥ 20**
- 本机可访问你的模型 API（需自备 API Key）

### 安装步骤

```bash
git clone https://github.com/JACEZ123/novel-generator.git
cd novel-generator
npm install

# 可选：准备本机配置文件（不含密钥也可稍后在网页填写）
cp data/config.example.json data/config.json
cp data/model-config.example.json data/model-config.json

npm start
```

浏览器打开：**http://localhost:4568**

1. 点右上角 **设置 → 模型服务**  
2. 填写 **API 密钥** 与 **Base URL**（DeepSeek 示例：`https://api.deepseek.com`）  
3. 保存后回到首页，点 **开始创作 / 新建创作**

### 可选环境变量

仅用于覆盖默认端点 / 模型 / 端口；**密钥请勿写进环境变量或仓库**。

| 变量 | 说明 | 默认 |
|------|------|------|
| `NOVEL_BASE_URL` | OpenAI 兼容接口 | `https://api.deepseek.com` |
| `NOVEL_MODEL` | 快模型 | `deepseek-v4-flash` |
| `NOVEL_MODEL_STRONG` | 强模型 | `deepseek-v4-pro` |
| `NOVEL_PORT` | 服务端口 | `4568` |

### 后台自动连写

1. 保持 `npm start` 运行  
2. **设置 → 自动写作**：配置停止条件  
3. 按系统下载并执行开始 / 停止 / 进度 / 防休眠脚本  

详见 [docs/auto-writing.md](./docs/auto-writing.md)。

### 目录结构（简）

```
server.mjs              HTTP + SSE 编排、设置中心 API
lib/engine.mjs          写作引擎（建书 / 写稿 / 审计 / 修订）
lib/default-skills.mjs  内置技能默认文案
auto-ctl.mjs            后台自动连写控制
public/                 前端（原生 HTML/CSS/JS）
data/                   本机配置与作品（多数已 gitignore）
docs/screenshots/       README 界面截图
```

---

## 密钥与隐私（开源必读）

- API Key **只能**在网页「设置 → 模型服务」填写，保存在本机 `data/config.json`（已被忽略）。  
- 仓库 **不包含** 真实密钥、个人作品正文、私有 Token。  
- 上传 / Fork 前请确认 `git status` 中无 `data/config.json`、`data/books/`、`.env`。  
- 若密钥曾泄露，请立即在服务商控制台**轮换**。

详见 [data/README.md](./data/README.md)。

---

## 开源协议与署名

本项目采用 **MIT License**。

- **允许**：自由下载、使用、修改、二次分发、用于个人或商业副业。  
- **要求**：保留版权与许可声明，并**署名来源作者 Jace**（见 [LICENSE](./LICENSE)、[AUTHORS](./AUTHORS)）。  

欢迎 Star、Issue 与 PR。

---

## 作者

**Jace** · 网文小说生成器 / Web Novel Generator  
GitHub：[@JACEZ123](https://github.com/JACEZ123)
