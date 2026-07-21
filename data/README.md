# data/ 目录说明

本目录存放**本机运行时数据**，多数文件已列入 `.gitignore`，**请勿提交到 GitHub**。

| 路径 | 是否提交 | 说明 |
|------|----------|------|
| `config.example.json` | ✅ 提交 | 空密钥示例，克隆后复制为 `config.json` |
| `model-config.example.json` | ✅ 提交 | 默认分阶段模型映射示例（无密钥） |
| `error-catalog.json` | ✅ 提交 | 报错自查文案 |
| `config.json` | ❌ 忽略 | **含 API Key**，仅本机 |
| `model-config.json` | ❌ 忽略 | 本机分阶段模型覆盖 |
| `books/` | ❌ 忽略 | 作品正文、设定、prompt 留存 |
| `skills/` | ❌ 忽略 | 运行时技能（可回退到 `lib/default-skills.mjs`） |
| `genres.json` / `writing-config.json` | ❌ 忽略 | 个人题材与自动写作配置 |

## 首次运行

1. 复制示例配置：
   ```bash
   cp data/config.example.json data/config.json
   # 可选
   cp data/model-config.example.json data/model-config.json
   ```
2. 启动 `npm start`，在网页「设置 → 模型服务」填入你自己的 API Key。

切勿把真实 `apiKey`、本机绝对路径、个人 IP、私有 Token 写进会提交的源码 / README / 截图。
