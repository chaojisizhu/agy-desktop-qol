# agy-desktop-qol

> Zero-dependency, cross-platform Quality-of-Life (QoL) enhancer & Antigravity plugin for **Antigravity Desktop** via Chrome DevTools Protocol (CDP).

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)](#)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)](#)

---

## ✨ Features

- **🎨 Custom Wallpaper**: Inject any local image as a translucent ambient background layer (`opacity` configurable, default `0.12`).
- **🪄 Style Flattening (样式扁平化)**: Globally remove multi-layer `box-shadow` / glow overlays and apply clean `1px` hairline borders.
- **📊 Session Stats Bar**: Centered bottom bar below the composer showing:
  - Turns & steps (`X 轮 Y 步`) and average output speed (`tok/s`)
  - Total tokens & cache hit rate (`缓存命中 XX%`)
  - Context usage SVG ring (reads local `transcript.jsonl` & `.pbtxt` `max_token_limit`)
  - Hover popover with detailed session metrics & one-click jump to `agy-context` if installed
- **🔌 Auto-Inject Plugin Mode**: Packaged with `plugin.json` + `mcp_config.json` so Antigravity Desktop automatically launches `--watch` in the background on startup.
- **🖥️ Interactive TUI**: Configure all options with arrow keys, persisted in `config.json`.

---

## 📦 Requirements

- **Node.js >= 22** (uses native `fetch` and `WebSocket`, zero `npm install` needed)
- Launch Antigravity Desktop with `--remote-debugging-port=9222`

---

## 🚀 Quick Start

### 1. Interactive TUI (Recommended)
```bash
node agy-desktop-qol.mjs
```

### 2. Install as Antigravity Plugin (Auto-Inject on Startup)
```bash
# Link or clone into Antigravity plugins directory:
ln -s "$(pwd)" ~/.gemini/config/plugins/agy-desktop-qol
```
*(Or install via `agy plugin install <your-github-repo-url>` once published.)*

### 3. CLI Shortcuts
```bash
node agy-desktop-qol.mjs <image-path> [opacity]
node agy-desktop-qol.mjs --watch       # Background auto-inject daemon
node agy-desktop-qol.mjs --clear       # Clear wallpaper only
node agy-desktop-qol.mjs --clear-all   # Clear all injected styles
```
