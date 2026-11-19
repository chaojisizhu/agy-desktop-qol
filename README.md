# agy-desktop-qol

> Zero-dependency, cross-platform Quality-of-Life (QoL) enhancer & native Sidecar plugin for **Antigravity Desktop** via Chrome DevTools Protocol (CDP).

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)](#)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)](#)

---

## ✨ Features

- **🎨 Custom Wallpaper (Local & URL)**: Inject any local image path, `https://` URL, or `data:image/...` as a translucent ambient background layer (`opacity` configurable via slider, default `0.12`). Remote URLs are converted to `base64` on the fly to bypass CSP restrictions.
- **🪄 Style Flattening (样式扁平化)**: Globally remove multi-layer `box-shadow` / glow overlays and apply clean `1px` hairline borders.
- **📊 Session Stats Bar & Live Internal Status**: Centered bottom bar below the composer showing:
  - **Live 4-Char Status Slot**: Real-time internal state parsed from `transcript.jsonl` & `language_server.log` without layout shift (`空闲状态` / `等待响应` / `接收响应` / `执行工具` / `安全检查` / `容量不足` / `重试请求` / `请求出错`).
  - **Turns, Steps & Speed**: `X 轮 Y 步` and average output speed (`tok/s`).
  - **Tokens & Cache Hit**: Total tokens and prompt cache hit rate (`缓存命中 XX%`).
  - **Context Usage Ring**: Reads local `transcript.jsonl` & `.pbtxt` `max_token_limit`.
  - **Interactive Hover Popover**: Detailed session metrics, elapsed seconds, active tool names, and 503 / retry diagnostics.
  - **Configurable Click Action**: Click the stats bar to open any Sidecar panel (defaults to `sidecar__context/context_panel__/`) or external URL.
- **⎋ Double-ESC to Cancel**: Double-press `ESC` while generating (within 2 seconds, with a centered confirmation toast) to stop generation without conflicting with open menus, dialogs, or IME composition.
- **🎛️ Native Sidecar Settings Panel (`Desktop QoL`)**: Built-in Web UI panel under `⋮ -> Extensions -> Desktop QoL` with toggle switches, opacity slider, bilingual i18n (`中文` / `EN`), and an in-process background daemon (`startWatchLoop`) that hosts the `9223` stats server and auto-injects via CDP on startup.
- **🖥️ Interactive CLI / TUI**: Also usable standalone via terminal TUI or CLI flags.

---

## 📦 Requirements

- **Node.js >= 22** (or Antigravity Desktop's built-in runtime when running as a Sidecar plugin; zero `npm install` needed)
- Launch Antigravity Desktop with `--remote-debugging-port=9222`

---

## 🚀 Quick Start

### 1. Install as Antigravity Plugin (Recommended)
```bash
agy plugin install https://github.com/peach0x33a/agy-desktop-qol

# Or link/clone directly into Antigravity plugins directory:
ln -s "$(pwd)" ~/.gemini/config/plugins/agy-desktop-qol
```

Once installed, open **`⋮ -> Extensions -> Desktop QoL`** in Antigravity Desktop to configure all options visually.

### 2. Interactive Terminal TUI
```bash
node agy-desktop-qol.mjs
```

### 3. CLI Shortcuts
```bash
node agy-desktop-qol.mjs <image-path-or-url> [opacity]
node agy-desktop-qol.mjs --apply       # Apply current config.json once via CDP
node agy-desktop-qol.mjs --watch       # Standalone background auto-inject daemon
node agy-desktop-qol.mjs --clear       # Clear wallpaper only
node agy-desktop-qol.mjs --clear-all   # Clear all injected styles
```
