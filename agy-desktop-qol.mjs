#!/usr/bin/env node
/**
 * Antigravity Desktop 跨平台外观注入工具 (CDP 方案，零文件修改、零第三方依赖)
 * 支持 macOS / Windows / Linux (需 Node.js >= 22，原生支持 fetch & WebSocket)
 *
 * 用法:
 *   node agy-wallpaper.mjs                     # 启动交互式 TUI 配置界面
 *   node agy-wallpaper.mjs <图片路径> [透明度]   # 命令行直接注入壁纸 + 输入框样式改善
 *   node agy-wallpaper.mjs --clear             # 仅清除壁纸，保留输入框样式改善
 *   node agy-wallpaper.mjs --clear-all         # 清除所有注入样式
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

const CDP_PORT = Number(process.env.AGY_CDP_PORT || 9222);
const STATS_PORT = Number(process.env.AGY_STATS_PORT || 9223);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const WALLPAPER_STYLE_ID = 'agy-custom-wallpaper';
const UI_STYLE_ID = 'agy-clean-ui';
const STATS_SCRIPT_ID = 'agy-stats-bar-script';

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const DEFAULT_CONFIG = {
  enableWallpaper: true,
  imagePath: '',
  opacity: 0.12,
  enableInputStyle: true,
  enableStatsBar: true,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch {
    // ignore corrupt config
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getTargets() {
  try {
    const res = await fetch(`${CDP_URL}/json`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function launchAntigravity() {
  const platform = os.platform();
  const args = [`--remote-debugging-port=${CDP_PORT}`];

  if (platform === 'darwin') {
    spawn('open', ['-a', 'Antigravity', '--args', ...args], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  if (platform === 'win32') {
    const candidates = [
      process.env.AGY_BIN,
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Antigravity', 'Antigravity.exe'),
    ].filter(Boolean);
    const exe = candidates.find((p) => fs.existsSync(p)) || 'Antigravity.exe';
    spawn(exe, args, { detached: true, stdio: 'ignore', shell: false }).unref();
    return;
  }

  const linuxBin = process.env.AGY_BIN || 'antigravity';
  spawn(linuxBin, args, { detached: true, stdio: 'ignore' }).unref();
}

async function ensureCDPReady(logFn = console.log) {
  let targets = await getTargets();
  if (targets) return targets;

  logFn(`[info] 未检测到 CDP 端口 ${CDP_PORT}，正在启动 Antigravity Desktop...`);
  launchAntigravity();

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    targets = await getTargets();
    if (targets && targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('data:'))) {
      return targets;
    }
  }

  throw new Error(
    `等待 CDP 端口 ${CDP_PORT} 超时。如果 Antigravity 已在运行，请先完全退出后再运行本脚本。`
  );
}

function buildInjectJS(id, cssText) {
  const escaped = JSON.stringify(cssText);
  return `(() => {
    const id = ${JSON.stringify(id)};
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = ${escaped};
    return 'ok';
  })()`;
}

function buildRemoveJS(id) {
  return `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (el) el.remove();
    return 'removed';
  })()`;
}

function evalOverCDP(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP WebSocket 超时'));
    }, 5000);

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        })
      );
    });

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          clearTimeout(timer);
          ws.close();
          resolve(msg.result);
        }
      } catch {
        // ignore
      }
    });

    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

let statsServerStarted = false;

function computeConversationStats(convId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(convId)) return null;
  const logPath = path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'brain',
    convId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  if (!fs.existsSync(logPath)) return null;

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  let turns = 0;
  let steps = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let lastContextTokens = 0;
  let lastModel = '';
  let modelMs = 0;
  let prevTime = null;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const t = obj.created_at ? Date.parse(obj.created_at) : null;
      if (obj.type === 'USER_INPUT') {
        turns++;
      } else if (obj.type === 'PLANNER_RESPONSE') {
        steps++;
        if (obj.model) lastModel = String(obj.model);
        const stepIn = Number(obj.input_tokens || 0);
        const stepCache = Number(obj.cache_read_tokens || 0);
        const stepOut = Number(obj.output_tokens || 0);
        inputTokens += stepIn;
        cacheReadTokens += stepCache;
        outputTokens += stepOut;
        lastContextTokens = stepIn + stepCache + stepOut;
        if (t && prevTime && t > prevTime) {
          const dt = t - prevTime;
          if (dt > 0 && dt < 120000) modelMs += dt;
        }
      }
      if (t) prevTime = t;
    } catch {
      // ignore malformed line
    }
  }

  let maxContext = 512000;
  try {
    const pbtxtPath = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations', `${convId}.pbtxt`);
    if (fs.existsSync(pbtxtPath)) {
      const head = fs.readFileSync(pbtxtPath, 'utf8').slice(0, 65536);
      const m = head.match(/max_token_limit:\s*(\d+)/);
      if (m && Number(m[1]) > 0) maxContext = Number(m[1]);
    }
  } catch {
    // fallback 512000
  }
  const totalTokens = inputTokens + cacheReadTokens + outputTokens;
  const promptTokens = inputTokens + cacheReadTokens;
  const cacheHitRate = promptTokens > 0 ? Math.round((cacheReadTokens / promptTokens) * 100) : 0;
  const tps = modelMs > 0 ? Math.round(outputTokens / (modelMs / 1000)) : 0;
  const contextPct = Math.min(100, Math.round((lastContextTokens / maxContext) * 100));

  const hasAgyContext = fs.existsSync(
    path.join(os.homedir(), '.gemini', 'config', 'plugins', 'context', 'plugin.json')
  );

  return {
    turns,
    steps,
    totalTokens,
    outputTokens,
    cacheHitRate,
    tps,
    contextPct,
    modelSeconds: Math.round(modelMs / 1000),
    lastContextTokens,
    maxContext,
    hasAgyContext,
  };
}

function ensureStatsServer() {
  if (statsServerStarted) return;
  statsServerStarted = true;
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const url = new URL(req.url, `http://127.0.0.1:${STATS_PORT}`);
    if (url.pathname === '/stats') {
      const id = url.searchParams.get('id') || '';
      const data = computeConversationStats(id);
      res.end(JSON.stringify(data || { turns: 0, steps: 0, totalTokens: 0, outputTokens: 0, cacheHitRate: 0, tps: 0 }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  server.on('error', () => {
    // 端口已被其他实例占用时静默复用
  });
  server.listen(STATS_PORT, '127.0.0.1');
}

function buildStatsBarInjectJS() {
  return `(() => {
    if (window.__agyStatsTimer) clearInterval(window.__agyStatsTimer);
    const old = document.getElementById('agy-stats-bar');
    if (old) old.remove();

    const formatTok = (n) => {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return Math.round(n / 1000) + 'K';
      return String(n);
    };

    const formatDuration = (sec) => {
      if (!sec) return '0 秒';
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m > 0 ? m + ' 分 ' + s + ' 秒' : s + ' 秒';
    };

    const ensureBar = () => {
      const composer = document.querySelector('.surface-composer');
      if (!composer || !composer.parentElement) return null;
      let bar = document.getElementById('agy-stats-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'agy-stats-bar';
        bar.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;gap:12px;padding:6px 10px 2px;font-size:12px;color:rgba(255,255,255,0.55);user-select:none;font-family:system-ui,-apple-system,sans-serif;cursor:default;';

        const pop = document.createElement('div');
        pop.id = 'agy-stats-popover';
        pop.style.cssText = 'display:none;position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:8px;width:260px;padding:12px 14px;border-radius:12px;background:rgba(28,28,34,0.96);border:1px solid rgba(255,255,255,0.12);box-shadow:0 8px 28px rgba(0,0,0,0.45);backdrop-filter:blur(12px);color:rgba(255,255,255,0.88);font-size:12px;z-index:100000;pointer-events:none;';
        bar.appendChild(pop);

        bar.addEventListener('mouseenter', () => { pop.style.display = 'block'; });
        bar.addEventListener('mouseleave', () => { pop.style.display = 'none'; });

        composer.parentElement.appendChild(bar);
      }
      return bar;
    };

    const refresh = async () => {
      const bar = ensureBar();
      if (!bar) return;
      const m = location.pathname.match(/\\/c\\/([a-zA-Z0-9_-]+)/);
      if (!m) {
        bar.textContent = '会话统计: 等待对话...';
        return;
      }
      try {
        const res = await fetch('http://127.0.0.1:${STATS_PORT}/stats?id=' + m[1]);
        const d = await res.json();
        const pct = d.contextPct ?? 0;
        const r = 5;
        const c = 2 * Math.PI * r;
        const offset = c - (pct / 100) * c;
        const ringSvg =
          '<svg width="14" height="14" viewBox="0 0 14 14" style="transform:rotate(-90deg);flex-shrink:0;">' +
          '<circle cx="7" cy="7" r="' + r + '" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>' +
          '<circle cx="7" cy="7" r="' + r + '" fill="none" stroke="rgba(255,255,255,0.75)" stroke-width="2" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '" stroke-linecap="round"/>' +
          '</svg>';
        const gaugeSvg =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.85;">' +
          '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>';
        const dbSvg =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.85;">' +
          '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>';
        const pop = document.getElementById('agy-stats-popover');
        if (pop) {
          const row = (k, v) =>
            '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;">' +
            '<span style="color:rgba(255,255,255,0.55);">' + k + '</span>' +
            '<span style="font-variant-numeric:tabular-nums;">' + v + '</span></div>';
          pop.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:8px;margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.1);font-weight:600;">' +
            '<span style="display:inline-flex;align-items:center;gap:6px;">' + gaugeSvg + '会话统计</span><span>' + d.turns + ' 轮 ' + d.steps + ' 步</span></div>' +
            row('模型用时', formatDuration(d.modelSeconds)) +
            row('输出速度 (TPS)', (d.tps || '--') + ' tok/s') +
            row('输出 Token', formatTok(d.outputTokens)) +
            row('总 Token', formatTok(d.totalTokens)) +
            row('缓存命中率', d.cacheHitRate + '%') +
            row('上下文占用', formatTok(d.lastContextTokens || 0) + ' / ' + formatTok(d.maxContext || 512000) + ' (' + pct + '%)');
        }
        let summary = document.getElementById('agy-stats-summary');
        if (!summary) {
          summary = document.createElement('div');
          summary.id = 'agy-stats-summary';
          summary.style.cssText = 'display:flex;align-items:center;gap:12px;';
          bar.appendChild(summary);
        }
        summary.innerHTML =
          '<span style="display:inline-flex;align-items:center;gap:5px;">' + gaugeSvg + d.turns + ' 轮 ' + d.steps + ' 步 · ' + (d.tps || '--') + ' tok/s</span>' +
          '<span style="opacity:0.35">|</span>' +
          '<span style="display:inline-flex;align-items:center;gap:5px;">' + dbSvg + formatTok(d.totalTokens) + ' tok · 缓存命中 ' + d.cacheHitRate + '%</span>' +
          '<span style="opacity:0.35">|</span>' +
          '<span id="agy-context-trigger" title="' + (d.hasAgyContext ? '点击打开 Context 面板' : '') + '" style="display:inline-flex;align-items:center;gap:5px;' + (d.hasAgyContext ? 'cursor:pointer;' : '') + '">' + ringSvg + pct + '%</span>';
        const trigger = document.getElementById('agy-context-trigger');
        if (trigger && d.hasAgyContext) {
          trigger.onclick = () => {
            const u = new URL(location.href);
            u.searchParams.set('tab', 'sidecar__context/context_panel__/');
            history.pushState({}, '', u.toString());
            window.dispatchEvent(new PopStateEvent('popstate'));
          };
        }
      } catch {
        bar.textContent = '会话统计: 本地服务未连接';
      }
    };

    refresh();
    window.__agyStatsTimer = setInterval(refresh, 2000);
    return 'stats-ok';
  })()`;
}

function buildStatsBarRemoveJS() {
  return `(() => {
    if (window.__agyStatsTimer) {
      clearInterval(window.__agyStatsTimer);
      window.__agyStatsTimer = null;
    }
    const bar = document.getElementById('agy-stats-bar');
    if (bar) bar.remove();
    return 'stats-removed';
  })()`;
}

const CLEAN_INPUT_CSS = `
  *, *::before, *::after {
    box-shadow: none !important;
  }
  .surface-composer,
  [role="dialog"],
  [role="menu"],
  [data-radix-popper-content-wrapper] > * {
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
  }
`;

async function applyConfig(cfg, logFn = console.log) {
  const parts = [];

  if (cfg.enableWallpaper) {
    if (!cfg.imagePath) {
      throw new Error('已启用注入背景，但未设置图片路径');
    }
    const imgPath = path.resolve(cfg.imagePath);
    if (!fs.existsSync(imgPath)) {
      throw new Error(`找不到图片文件: ${imgPath}`);
    }
    const ext = path.extname(imgPath).toLowerCase();
    const mime = MIME_MAP[ext] || 'image/png';
    const base64 = fs.readFileSync(imgPath).toString('base64');
    const opacity = Math.min(1, Math.max(0, Number(cfg.opacity ?? 0.12)));

    const wpCss = `
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        z-index: 99999;
        pointer-events: none;
        background-image: url("data:${mime};base64,${base64}");
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        opacity: ${opacity};
      }
    `;
    parts.push(buildInjectJS(WALLPAPER_STYLE_ID, wpCss));
  } else {
    parts.push(buildRemoveJS(WALLPAPER_STYLE_ID));
  }

  if (cfg.enableInputStyle) {
    parts.push(buildInjectJS(UI_STYLE_ID, CLEAN_INPUT_CSS));
  } else {
    parts.push(buildRemoveJS(UI_STYLE_ID));
  }

  if (cfg.enableStatsBar) {
    ensureStatsServer();
    parts.push(buildStatsBarInjectJS());
  } else {
    parts.push(buildStatsBarRemoveJS());
  }

  const expression = parts.join('; ');
  const targets = await ensureCDPReady(logFn);
  const pages = targets.filter(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('data:')
  );
  if (pages.length === 0) {
    throw new Error('未找到可注入的页面目标');
  }

  for (const page of pages) {
    await evalOverCDP(page.webSocketDebuggerUrl, expression);
  }

  return pages.length;
}

// ---------------- 交互式 TUI ----------------

async function promptText(question, defaultValue = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` (当前: ${defaultValue})` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim().replace(/^['"]|['"]$/g, '');
      resolve(trimmed || defaultValue);
    });
  });
}

async function runTUI() {
  const cfg = loadConfig();
  let cursor = 0;
  let statusMsg = '使用 ↑/↓ 选择，Space/Enter 切换或编辑，q 退出';

  const getItems = () => [
    {
      key: 'toggleWallpaper',
      label: `[${cfg.enableWallpaper ? 'x' : ' '}] 启用注入背景`,
      action: () => {
        cfg.enableWallpaper = !cfg.enableWallpaper;
        saveConfig(cfg);
      },
    },
    {
      key: 'imagePath',
      label: `    背景图片路径: ${cfg.imagePath || '(未设置)'}`,
      needInput: true,
      action: async () => {
        const val = await promptText('请输入背景图片路径', cfg.imagePath);
        cfg.imagePath = val;
        saveConfig(cfg);
      },
    },
    {
      key: 'opacity',
      label: `    背景透明度:   ${cfg.opacity}`,
      needInput: true,
      action: async () => {
        const val = await promptText('请输入透明度 (0.0 ~ 1.0)', String(cfg.opacity));
        const num = Number(val);
        if (!Number.isNaN(num)) {
          cfg.opacity = Math.min(1, Math.max(0, num));
          saveConfig(cfg);
        } else {
          statusMsg = '[warn] 透明度必须是数字';
        }
      },
    },
    {
      key: 'toggleInput',
      label: `[${cfg.enableInputStyle ? 'x' : ' '}] 启用样式扁平化 (全局去阴影叠加 + 极简细边框)`,
      action: () => {
        cfg.enableInputStyle = !cfg.enableInputStyle;
        saveConfig(cfg);
      },
    },
    {
      key: 'toggleStatsBar',
      label: `[${cfg.enableStatsBar ? 'x' : ' '}] 启用底部会话统计栏 (轮数/步数 · tok/s · 缓存命中率)`,
      action: () => {
        cfg.enableStatsBar = !cfg.enableStatsBar;
        saveConfig(cfg);
      },
    },
    {
      key: 'apply',
      label: '▶ 应用配置并注入到 Antigravity Desktop',
      action: async () => {
        statusMsg = '[info] 正在注入...';
        render();
        try {
          const count = await applyConfig(cfg, (m) => {
            statusMsg = m;
            render();
          });
          saveConfig(cfg);
          statusMsg = `[ok] 已成功应用配置到 ${count} 个窗口`;
        } catch (err) {
          statusMsg = `[error] ${err.message || err}`;
        }
      },
    },
    {
      key: 'clearAll',
      label: '✕ 清除所有注入样式 (恢复原生)',
      action: async () => {
        try {
          const count = await applyConfig(
            { ...cfg, enableWallpaper: false, enableInputStyle: false },
            (m) => {
              statusMsg = m;
              render();
            }
          );
          statusMsg = `[ok] 已清除 ${count} 个窗口的所有注入样式`;
        } catch (err) {
          statusMsg = `[error] ${err.message || err}`;
        }
      },
    },
    {
      key: 'quit',
      label: '退出',
      action: () => {
        process.stdout.write('\x1b[?25h\n');
        process.exit(0);
      },
    },
  ];

  function render() {
    const items = getItems();
    process.stdout.write('\x1b[2J\x1b[H');
    console.log('\x1b[1;36m=== Antigravity Desktop 外观配置 (CDP 零修改注入) ===\x1b[0m');
    console.log(`CDP 端口: ${CDP_PORT}  |  配置文件: ${CONFIG_PATH}\n`);

    items.forEach((item, idx) => {
      const prefix = idx === cursor ? '\x1b[1;32m❯ ' : '  ';
      const suffix = idx === cursor ? '\x1b[0m' : '';
      console.log(`${prefix}${item.label}${suffix}`);
    });

    console.log(`\n\x1b[33m${statusMsg}\x1b[0m`);
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('\x1b[?25l');
  render();

  const onKeypress = async (_str, key) => {
    if (!key) return;
    const items = getItems();

    if (key.ctrl && key.name === 'c') {
      process.stdout.write('\x1b[?25h\n');
      process.exit(0);
    }
    if (key.name === 'q') {
      process.stdout.write('\x1b[?25h\n');
      process.exit(0);
    }
    if (key.name === 'up' || key.name === 'k') {
      cursor = (cursor - 1 + items.length) % items.length;
      render();
      return;
    }
    if (key.name === 'down' || key.name === 'j') {
      cursor = (cursor + 1) % items.length;
      render();
      return;
    }
    if (key.name === 'return' || key.name === 'space') {
      const item = items[cursor];
      if (item.needInput) {
        process.stdin.removeListener('keypress', onKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdout.write('\x1b[?25h\n');
        await item.action();
        process.stdin.resume();
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdout.write('\x1b[?25l');
        process.stdin.on('keypress', onKeypress);
      } else {
        await item.action();
      }
      render();
    }
  };

  process.stdin.on('keypress', onKeypress);
}

async function runWatchMode() {
  // 兼容作为 Antigravity 插件 MCP stdio 进程被拉起时的基础 JSON-RPC 握手
  if (!process.stdin.isTTY) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) {
            if (msg.method === 'initialize') {
              process.stdout.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    serverInfo: { name: 'agy-desktop-qol', version: '1.0.0' },
                  },
                }) + '\n'
              );
            } else {
              process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
            }
          }
        } catch {
          // ignore
        }
      }
    });
  }

  const cfg = loadConfig();
  if (cfg.enableStatsBar) ensureStatsServer();

  const tick = async () => {
    try {
      const currentCfg = loadConfig();
      const targets = await getTargets();
      if (!targets) return;
      const pages = targets.filter(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('data:')
      );
      for (const page of pages) {
        const check = await evalOverCDP(
          page.webSocketDebuggerUrl,
          `Boolean(document.getElementById(${JSON.stringify(WALLPAPER_STYLE_ID)}) || document.getElementById(${JSON.stringify(UI_STYLE_ID)}) || document.getElementById('agy-stats-bar'))`
        );
        if (check && check.result && check.result.value === false) {
          await applyConfig(currentCfg, () => {});
          break;
        }
      }
    } catch {
      // CDP 未就绪或页面切换中，下个周期重试
    }
  };

  await tick();
  setInterval(tick, 3000);
}

// ---------------- 入口 ----------------

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('[error] 需要 Node.js >= 22（原生支持 WebSocket）。当前版本:', process.version);
    process.exit(1);
  }

  const arg1 = process.argv[2];
  if (arg1 === '--watch') {
    await runWatchMode();
    return;
  }
  if (!arg1) {
    await runTUI();
    return;
  }

  const cfg = loadConfig();
  if (arg1 === '--clear') {
    cfg.enableWallpaper = false;
    cfg.enableInputStyle = true;
    const count = await applyConfig(cfg);
    console.log(`[ok] 已清除壁纸（保留输入框样式改善），共 ${count} 个窗口`);
    return;
  }

  if (arg1 === '--clear-all') {
    const count = await applyConfig({ ...cfg, enableWallpaper: false, enableInputStyle: false });
    console.log(`[ok] 已清除所有注入样式，共 ${count} 个窗口`);
    return;
  }

  cfg.enableWallpaper = true;
  cfg.imagePath = path.resolve(arg1);
  if (process.argv[3] !== undefined) {
    cfg.opacity = Math.min(1, Math.max(0, Number(process.argv[3])));
  }
  saveConfig(cfg);
  const count = await applyConfig(cfg);
  console.log(`[ok] 已注入壁纸到 ${count} 个窗口`);
}

main().catch((err) => {
  console.error('[error]', err.message || err);
  process.exit(1);
});
