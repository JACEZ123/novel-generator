#!/usr/bin/env bash
# ============================================================================
# 网文小说生成器 · 作者 Jace
# 防止 macOS 在自动写作期间休眠（阻止系统睡眠；显示器仍可能关闭）
# 用法：bash scripts/keep-awake-mac.sh
# 结束：Ctrl+C
# © Jace · MIT License
# ============================================================================

set -euo pipefail
echo "caffeinate 运行中：系统不会因空闲睡眠。Ctrl+C 结束并恢复。"
echo "请另开终端保持：npm start 与自动连写任务。"
exec caffeinate -dims
