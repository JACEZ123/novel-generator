# Web Novel Generator · 网文小说生成器

[中文](./README.md) | **English**

**Author: [Jace](https://github.com/JACEZ123)** · License [MIT](./LICENSE) (free to download and adapt; **attribution to Jace is required**)

A local AI workbench for long-form Chinese web novels. From a short premise, it runs **book setup → outline / worldbuilding / characters → chapter outlines + structure audit → chapter prose + continuity audit → auto-serialization**, with optional **character attribute panels** for game/system genres, checkpoint resume, and background writing after you close the browser.

<p align="center">
  <img src="docs/screenshots/01-home.png" alt="Web Novel Generator · Home" width="920" />
</p>

---

## Why this project exists

Asking a model to “just write a novel in one go” usually fails because of:

1. **Weak consistency** — character voice, power systems, and timelines drift.  
2. **Hallucinations** — invented lore, forgotten foreshadowing.  
3. **Lost long context** — as length grows, cause-and-effect collapses.  
4. **Generic “AI flavor”** — clichés, empty description, broken pacing.

Still, many people want to use AI to **write web novels as a side hustle**. They need a production pipeline, not a lucky chat thread.

This project splits writing into a multi-stage pipeline with **editable Skills (prompts)**, **Loop nodes**, **two-layer audits (outline + prose)**, and **panel injection** for ongoing calibration. That makes long serials more controllable—and practically valuable for serious AI-assisted publishing.

> **Token note (important)**  
> Because of heavy calibration and internal review (multi-step foundation, outline audits, prose revise loops, panel updates, etc.), **token usage is much higher than “one prompt → one chapter.”**  
> **Prefer affordable OpenAI-compatible models with strong Chinese prose, such as DeepSeek.** Configure API Key and Base URL in Settings.

---

## Advantages

| Advantage | What it means |
|-----------|----------------|
| Multi-stage calibration | World → volumes → characters → rules → hooks → style, then prose |
| Two-layer audits | Outline structure audit + chapter continuity audit, with auto-revise |
| Hot-editable Skills | All prompts are visible/editable in Settings; save to apply |
| Human-in-the-loop | Confirm settings & outlines; correct / rewrite / audit drafts |
| Long-form memory aids | Outlines, summaries, recent excerpts, character panels stay in context |
| Local & controllable | Keys and books stay on your machine; background writing continues offline from the UI |

---

## Features & screenshots

### 1. Home workbench

Create long novels / scripts, manage projects, open Settings. Clear warning when no API key is configured.

<p align="center"><img src="docs/screenshots/01-home.png" alt="Home" width="920" /></p>

### 2. Skills (prompts)

Separate skill sets for long novels and scripts (outline revise, writer, auditor, …). Edit or restore defaults.

<p align="center"><img src="docs/screenshots/02-skills.png" alt="Skills" width="920" /></p>

### 3. Loop workflow nodes

Reorder nodes for **book building / auto-continue / manual writing**.

<p align="center"><img src="docs/screenshots/03-loop.png" alt="Loop" width="920" /></p>

### 4. Hot-topic guide + one-click fill / foundation progress

Market-style guidance, one-click premise fill, and fine-grained progress while generating outline & worldbuilding (percent, step/total time, remaining work).

<p align="center"><img src="docs/screenshots/04-foundation-progress.png" alt="Foundation progress" width="920" /></p>

### 5. Confirm settings (outline / world / foreshadowing)

Review, regenerate from feedback, or confirm and start writing.

<p align="center"><img src="docs/screenshots/05-confirm-settings.png" alt="Confirm settings" width="920" /></p>

### 6. Confirm next 5 chapter outlines

Edit per chapter, regenerate from global notes, then structure audit.

<p align="center"><img src="docs/screenshots/06-confirm-outline.png" alt="Confirm outlines" width="920" /></p>

### 7. Chapter draft complete

Auto-correct, revise, rewrite, or continue into automatic audit.

<p align="center"><img src="docs/screenshots/07-draft-done.png" alt="Draft complete" width="920" /></p>

### 8. Continuity audit

Round-by-round score and issues (setting consistency, pacing, AI clichés), feeding the revise loop.

<p align="center"><img src="docs/screenshots/08-audit.png" alt="Audit" width="920" /></p>

### Other capabilities

- **Character attribute panel** (game / LitRPG, etc.): level, stats, gear, skills—injected while writing, updatable after chapters.  
- **Auto-continue + watchdog**: jobs run in the local server process; page close does not stop them; download keep-awake / control scripts.  
- **Error self-help**: look up codes / keywords for fix hints.  
- **Any OpenAI-compatible API**: DeepSeek and others.  
- **Input logs**: store key premises and prompts locally for debugging.

---

## Install & deploy

### Requirements

- **Node.js ≥ 20**
- Network access to your model API (bring your own API key)

### Steps

```bash
git clone https://github.com/JACEZ123/jace-novel-generator.git
cd jace-novel-generator
npm install

# Optional local config files (you can also fill the key later in the UI)
cp data/config.example.json data/config.json
cp data/model-config.example.json data/model-config.json

npm start
```

Open **http://localhost:4568**

1. **Settings → Model service**  
2. Enter **API key** and **Base URL** (DeepSeek example: `https://api.deepseek.com`)  
3. Save, then **Start creating / New project**

### Optional environment variables

Override endpoint / models / port only. **Do not put secrets in env files or the repo.**

| Variable | Meaning | Default |
|----------|---------|---------|
| `NOVEL_BASE_URL` | OpenAI-compatible base URL | `https://api.deepseek.com` |
| `NOVEL_MODEL` | Fast model | `deepseek-v4-flash` |
| `NOVEL_MODEL_STRONG` | Strong model | `deepseek-v4-pro` |
| `NOVEL_PORT` | Server port | `4568` |

### Background auto-writing

1. Keep `npm start` running  
2. **Settings → Auto writing**: stop conditions  
3. Download OS scripts for start / stop / status / keep-awake  

See [docs/auto-writing.md](./docs/auto-writing.md).

### Layout (short)

```
server.mjs              HTTP + SSE orchestration, settings APIs
lib/engine.mjs          Writing engine (foundation / draft / audit / revise)
lib/default-skills.mjs  Built-in skill defaults
auto-ctl.mjs            Background auto-write control
public/                 Frontend (vanilla HTML/CSS/JS)
data/                   Local config & books (mostly gitignored)
docs/screenshots/       README screenshots
```

---

## Keys & privacy

- API keys are entered only under **Settings → Model service**, stored in local `data/config.json` (gitignored).  
- The repo ships **without** real keys, private book text, or tokens.  
- Before push/fork, ensure `data/config.json`, `data/books/`, and `.env` are not staged.  
- If a key ever leaked, **rotate it** at the provider.

See [data/README.md](./data/README.md).

---

## License & attribution

**MIT License.**

- **Allowed:** download, use, modify, redistribute, personal or commercial side projects.  
- **Required:** keep the copyright/license notices and **credit author Jace** ([LICENSE](./LICENSE), [AUTHORS](./AUTHORS)).

Stars, issues, and PRs welcome.

---

## Author

**Jace** · Web Novel Generator / 网文小说生成器  
GitHub: [@JACEZ123](https://github.com/JACEZ123)
