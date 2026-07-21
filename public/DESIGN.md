# 网文小说生成器 · 设计系统（作者 Jace）

> © Jace · MIT License  
> 来源：`python search.py "productivity AI writing tool" --design-system -p "网文小说生成器"`  
> 参考：[ui-ux-pro-max-skill-cn](https://github.com/bbylw/ui-ux-pro-max-skill-cn) → [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)

## 模式

**浅色优先** · Micro-interactions · 密度 6/10 · 方差 5/10

## 色彩 Token

| 角色 | 变量 | 值 |
|------|------|-----|
| Primary | `--color-primary` | `#0D9488` |
| Secondary | `--color-secondary` | `#14B8A6` |
| Accent CTA | `--color-accent` | `#EA580C` |
| Background | `--color-background` | `#F0FDFA` |
| Foreground | `--color-foreground` | `#134E4A` |
| Surface | `--color-surface` | `#FFFFFF` |
| Muted | `--color-muted` | `#E8F1F4` |
| Border | `--color-border` | `#99F6E4` |
| Destructive | `--color-destructive` | `#DC2626` |
| Ring | `--color-ring` | `#0D9488` |

## 字体

- **UI**：Plus Jakarta Sans（中文 fallback 系统栈）
- **代码/状态**：JetBrains Mono
- **阅读正文**：系统宋体栈

## 组件原则（skill checklist）

- 不用 emoji 当图标
- 可点击元素 `cursor: pointer` + 150–300ms 过渡
- 正文对比度 ≥ 4.5:1
- `:focus-visible` 可见焦点环
- `prefers-reduced-motion` 降级
- 8px 间距节奏

## 反模式

- 纯黑底 `#000` / 霓虹 HUD 暗色
- 军事化英文标签（SYS ONLINE、MOD-01）
- 过重 blur / glow
