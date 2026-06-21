#!/usr/bin/env bash
# Installs the claude-dependency-mapper skill into your Claude Code skills directory
# (without using the plugin system). Run from inside the cloned/extracted repo:  ./install.sh
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/skills/claude-dependency-mapper"
DEST="${HOME}/.claude/skills/claude-dependency-mapper"
mkdir -p "$DEST"
cp "$SRC/SKILL.md" "$SRC/gen-graph.mjs" "$DEST/"
echo "Installed to: $DEST"
echo "Run /claude-dependency-mapper inside a project (start a new Claude Code session if one was open)."
