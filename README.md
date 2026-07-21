# jace 开源小说生成器

AI 自动写长篇小说的 Web 工作台。给出书名、题材和初始设定，它会依次完成：

**建书 → 生成大纲/世界观/角色 → 章纲规划 + 结构审计 → 逐章写正文 + 连贯性审计 → 自动连写到完本**

并支持游戏/系统流小说的**人物属性面板**（等级/属性/装备/技能自动养成）、断点续写、以及看门狗自愈式后台连写。

> 本仓库代码采用 **MIT** 许可。写作引擎 `@actalk/inkos-core`（AGPL-3.0）作为运行时依赖，由 `npm install` 拉取，不包含在本仓库内。详见 [LICENSE](./LICENSE)。

---

## ✨ 特性

- **全流程自动化**：从一句设定到数百章长篇，全部由模型驱动。
- **两级审计**：章纲有结构审计（是否服务总纲/分卷/承接/读者心智），正文有连贯性/设定一致性/节奏审计，不合格自动修订。
- **人物属性面板**：游戏/LitRPG 题材自动维护并展示主角数值面板。
- **实时进度反馈**：SSE 流式推送每个阶段与正文 token。
- **后台自动连写**：关闭页面也不中断，随时刷新看最新进度。
- **分阶段模型**：不同阶段（大纲/正文/审计…）可分别指定快/强模型。
- **任意 OpenAI 兼容接口**：默认对接 DeepSeek，改 Base URL 即可换服务。

## 🔑 密钥与隐私

- 你的 API Key **只保存在本机** `data/config.json`（已被 `.gitignore` 忽略），不会上传、不会随仓库提交、不会返回给前端（接口只回掩码）。
- 也可用环境变量注入：`NOVEL_API_KEY`（或 `OPENAI_API_KEY`）。环境变量优先级高于配置文件。
- 仓库中**没有任何硬编码密钥**。

## 🚀 快速开始

需要 Node.js ≥ 20。

```bash
git clone <your-repo-url> jace-novel-generator
cd jace-novel-generator
npm install
npm start
```

打开 http://localhost:4568 ，点右上角 **🔑 设置** 填入你的 API Key（默认 DeepSeek，可改 Base URL 接任意 OpenAI 兼容接口），即可开始创作。

也可以用环境变量代替设置界面：

```bash
cp .env.example .env   # 填入 NOVEL_API_KEY 等
# 或直接：
NOVEL_API_KEY=sk-xxxx npm start
```

## 🛠 配置

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `NOVEL_API_KEY` / `OPENAI_API_KEY` | 模型密钥 | 无（必填） |
| `NOVEL_BASE_URL` | OpenAI 兼容接口地址 | `https://api.deepseek.com` |
| `NOVEL_MODEL` | 快模型（正文/审查） | `deepseek-v4-flash` |
| `NOVEL_MODEL_STRONG` | 强模型（大纲/审计/修订） | `deepseek-v4-pro` |
| `NOVEL_PORT` | 服务端口 | `4568` |

可用模型列表、快/强模型、温度也可在「🔑 设置」界面维护；各写作阶段用哪个模型可在「⚙ 模型配置」里分别指定。参考 `data/config.example.json`。

## 🤖 后台自动连写 / 看门狗

```bash
npm run auto:start    # 后台开始自动写到完本（当前最近修改的书）
npm run auto:status   # 查看进度
npm run auto:watch    # 看门狗：卡住/停止时回滚坏章并自愈重启（可挂到 cron/计划任务）
npm run auto:stop     # 停止
```

## 📂 目录

```
server.mjs        后端：HTTP + SSE 编排、章纲/人物面板逻辑、密钥配置
auto-ctl.mjs      后台自动连写控制 + 看门狗
public/           前端（原生 JS，无构建）
data/             运行时数据（config.json 与 books/ 均被 gitignore）
```

## 📜 许可

- 本仓库代码：**MIT**（见 [LICENSE](./LICENSE)）。
- 运行时依赖 `@actalk/inkos-core`：**AGPL-3.0-only**（独立项目，非本仓库代码）。若对外提供网络服务，请遵守该依赖的开源义务。

## 🙏 致谢

写作/审计/状态引擎由 [inkos](https://github.com/Narcooo/inkos) 提供。
