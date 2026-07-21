# jace 开源小说生成器

AI 自动写长篇小说的 Web 工作台。给出书名、题材和初始设定，它会依次完成：

**建书 → 生成大纲/世界观/角色 → 章纲规划 + 结构审计 → 逐章写正文 + 连贯性审计 → 自动连写到完本**

并支持游戏/系统流小说的**人物属性面板**、断点续写、以及看门狗自愈式后台连写。

> 本仓库 **自包含**：写作引擎在 `lib/engine.mjs`，全部提示词在 `data/skills/pipeline/`（可在设置中心编辑）。许可 **MIT**。

---

## 特性

- **全流程自动化**：从一句设定到数百章长篇。
- **两级审计**：章纲结构审计 + 正文连贯性审计，不合格自动修订。
- **Skills 全量可改**：世界观、卷纲、角色、正文、审计等提示词全部展示并可编辑，保存立即生效。
- **人物属性面板**：游戏/LitRPG 题材自动维护主角数值。
- **实时进度**：SSE 流式推送阶段与正文 token。
- **任意 OpenAI 兼容接口**：默认 DeepSeek 示例，改 Base URL 即可换服务。

## 密钥与隐私

- API Key 只保存在本机 `data/config.json`（已被 `.gitignore` 忽略）。
- 也可用环境变量：`NOVEL_API_KEY`（或 `OPENAI_API_KEY`）。
- 仓库中没有任何硬编码密钥。

## 快速开始

需要 Node.js ≥ 20。

```bash
git clone <your-repo-url> jace-novel-generator
cd jace-novel-generator
npm install   # 当前无强制第三方写作依赖，可直接 start
npm start
```

打开 http://localhost:4568 ，点 **设置** 填入 API Key 即可开始创作。

```bash
cp .env.example .env   # 填入 NOVEL_API_KEY 等
NOVEL_API_KEY=sk-xxxx npm start
```

## 配置

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `NOVEL_API_KEY` / `OPENAI_API_KEY` | 模型密钥 | 无（必填） |
| `NOVEL_BASE_URL` | OpenAI 兼容接口地址 | `https://api.deepseek.com` |
| `NOVEL_MODEL` | 快模型（正文/审查） | `deepseek-v4-flash` |
| `NOVEL_MODEL_STRONG` | 强模型（大纲/审计/修订） | `deepseek-v4-pro` |
| `NOVEL_PORT` | 服务端口 | `4568` |

## 后台自动连写 / 看门狗

```bash
npm run auto:start
npm run auto:status
npm run auto:watch
npm run auto:stop
```

## 目录

```
server.mjs              HTTP + SSE 编排、章纲/人物面板、设置中心 API
lib/engine.mjs          自研写作引擎（LLM / 状态 / 建书·写稿·审计·修订）
lib/default-skills.mjs  内置技能默认文案
auto-ctl.mjs            后台自动连写控制 + 看门狗
public/                 前端（原生 JS）
data/skills/pipeline/   可编辑技能文件（运行时生效）
```

## 许可

MIT。见 [LICENSE](./LICENSE)。
