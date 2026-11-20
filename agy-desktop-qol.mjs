#!/usr/bin/env node
/**
 * Antigravity Desktop 跨平台外观注入工具 (CDP 方案，零文件修改、零第三方依赖)
 * 支持 macOS / Windows / Linux (需 Node.js >= 22，原生支持 fetch & WebSocket)
 *
 * 用法:
 *   node agy-desktop-qol.mjs                     # 启动交互式 TUI 配置界面
 *   node agy-desktop-qol.mjs <图片路径> [透明度]   # 命令行直接注入壁纸 + 输入框样式改善
 *   node agy-desktop-qol.mjs --clear             # 仅清除壁纸，保留输入框样式改善
 *   node agy-desktop-qol.mjs --clear-all         # 清除所有注入样式
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
let nodeSqlite = null;
try {
  nodeSqlite = await import('node:sqlite');
} catch {
  // Node < 22.5: 回退为推断上限
}
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

function normalizePort(val, fallback = 9222) {
  const n = Number(val);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

const DEFAULT_CDP_PORT = normalizePort(process.env.AGY_CDP_PORT, 9222);
const PREFERRED_STATS_PORT = Number(process.env.AGY_STATS_PORT || 9223);
const WALLPAPER_STYLE_ID = 'agy-custom-wallpaper';
const UI_STYLE_ID = 'agy-clean-ui';
const STATS_SCRIPT_ID = 'agy-stats-bar-script';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const DEFAULT_LANG = (process.env.LC_ALL || process.env.LANG || '').toLowerCase().startsWith('zh')
  ? 'zh'
  : 'en';

const DEFAULT_CONFIG = {
  lang: DEFAULT_LANG,
  cdpPort: DEFAULT_CDP_PORT,
  enableWallpaper: true,
  imagePath: '',
  opacity: 0.12,
  enableInputStyle: true,
  enableStatsBar: true,
  enableEscCancel: true,
  statsClickTarget: 'sidecar__context/context_panel__/',
  statsBarItems: ['status', 'turns', 'tokens', 'context'],
};

const I18N = {
  zh: {
    title: '=== Antigravity Desktop 外观配置 (CDP 零修改注入) ===',
    cdpPort: 'CDP 端口',
    configFile: '配置文件',
    langLabel: '语言 / Language: 中文 (按 Enter 切换)',
    enableWallpaper: '启用注入背景',
    imagePath: '背景图片路径',
    unset: '(未设置)',
    opacity: '背景透明度',
    enableFlat: '启用样式扁平化 (全局去阴影叠加 + 极简细边框)',
    enableStats: '启用底部会话统计栏 (轮数/步数 · tok/s · 缓存命中率)',
    statsBarItems: '底栏显示项 (status, turns, tokens, context)',
    promptStatsItems: '输入底栏显示项，逗号分隔 (status, turns, tokens, context)',
    apply: '▶ 应用配置并注入到 Antigravity Desktop',
    clearAll: '✕ 清除所有注入样式 (恢复原生)',
    quit: '退出',
    hint: '使用 ↑/↓ 选择，Space/Enter 切换或编辑，q 退出',
    promptImg: '请输入背景图片路径',
    promptOpacity: '请输入透明度 (0.0 ~ 1.0)',
    warnOpacity: '[warn] 透明度必须是数字',
    injecting: '[info] 正在注入...',
    applied: (n) => `[ok] 已成功应用配置到 ${n} 个窗口`,
    clearedAll: (n) => `[ok] 已清除 ${n} 个窗口的所有注入样式`,
    bar: {
      waiting: '会话统计: 等待对话...',
      disconnected: '会话统计: 本地服务未连接',
      turns: '轮',
      steps: '步',
      cacheHit: '缓存命中',
      openContext: '点击打开 Context 面板',
      popTitle: '会话统计',
      modelTime: '模型用时',
      tps: '输出速度 (TPS)',
      outTok: '输出 Token',
      totTok: '总 Token',
      cacheRate: '缓存命中率',
      ctxUsage: '上下文占用',
      min: '分',
      sec: '秒',
      liveTitle: '内部状态',
      phaseIdle: '空闲状态',
      phaseWaiting: '等待响应',
      phaseStreaming: '接收响应',
      phaseTool: '执行工具',
      phaseMonitor: '安全检查',
      phaseRetry: '重试请求',
      phaseError: '请求出错',
      retryAttempt: '次',
      retryIn: '后重试',
      noCapacity: '容量不足',
    },
  },
  en: {
    title: '=== Antigravity Desktop QoL Config (Zero-Mod CDP) ===',
    cdpPort: 'CDP Port',
    configFile: 'Config',
    langLabel: 'Language / 语言: English (Enter to switch)',
    enableWallpaper: 'Enable Custom Wallpaper',
    imagePath: 'Wallpaper Path',
    unset: '(not set)',
    opacity: 'Wallpaper Opacity',
    enableFlat: 'Enable Style Flattening (No Shadows + Hairline Borders)',
    enableStats: 'Enable Bottom Stats Bar (Turns/Steps · tok/s · Cache Hit)',
    statsBarItems: 'Bottom Bar Items (status, turns, tokens, context)',
    promptStatsItems: 'Enter bottom bar items, comma-separated (status, turns, tokens, context)',
    apply: '▶ Apply & Inject into Antigravity Desktop',
    clearAll: '✕ Clear All Injected Styles (Restore Default)',
    quit: 'Quit',
    hint: 'Use ↑/↓ to move, Space/Enter to toggle/edit, q to quit',
    promptImg: 'Enter wallpaper image path',
    promptOpacity: 'Enter opacity (0.0 ~ 1.0)',
    warnOpacity: '[warn] Opacity must be a number',
    injecting: '[info] Injecting...',
    applied: (n) => `[ok] Applied config to ${n} window(s)`,
    clearedAll: (n) => `[ok] Cleared all injected styles from ${n} window(s)`,
    bar: {
      waiting: 'Session Stats: Waiting for chat...',
      disconnected: 'Session Stats: Local server disconnected',
      turns: 'turns',
      steps: 'steps',
      cacheHit: 'Cache',
      openContext: 'Click to open Context panel',
      popTitle: 'Session Stats',
      modelTime: 'Model Time',
      tps: 'Output Speed (TPS)',
      outTok: 'Output Tokens',
      totTok: 'Total Tokens',
      cacheRate: 'Cache Hit Rate',
      ctxUsage: 'Context Usage',
      min: 'm',
      sec: 's',
      liveTitle: 'Live Status',
      phaseIdle: 'Idle',
      phaseWaiting: 'Waiting for model',
      phaseStreaming: 'Streaming',
      phaseTool: 'Running tool',
      phaseMonitor: 'Safety check',
      phaseRetry: 'Retrying',
      phaseError: 'Request error',
      retryAttempt: '#',
      retryIn: 'next retry',
      noCapacity: '503 No capacity',
    },
  },
};

function t(cfg) {
  return I18N[cfg?.lang === 'en' ? 'en' : 'zh'];
}

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

function getCdpPort(cfg) {
  return normalizePort(cfg?.cdpPort, DEFAULT_CDP_PORT);
}

function getCdpUrl(cfgOrPort) {
  const port =
    typeof cfgOrPort === 'number'
      ? normalizePort(cfgOrPort, DEFAULT_CDP_PORT)
      : getCdpPort(cfgOrPort);
  return `http://127.0.0.1:${port}`;
}

async function getTargets(cdpPort = DEFAULT_CDP_PORT) {
  try {
    const res = await fetch(`${getCdpUrl(cdpPort)}/json`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function launchAntigravity(cdpPort = DEFAULT_CDP_PORT) {
  const platform = os.platform();
  const port = normalizePort(cdpPort, DEFAULT_CDP_PORT);
  const args = [`--remote-debugging-port=${port}`];

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

// 通过 CDP /json/version 的 User-Agent 获取宿主 Antigravity 版本号
async function getHostVersion(cdpPort = DEFAULT_CDP_PORT) {
  try {
    const res = await fetch(`${getCdpUrl(cdpPort)}/json/version`, { signal: AbortSignal.timeout(2000) });
    const j = await res.json();
    const m = String(j['User-Agent'] || '').match(/Antigravity\/([\d.]+)/);
    return { version: m ? m[1] : null, chrome: j.Browser || null };
  } catch {
    return null;
  }
}

async function ensureCDPReady(logFn = console.log, launch = true, cdpPort = DEFAULT_CDP_PORT) {
  const port = normalizePort(cdpPort, DEFAULT_CDP_PORT);
  let targets = await getTargets(port);
  if (targets) return targets;
  if (!launch) {
    throw new Error(`未检测到 CDP 端口 ${port}，请以 --remote-debugging-port=${port} 启动 Antigravity`);
  }

  logFn(`[info] 未检测到 CDP 端口 ${port}，正在启动 Antigravity Desktop...`);
  launchAntigravity(port);

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    targets = await getTargets(port);
    if (targets && targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('data:'))) {
      return targets;
    }
  }

  throw new Error(
    `等待 CDP 端口 ${port} 超时。如果 Antigravity 已在运行，请先完全退出后再运行本脚本。`
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
          if (msg.error) reject(new Error(msg.error.message || 'CDP 错误'));
          else if (msg.result && msg.result.exceptionDetails) {
            reject(new Error('注入脚本异常: ' + (msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text || '')));
          } else resolve(msg.result);
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

let activeStatsPort = null;
let statsServerPromise = null;

const TOKEN_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'qol-stats-token');
let cachedToken = null;
function getStatsToken() {
  if (cachedToken) return cachedToken;
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (t.length >= 32) return (cachedToken = t);
  } catch {
    // generate below
  }
  const t = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, t, { mode: 0o600 });
  } catch {
    // 无法持久化则仅本进程有效
  }
  return (cachedToken = t);
}

function getLanguageServerLogPath() {
  const home = os.homedir();
  const candidates =
    process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Logs', 'Antigravity', 'language_server.log')]
      : process.platform === 'win32'
        ? [
            path.join(process.env.APPDATA || '', 'Antigravity', 'logs', 'language_server.log'),
            path.join(process.env.LOCALAPPDATA || '', 'Antigravity', 'logs', 'language_server.log'),
          ]
        : [
            path.join(home, '.config', 'Antigravity', 'logs', 'language_server.log'),
            path.join(home, '.local', 'state', 'Antigravity', 'logs', 'language_server.log'),
          ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function readLogTail(filePath, maxBytes = 24576) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size === 0) return '';
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function parseGlogTimestamp(line) {
  // e.g. I1119 12:01:59.123456
  const m = line.match(/[IWEF](\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return null;
  const now = new Date();
  const dt = new Date(
    now.getFullYear(),
    Number(m[1]) - 1,
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    m[6] ? Number(m[6].slice(0, 3)) : 0
  );
  return dt.getTime();
}

function inspectLanguageServerLog(sinceMs) {
  const logPath = getLanguageServerLogPath();
  if (!logPath) return null;
  const tail = readLogTail(logPath, 24576);
  if (!tail) return null;

  const lines = tail.split('\n').filter(Boolean);
  const cutoff = Math.max(0, (sinceMs || Date.now()) - 15000);
  const recentEvents = [];
  let retryInfo = null;
  let activeMonitor = null;
  let requestSent = false;
  let lastTraceUrl = '';

  for (const raw of lines) {
    if (raw.includes('csrf_interceptor.go')) continue;
    const ts = parseGlogTimestamp(raw);
    if (ts && ts < cutoff) continue;

    // 1. Run retry / API failure
    const retryMatch = raw.match(
      /Run:\s*attempt\s+(\d+)\s+failed\s+\((.+?)\)(?:,\s*retrying in\s+([0-9.]+[a-z0-9]+))?/i
    );
    if (retryMatch) {
      const errText = retryMatch[2];
      const codeMatch = errText.match(/code\s+(\d{3})/i);
      retryInfo = {
        attempt: Number(retryMatch[1]),
        error: errText,
        code: codeMatch ? codeMatch[1] : '',
        noCapacity: /no capacity/i.test(errText),
        retryIn: retryMatch[3] || '',
        ts: ts || Date.now(),
      };
    }

    // 2. LLM safety monitor start / finish
    const monStart = raw.match(/LLM Monitor\s+(\S+?):\s+(Starting evaluation|Calling LLM)/);
    if (monStart) {
      activeMonitor = monStart[1];
    }
    const monDone = raw.match(/Monitor\s+(\S+)\s+FINISHED:/);
    if (monDone && activeMonitor === monDone[1]) {
      activeMonitor = null;
    }

    // 3. Stream request reached server
    const urlMatch = raw.match(/URL:\s+(https:\/\/\S+streamGenerateContent\S*)/);
    if (urlMatch && (!sinceMs || !ts || ts >= sinceMs - 2000)) {
      requestSent = true;
      lastTraceUrl = urlMatch[1];
      // 若发出了新的 stream 请求且晚于上一次 retry，仍保留 retryInfo 直到产生新 step
    }

    // 收集精简后的有意义日志
    if (
      raw.includes('run.go:') ||
      raw.includes('http_helpers.go:') ||
      raw.includes('llm_monitor.go:') ||
      raw.includes('runner.go:') ||
      raw.includes('SEND_USER_CASCADE_MESSAGE')
    ) {
      const clean = raw.replace(/^.*?\]\s*/, '').slice(0, 140);
      recentEvents.push(clean);
    }
  }

  return {
    retryInfo,
    activeMonitor,
    requestSent,
    lastTraceUrl,
    recentLogs: recentEvents.slice(-3),
  };
}

const transcriptCache = new Map();

function newTranscriptState() {
  return {
    offset: 0, turns: 0, steps: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0,
    lastContextTokens: 0, lastModel: '', modelMs: 0, pendingTs: null, pendingOut: 0, tpsOut: 0, tpsMs: 0, lastStep: null,
  };
}

// 按字节偏移增量解析 transcript.jsonl：只处理新增的完整行
function readTranscriptIncremental(convId, logPath) {
  let size;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return null;
  }
  let st = transcriptCache.get(convId);
  if (!st || size < st.offset) {
    st = newTranscriptState();
    transcriptCache.set(convId, st);
    if (transcriptCache.size > 50) transcriptCache.delete(transcriptCache.keys().next().value);
  }
  if (size > st.offset) {
    const fd = fs.openSync(logPath, 'r');
    let buf;
    try {
      buf = Buffer.alloc(size - st.offset);
      fs.readSync(fd, buf, 0, buf.length, st.offset);
    } finally {
      fs.closeSync(fd);
    }
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl >= 0) {
      const text = buf.subarray(0, lastNl + 1).toString('utf8');
      st.offset += lastNl + 1;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type !== 'SYSTEM_MESSAGE') st.lastStep = obj;
          const t = obj.created_at ? Date.parse(obj.created_at) : null;
          if (obj.type === 'USER_INPUT') {
            st.turns++;
          } else if (obj.type === 'PLANNER_RESPONSE') {
            st.steps++;
            if (obj.model) st.lastModel = String(obj.model);
            const stepIn = Number(obj.input_tokens || 0);
            const stepCache = Number(obj.cache_read_tokens || 0);
            const stepOut = Number(obj.output_tokens || 0);
            st.inputTokens += stepIn;
            st.cacheReadTokens += stepCache;
            st.outputTokens += stepOut;
            st.lastContextTokens = stepIn + stepCache + stepOut;
          }
          // PLANNER_RESPONSE 的 created_at 是该步开始时间; 紧随其后的工具步骤 (GENERIC) 在生成结束时创建，
          // 因此 (工具步骤时间 - 本步时间) 即纯生成耗时，不含工具执行时间。
          // 没有工具调用的最终回复，下一条是用户输入，间隔包含用户思考时间，无法测量，直接跳过。
          if (t && st.pendingTs && (t > st.pendingTs || obj.type !== 'GENERIC')) {
            if (obj.type === 'GENERIC' && t > st.pendingTs) {
              const dt = t - st.pendingTs;
              if (dt < 120000) {
                st.modelMs += dt;
                if (st.pendingOut >= 100) {
                  st.tpsOut += st.pendingOut;
                  st.tpsMs += dt;
                }
              }
            }
            st.pendingTs = null;
          }
          if (t && obj.type === 'PLANNER_RESPONSE' && Number(obj.output_tokens || 0) > 0 && Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
            st.pendingTs = t;
            st.pendingOut = Number(obj.output_tokens || 0);
          }
        } catch {
          // ignore malformed line
        }
      }
    }
  }
  return st;
}

// ---- 最小 protobuf 解码 + .db 上下文上限读取 (结果按 mtime/size 缓存) ----
function decodeProto(bytes) {
  const out = new Map();
  let o = 0;
  const varint = () => {
    let v = 0n;
    for (let sh = 0n; sh < 70n; sh += 7n) {
      if (o >= bytes.length) throw new Error('eof');
      const b = bytes[o++];
      v |= BigInt(b & 127) << sh;
      if (b < 128) return Number(v);
    }
    throw new Error('varint');
  };
  while (o < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (!field) break;
    if (wire === 0) {
      (out.get(field) || out.set(field, []).get(field)).push(varint());
    } else if (wire === 2) {
      const len = varint();
      if (len > bytes.length - o) break;
      (out.get(field) || out.set(field, []).get(field)).push(bytes.subarray(o, o + len));
      o += len;
    } else if (wire === 1) o += 8;
    else if (wire === 5) o += 4;
    else break;
  }
  return out;
}

// 已验证过 protobuf 字段路径的宿主版本 (major.minor)
const KNOWN_PROTO_VERSIONS = ['2.33'];
let hostVersionCache = { version: null, at: 0 };

function refreshHostVersion() {
  if (Date.now() - hostVersionCache.at < 60000) return;
  hostVersionCache.at = Date.now();
  getHostVersion().then((h) => {
    if (h?.version) hostVersionCache.version = h.version;
  }).catch(() => {});
}

function isKnownProtoVersion() {
  const v = hostVersionCache.version;
  return Boolean(v) && KNOWN_PROTO_VERSIONS.includes(v.split('.').slice(0, 2).join('.'));
}

const dbLimitCache = new Map();
const dbTimingCache = new Map();

function getDbFingerprint(dbPath) {
  try {
    const a = fs.statSync(dbPath);
    let w = { mtimeMs: 0, size: 0 };
    try { w = fs.statSync(dbPath + '-wal'); } catch { /* no wal */ }
    return `${a.mtimeMs}:${a.size}:${w.mtimeMs}:${w.size}`;
  } catch {
    return null;
  }
}

function decodeProtoTimestamp(bytes) {
  if (!(bytes instanceof Uint8Array)) return 0;
  const d = decodeProto(bytes);
  const sec = d.get(1)?.[0];
  const nano = d.get(2)?.[0] || 0;
  return typeof sec === 'number' && sec > 1700000000 ? sec + nano / 1e9 : 0;
}

// 从 .db 的 steps.metadata 读取精确流式耗时:
// f1=请求开始, f6=首token时间(TTFT结束), f7=生成完成, f9.f3=output_tokens
function readDbTimingStats(convId) {
  const dbPath = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations', `${convId}.db`);
  const fp = getDbFingerprint(dbPath);
  if (!fp || !nodeSqlite) return null;
  const hit = dbTimingCache.get(convId);
  if (hit && hit.fp === fp) return hit.val;

  let val = null;
  let db;
  try {
    db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT metadata FROM steps WHERE step_type = 15 AND status = 3').all();
    let validSteps = 0;
    let modelSecTotal = 0;
    let tpsOut = 0;
    let tpsSec = 0;
    for (const row of rows) {
      if (!(row?.metadata instanceof Uint8Array)) continue;
      const d = decodeProto(row.metadata);
      const t1 = decodeProtoTimestamp(d.get(1)?.[0]);
      const t6 = decodeProtoTimestamp(d.get(6)?.[0]);
      const t7 = decodeProtoTimestamp(d.get(7)?.[0]);
      const f9 = d.get(9)?.[0];
      const out = f9 instanceof Uint8Array ? (decodeProto(f9).get(3)?.[0] || 0) : 0;
      if (!t1 || !t7 || t7 <= t1 || (t7 - t1) >= 600 || out <= 0 || out >= 1000000) continue;
      validSteps++;
      modelSecTotal += (t7 - t1);
      if (t6 >= t1 && t7 > t6 && (t7 - t6) >= 0.5 && out >= 100) {
        tpsOut += out;
        tpsSec += (t7 - t6);
      }
    }
    if (validSteps > 0) {
      val = {
        hasData: true,
        tps: tpsSec > 0 ? Math.round(tpsOut / tpsSec) : 0,
        modelMs: Math.round(modelSecTotal * 1000),
      };
    }
  } catch {
    // 数据库被锁或结构变化: 回退到 transcript 估算
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  dbTimingCache.set(convId, { fp, val });
  if (dbTimingCache.size > 100) dbTimingCache.delete(dbTimingCache.keys().next().value);
  return val;
}

function readDbMaxTokenLimit(convId) {
  refreshHostVersion();
  // 版本匹配: 直接采信; 版本未知/不匹配: 尝试读取，但值必须在合理范围内，否则放弃
  const known = isKnownProtoVersion();
  const dbPath = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations', `${convId}.db`);
  const fp = getDbFingerprint(dbPath);
  if (!fp) return 0;
  const hit = dbLimitCache.get(convId);
  if (hit && hit.fp === fp && hit.known === known) return hit.limit;
  let limit = 0;
  let db;
  try {
    if (!nodeSqlite) return 0;
    db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT data FROM executor_metadata ORDER BY rowid DESC LIMIT 1').get();
    if (row && row.data instanceof Uint8Array) {
      // 路径: 根字段 10 -> 嵌套字段 2 -> varint 字段 5 (与官方 context 插件一致)
      const f10 = decodeProto(row.data).get(10)?.[0];
      const f2 = f10 instanceof Uint8Array ? decodeProto(f10).get(2)?.[0] : null;
      const v = f2 instanceof Uint8Array ? decodeProto(f2).get(5)?.[0] : 0;
      if (typeof v === 'number' && v > 0 && (known || (v >= 32768 && v <= 20000000))) limit = v;
    }
  } catch {
    // 数据库被锁或结构变化: 回退到推断值
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  dbLimitCache.set(convId, { fp, limit, known });
  if (dbLimitCache.size > 100) dbLimitCache.delete(dbLimitCache.keys().next().value);
  return limit;
}

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

  const st = readTranscriptIncremental(convId, logPath);
  if (!st) return null;
  const { turns, steps, inputTokens, cacheReadTokens, outputTokens, lastContextTokens, lastModel, modelMs, lastStep, tpsOut, tpsMs } = st;

  // 解析实时 Working 内部状态 (transcript 尾部 + language_server.log)
  let live = { phase: 'idle', elapsedSec: 0, model: lastModel, tools: [], detail: '', recentLogs: [] };
  if (lastStep) {
    const stepTs = lastStep.created_at ? Date.parse(lastStep.created_at) : Date.now();
    const elapsedSec = Math.max(0, Math.round((Date.now() - stepTs) / 1000));
    const isToolCall =
      lastStep.type === 'PLANNER_RESPONSE' &&
      Array.isArray(lastStep.tool_calls) &&
      lastStep.tool_calls.length > 0;
    const isCancelled = lastStep.status === 'CANCELLED' || lastStep.status === 'CANCELED';
    const isWorking =
      !isCancelled &&
      (isToolCall ||
        lastStep.type === 'USER_INPUT' ||
        lastStep.type === 'GENERIC' ||
        lastStep.type === 'ERROR_MESSAGE');

    if (isWorking) {
      const ls = inspectLanguageServerLog(stepTs);
      const recentLogs = ls?.recentLogs || [];

      if (lastStep.type === 'ERROR_MESSAGE') {
        const errStr = String(lastStep.error || '');
        const att = errStr.match(/attempt\s+(\d+)/i);
        const code = errStr.match(/code\s+(\d{3})/i);
        live = {
          phase: ls?.retryInfo ? 'retry' : 'error',
          elapsedSec,
          model: lastModel,
          tools: [],
          attempt: ls?.retryInfo?.attempt || (att ? Number(att[1]) : 0),
          retryIn: ls?.retryInfo?.retryIn || '',
          code: ls?.retryInfo?.code || (code ? code[1] : ''),
          noCapacity: ls?.retryInfo?.noCapacity || /no capacity/i.test(errStr),
          detail: ls?.retryInfo?.error || errStr.slice(0, 140),
          recentLogs,
        };
      } else if (isToolCall) {
        const tools = lastStep.tool_calls.map((tc) => tc.name).filter(Boolean);
        live = {
          phase: ls?.activeMonitor ? 'monitor' : 'tool',
          elapsedSec,
          model: lastModel,
          tools,
          detail: ls?.activeMonitor || tools.join(', '),
          recentLogs,
        };
      } else if (ls?.retryInfo && ls.retryInfo.ts >= stepTs - 2000) {
        live = {
          phase: 'retry',
          elapsedSec,
          model: lastModel,
          tools: [],
          attempt: ls.retryInfo.attempt,
          retryIn: ls.retryInfo.retryIn,
          code: ls.retryInfo.code,
          noCapacity: ls.retryInfo.noCapacity,
          detail: ls.retryInfo.error,
          recentLogs,
        };
      } else if (ls?.activeMonitor) {
        live = {
          phase: 'monitor',
          elapsedSec,
          model: lastModel,
          tools: [],
          detail: ls.activeMonitor,
          recentLogs,
        };
      } else {
        live = {
          phase: ls?.requestSent ? 'streaming' : 'waiting',
          elapsedSec,
          model: lastModel,
          tools: [],
          detail: '',
          recentLogs,
        };
      }
    }
  }

  // 与官方 context 插件一致: .db 会话里没有明文 max_token_limit，按模型推断 Antigravity 的默认上限
  const maxContext = inferContextLimit(lastModel, convId);
  const dbTiming = readDbTimingStats(convId);
  const totalTokens = inputTokens + cacheReadTokens + outputTokens;
  const promptTokens = inputTokens + cacheReadTokens;
  const cacheHitRate = promptTokens > 0 ? Math.round((cacheReadTokens / promptTokens) * 100) : 0;
  const tps = dbTiming?.hasData ? dbTiming.tps : (tpsMs > 0 ? Math.round(tpsOut / (tpsMs / 1000)) : 0);
  const effectiveModelMs = dbTiming?.hasData ? dbTiming.modelMs : modelMs;
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
    modelSeconds: Math.round(effectiveModelMs / 1000),
    lastContextTokens,
    maxContext,
    hasAgyContext,
    live,
  };
}

function inferContextLimit(model, convId) {
  const dbLimit = readDbMaxTokenLimit(convId);
  if (dbLimit > 0) return dbLimit;
  // 旧版 .pbtxt 会话仍可直接读取
  try {
    const pbtxtPath = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations', `${convId}.pbtxt`);
    if (fs.existsSync(pbtxtPath)) {
      const m = fs.readFileSync(pbtxtPath, 'utf8').slice(0, 65536).match(/max_token_limit:\s*(\d+)/);
      if (m && Number(m[1]) > 0) return Number(m[1]);
    }
  } catch {
    // fall through
  }
  const id = String(model || '').toLowerCase().replace(/\s+/g, '-');
  if (id.includes('orchestrator')) return 512000;
  let modelMax = 1048576;
  if (/gpt-oss-120b/.test(id)) modelMax = 131072;
  else if (/claude-(sonnet|opus|haiku)-4-5|claude-(sonnet|opus)-4(-|$)/.test(id)) modelMax = 200000;
  return Math.min(modelMax, 256000);
}

function ensureStatsServer() {
  if (activeStatsPort !== null) return Promise.resolve(activeStatsPort);
  if (statsServerPromise) return statsServerPromise;

  statsServerPromise = new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const url = new URL(req.url, `http://127.0.0.1:${activeStatsPort || PREFERRED_STATS_PORT}`);
      if (req.method === 'GET' && url.pathname === '/stats') {
        getStatsToken();
        if (url.searchParams.get('t') !== getStatsToken()) {
          res.statusCode = 403;
          res.end('{}');
          return;
        }
        const id = url.searchParams.get('id') || '';
        const data = computeConversationStats(id);
        res.end(JSON.stringify(data || { turns: 0, steps: 0, totalTokens: 0, outputTokens: 0, cacheHitRate: 0, tps: 0 }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });

    let triedFallback = false;
    const onListening = () => {
      server.off('error', onStartupError);
      server.on('error', (err) => {
        console.error('[warn] 统计服务错误:', err && err.message);
      });
      const addr = server.address();
      activeStatsPort = typeof addr === 'object' && addr ? addr.port : PREFERRED_STATS_PORT;
      resolve(activeStatsPort);
    };

    const onStartupError = (err) => {
      if (err && err.code === 'EADDRINUSE' && !triedFallback) {
        triedFallback = true;
        console.error(`[info] 统计端口 ${PREFERRED_STATS_PORT} 已被占用，正在分配随机可用端口...`);
        server.listen(0, '127.0.0.1');
        return;
      }
      statsServerPromise = null;
      console.error('[warn] 统计服务错误:', err && err.message);
      reject(err);
    };

    server.once('listening', onListening);
    server.on('error', onStartupError);
    const initialPort =
      Number.isInteger(PREFERRED_STATS_PORT) && PREFERRED_STATS_PORT >= 0 && PREFERRED_STATS_PORT <= 65535
        ? PREFERRED_STATS_PORT
        : 9223;
    server.listen(initialPort, '127.0.0.1');
  });

  return statsServerPromise;
}

function normalizeStatsBarItems(items) {
  const valid = new Set(['status', 'turns', 'tokens', 'context']);
  if (!Array.isArray(items)) return [...DEFAULT_CONFIG.statsBarItems];
  const filtered = items.map((s) => String(s).trim().toLowerCase()).filter((s) => valid.has(s));
  return [...new Set(filtered)];
}

function buildStatsBarInjectJS(
  lang = 'zh',
  clickTarget = '',
  statsBarItems = DEFAULT_CONFIG.statsBarItems,
  statsPort = activeStatsPort || PREFERRED_STATS_PORT
) {
  const L = JSON.stringify(I18N[lang === 'en' ? 'en' : 'zh'].bar);
  const CLICK_TARGET = JSON.stringify(String(clickTarget || '').trim());
  const ITEMS = JSON.stringify(normalizeStatsBarItems(statsBarItems));
  return `(() => {
    const L = ${L};
    const CLICK_TARGET = ${CLICK_TARGET};
    const ITEMS = ${ITEMS};
    if (window.__agyStatsTimer) clearInterval(window.__agyStatsTimer);
    const old = document.getElementById('agy-stats-bar');
    if (old) old.remove();

    const formatTok = (n) => {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return Math.round(n / 1000) + 'K';
      return String(n);
    };

    const formatDuration = (sec) => {
      if (!sec) return '0 ' + L.sec;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m > 0 ? m + ' ' + L.min + ' ' + s + ' ' + L.sec : s + ' ' + L.sec;
    };

    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const formatLiveBadge = (live) => {
      if (!live || live.phase === 'idle') {
        return {
          color: 'var(--muted-foreground, light-dark(#64748b, rgba(255,255,255,0.52)))',
          dot: 'light-dark(rgba(10,10,12,0.32), rgba(255,255,255,0.32))',
          barText: L.phaseIdle,
          popText: L.phaseIdle,
          detail: '',
          idle: true,
        };
      }
      const el = live.elapsedSec != null ? ' · ' + live.elapsedSec + 's' : '';
      if (live.phase === 'retry' || live.phase === 'error') {
        const barLabel = live.noCapacity ? L.noCapacity : (live.phase === 'retry' ? L.phaseRetry : L.phaseError);
        const tag = live.noCapacity ? L.noCapacity : (live.code ? 'HTTP ' + live.code : L.phaseError);
        const att = live.attempt ? ' #' + live.attempt : '';
        const wait = live.retryIn ? ' (' + live.retryIn + ' ' + L.retryIn + ')' : '';
        return {
          color: 'light-dark(#dc2626, #f87171)',
          dot: 'light-dark(#dc2626, #f87171)',
          barText: barLabel,
          popText: tag + att + wait,
          detail: live.detail || '',
          idle: false,
        };
      }
      if (live.phase === 'monitor') {
        return {
          color: 'light-dark(#7c3aed, #c084fc)',
          dot: 'light-dark(#7c3aed, #c084fc)',
          barText: L.phaseMonitor,
          popText: L.phaseMonitor + el,
          detail: live.detail || '',
          idle: false,
        };
      }
      if (live.phase === 'tool') {
        return {
          color: 'light-dark(#b45309, #fbbf24)',
          dot: 'light-dark(#b45309, #fbbf24)',
          barText: L.phaseTool,
          popText: L.phaseTool + el,
          detail: (live.tools || []).join(', '),
          idle: false,
        };
      }
      if (live.phase === 'streaming') {
        return {
          color: 'light-dark(#059669, #34d399)',
          dot: 'light-dark(#059669, #34d399)',
          barText: L.phaseStreaming,
          popText: L.phaseStreaming + el,
          detail: '',
          idle: false,
        };
      }
      return {
        color: 'light-dark(#2563eb, #60a5fa)',
        dot: 'light-dark(#2563eb, #60a5fa)',
        barText: L.phaseWaiting,
        popText: L.phaseWaiting + el,
        detail: '',
        idle: false,
      };
    };

    const ensureBar = () => {
      const composer = document.querySelector('.surface-composer');
      if (!composer || !composer.parentElement) return null;
      let bar = document.getElementById('agy-stats-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'agy-stats-bar';
        bar.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:12px;padding:6px 10px 2px;font-size:12px;color:var(--muted-foreground,light-dark(#52525b,rgba(255,255,255,0.62)));user-select:none;font-family:system-ui,-apple-system,sans-serif;cursor:default;';

        const popWrap = document.createElement('div');
        popWrap.id = 'agy-stats-popover-wrap';
        popWrap.style.cssText = 'display:none;position:absolute;bottom:100%;left:50%;transform:translateX(-50%);padding-bottom:10px;z-index:100000;pointer-events:auto;';

        const pop = document.createElement('div');
        pop.id = 'agy-stats-popover';
        pop.style.cssText = 'width:280px;padding:12px 14px;border-radius:12px;background:var(--card,light-dark(rgba(255,255,255,0.96),rgba(28,28,34,0.96)));border:1px solid var(--card-border,light-dark(rgba(10,10,12,0.12),rgba(255,255,255,0.12)));box-shadow:light-dark(0 8px 28px rgba(10,10,12,0.12),0 8px 28px rgba(0,0,0,0.45));backdrop-filter:blur(12px);color:var(--foreground,light-dark(#0a0a0c,rgba(255,255,255,0.88)));font-size:12px;user-select:text;cursor:auto;';
        popWrap.appendChild(pop);
        bar.appendChild(popWrap);

        let hideTimer = null;
        const showPop = () => {
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
          popWrap.style.display = 'block';
        };
        const scheduleHide = () => {
          if (hideTimer) clearTimeout(hideTimer);
          hideTimer = setTimeout(() => { popWrap.style.display = 'none'; }, 250);
        };
        bar.addEventListener('mouseenter', showPop);
        bar.addEventListener('mouseleave', scheduleHide);
        popWrap.addEventListener('mouseenter', showPop);
        popWrap.addEventListener('mouseleave', scheduleHide);

        composer.parentElement.appendChild(bar);
      }
      return bar;
    };

    const ensureSummary = (bar) => {
      let summary = document.getElementById('agy-stats-summary');
      if (!summary) {
        summary = document.createElement('div');
        summary.id = 'agy-stats-summary';
        summary.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;justify-content:center;gap:12px;';
        bar.appendChild(summary);
      }
      return summary;
    };

    const refresh = async () => {
      const bar = ensureBar();
      if (!bar) return;
      const m = location.pathname.match(/\\/c\\/([a-zA-Z0-9_-]+)/);
      if (!m) {
        ensureSummary(bar).textContent = L.waiting;
        return;
      }
      try {
        const res = await fetch('http://127.0.0.1:${statsPort}/stats?t=${getStatsToken()}&id=' + m[1]);
        const d = await res.json();
        const pct = d.contextPct ?? 0;
        const r = 5;
        const c = 2 * Math.PI * r;
        const offset = c - (pct / 100) * c;
        const ringSvg =
          '<svg width="14" height="14" viewBox="0 0 14 14" style="transform:rotate(-90deg);flex-shrink:0;">' +
          '<circle cx="7" cy="7" r="' + r + '" fill="none" stroke="light-dark(rgba(10,10,12,0.16), rgba(255,255,255,0.18))" stroke-width="2"/>' +
          '<circle cx="7" cy="7" r="' + r + '" fill="none" stroke="light-dark(rgba(10,10,12,0.72), rgba(255,255,255,0.78))" stroke-width="2" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '" stroke-linecap="round"/>' +
          '</svg>';
        const gaugeSvg =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.85;">' +
          '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>';
        const dbSvg =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.85;">' +
          '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>';
        const liveBadge = formatLiveBadge(d.live);
        const pop = document.getElementById('agy-stats-popover');
        if (pop) {
          const row = (k, v) =>
            '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;">' +
            '<span style="color:var(--muted-foreground,light-dark(#52525b,rgba(255,255,255,0.62)));">' + k + '</span>' +
            '<span style="font-variant-numeric:tabular-nums;">' + v + '</span></div>';
          let liveHtml = '';
          if (liveBadge) {
            const isErr = d.live && (d.live.phase === 'retry' || d.live.phase === 'error');
            const detailText = liveBadge.detail || '';
            const detailColor = isErr ? 'light-dark(#dc2626,rgba(248,113,113,0.9))' : 'var(--muted-foreground,light-dark(#52525b,rgba(255,255,255,0.65)))';
            const detailLine = detailText
              ? '<div style="margin-top:5px;font-size:11px;line-height:1.4;color:' + detailColor + ';word-break:break-word;">' + esc(detailText) + '</div>'
              : '';
            liveHtml =
              '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border,light-dark(rgba(10,10,12,0.1),rgba(255,255,255,0.1)));">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
              '<span style="color:var(--muted-foreground,light-dark(#52525b,rgba(255,255,255,0.62)));flex-shrink:0;">' + L.liveTitle + '</span>' +
              '<span style="color:' + liveBadge.color + ';font-weight:500;text-align:right;">' + esc(liveBadge.popText) + '</span></div>' +
              detailLine + '</div>';
          }
          const nextPopHtml =
            '<div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:8px;margin-bottom:6px;border-bottom:1px solid var(--border,light-dark(rgba(10,10,12,0.1),rgba(255,255,255,0.1)));font-weight:600;">' +
            '<span style="display:inline-flex;align-items:center;gap:6px;">' + gaugeSvg + L.popTitle + '</span><span>' + d.turns + ' ' + L.turns + ' ' + d.steps + ' ' + L.steps + '</span></div>' +
            row(L.modelTime, formatDuration(d.modelSeconds)) +
            row(L.tps, (d.tps || '--') + ' tok/s') +
            row(L.outTok, formatTok(d.outputTokens)) +
            row(L.totTok, formatTok(d.totalTokens)) +
            row(L.cacheRate, d.cacheHitRate + '%') +
            row(L.ctxUsage, formatTok(d.lastContextTokens || 0) + ' / ' + formatTok(d.maxContext || 512000) + ' (' + pct + '%)') +
            liveHtml;
          if (pop.dataset.lastHtml !== nextPopHtml) {
            pop.dataset.lastHtml = nextPopHtml;
            pop.innerHTML = nextPopHtml;
          }
        }
        const summary = ensureSummary(bar);
        const liveSpan =
          '<span style="display:inline-flex;align-items:center;gap:6px;color:' + liveBadge.color + ';font-weight:' + (liveBadge.idle ? '400' : '500') + ';">' +
          '<span style="width:6px;height:6px;border-radius:50%;background:' + liveBadge.dot + ';display:inline-block;"></span>' +
          esc(liveBadge.barText) + '</span>';
        const partMap = {
          status: liveSpan,
          turns: '<span style="display:inline-flex;align-items:center;gap:5px;">' + gaugeSvg + d.turns + ' ' + L.turns + ' ' + d.steps + ' ' + L.steps + ' · ' + (d.tps || '--') + ' tok/s</span>',
          tokens: '<span style="display:inline-flex;align-items:center;gap:5px;">' + dbSvg + formatTok(d.totalTokens) + ' tok · ' + L.cacheHit + ' ' + d.cacheHitRate + '%</span>',
          context: '<span id="agy-context-trigger" style="display:inline-flex;align-items:center;gap:5px;">' + ringSvg + pct + '%</span>',
        };
        const sep = '<span style="opacity:0.35">|</span>';
        summary.style.cursor = CLICK_TARGET ? 'pointer' : 'default';
        summary.title = CLICK_TARGET || '';
        summary.innerHTML = ITEMS.map((k) => partMap[k]).filter(Boolean).join(sep);
        summary.onclick = CLICK_TARGET
          ? () => {
              if (/^https?:\\/\\//i.test(CLICK_TARGET)) {
                window.open(CLICK_TARGET, '_blank');
                return;
              }
              const u = new URL(location.href);
              u.searchParams.set('tab', CLICK_TARGET);
              history.pushState({}, '', u.toString());
              window.dispatchEvent(new PopStateEvent('popstate'));
            }
          : null;
      } catch {
        ensureSummary(bar).textContent = L.disconnected;
      }
    };

    refresh();
    window.__agyStatsTimer = setInterval(refresh, 1000);
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

const WIN_MEDIA_MODAL_CSS =
  os.platform() === 'win32'
    ? `
  [data-testid="media-modal-header"] {
    padding-top: calc(env(titlebar-area-height, 32px) + 8px) !important;
    padding-bottom: 8px !important;
    padding-right: 16px !important;
    height: auto !important;
  }
`
    : '';

const CLEAN_INPUT_CSS = `
  *, *::before, *::after {
    box-shadow: none !important;
  }
  :focus-visible:not([contenteditable], textarea, input, [role="textbox"]) {
    outline: 2px solid light-dark(rgba(10, 10, 12, 0.55), rgba(255, 255, 255, 0.6)) !important;
    outline-offset: 1px !important;
  }
  .surface-composer,
  .agy-user-bubble,
  [role="dialog"],
  [role="menu"],
  [data-radix-popper-content-wrapper] > * {
    border: 1px solid light-dark(rgba(10, 10, 12, 0.12), rgba(255, 255, 255, 0.14)) !important;
  }
  [data-slot="toggle-group"] > button[data-pressed],
  .agy-sidebar-row[data-selected="true"] {
    box-shadow: inset 0 0 0 1px light-dark(rgba(10, 10, 12, 0.09), rgba(255, 255, 255, 0.09)) !important;
  }
  [data-main-content-body]::after,
  [data-side-panel-body]::after,
  [data-hoisted-slot-rim="side"],
  [data-tiling-pane]::after,
  [data-testid="bottom-terminal-panel"]::after {
    box-shadow: inset 0 0 0 0.5px var(--card-edge, light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.10))) !important;
  }
  [role="switch"] > span {
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.08) !important;
  }
  ${WIN_MEDIA_MODAL_CSS}
`;

function buildEscCancelInjectJS(lang = 'zh') {
  const hintText = JSON.stringify(lang === 'en' ? 'Press ESC again to cancel' : '再按一次 ESC 取消对话');
  return `(() => {
    if (window.__agyEscCancelHandler) {
      window.removeEventListener('keydown', window.__agyEscCancelHandler, true);
    }
    if (window.__agyEscToastTimer) {
      clearTimeout(window.__agyEscToastTimer);
      window.__agyEscToastTimer = null;
    }
    const oldToast = document.getElementById('agy-esc-toast');
    if (oldToast) oldToast.remove();

    const HINT_TEXT = ${hintText};
    let armedUntil = 0;

    const hideToast = () => {
      armedUntil = 0;
      if (window.__agyEscToastTimer) {
        clearTimeout(window.__agyEscToastTimer);
        window.__agyEscToastTimer = null;
      }
      const el = document.getElementById('agy-esc-toast');
      if (el) {
        el.style.opacity = '0';
        el.style.transform = 'translate(-50%, -46%) scale(0.97)';
      }
    };

    const showToast = (composer) => {
      let el = document.getElementById('agy-esc-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'agy-esc-toast';
        el.style.cssText =
          'position:fixed;z-index:100001;pointer-events:none;padding:9px 16px;border-radius:999px;' +
          'background:var(--card,light-dark(rgba(255,255,255,0.94),rgba(24,24,30,0.92)));border:1px solid var(--card-border,light-dark(rgba(10,10,12,0.14),rgba(255,255,255,0.14)));' +
          'box-shadow:light-dark(0 8px 28px rgba(10,10,12,0.12),0 8px 28px rgba(0,0,0,0.45));backdrop-filter:blur(12px);' +
          'color:var(--foreground,light-dark(#0a0a0c,rgba(255,255,255,0.92)));font-size:13px;font-weight:500;letter-spacing:0.01em;' +
          'font-family:system-ui,-apple-system,sans-serif;white-space:nowrap;' +
          'opacity:0;transform:translate(-50%,-46%) scale(0.97);transition:opacity 0.16s ease,transform 0.16s ease;';
        document.body.appendChild(el);
      }
      const r = composer.getBoundingClientRect();
      el.style.left = Math.round(r.left + r.width / 2) + 'px';
      el.style.top = Math.round(r.top / 2) + 'px';
      el.textContent = HINT_TEXT;
      requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translate(-50%, -50%) scale(1)';
      });
      if (window.__agyEscToastTimer) clearTimeout(window.__agyEscToastTimer);
      window.__agyEscToastTimer = setTimeout(hideToast, 2000);
    };

    window.__agyEscCancelHandler = (e) => {
      if (e.key !== 'Escape' || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const blocking = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')].some((el) => {
        if ((el.getAttribute('aria-label') || '').startsWith('Typeahead')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      });
      if (blocking) return;
      const composer = document.querySelector('.surface-composer');
      if (!composer) return;
      const btn = composer.querySelector('button[data-tooltip-id="input-send-button-cancel-tooltip"]') ||
        [...composer.querySelectorAll('button')].find((b) => /cancel|stop|取消|停止/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-tooltip-id') || '')));
      if (!btn || btn.disabled) {
        hideToast();
        return;
      }
      e.preventDefault();
      const now = Date.now();
      if (now < armedUntil) {
        hideToast();
        btn.click();
      } else {
        armedUntil = now + 2000;
        showToast(composer);
      }
    };
    window.addEventListener('keydown', window.__agyEscCancelHandler, true);
    return 'esc-ok';
  })()`;
}

function buildEscCancelRemoveJS() {
  return `(() => {
    if (window.__agyEscCancelHandler) {
      window.removeEventListener('keydown', window.__agyEscCancelHandler, true);
      window.__agyEscCancelHandler = null;
    }
    if (window.__agyEscToastTimer) {
      clearTimeout(window.__agyEscToastTimer);
      window.__agyEscToastTimer = null;
    }
    const toast = document.getElementById('agy-esc-toast');
    if (toast) toast.remove();
    return 'esc-removed';
  })()`;
}

async function resolveWallpaperBgUrl(imagePath) {
  const raw = String(imagePath || '').trim();
  if (!raw) throw new Error('已启用注入背景，但未设置图片路径或 URL');

  if (raw.startsWith('data:image/')) {
    return raw;
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const res = await fetch(raw, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
      const mime = ct.startsWith('image/') ? ct : (MIME_MAP[path.extname(new URL(raw).pathname).toLowerCase()] || 'image/png');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片过大');
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
      // 网络拉取失败时回退为直接 URL 引用
      return raw;
    }
  }

  const imgPath = path.resolve(raw);
  if (!fs.existsSync(imgPath)) {
    throw new Error(`找不到图片文件: ${imgPath}`);
  }
  const ext = path.extname(imgPath).toLowerCase();
  if (!MIME_MAP[ext]) throw new Error(`不支持的图片类型: ${ext || '(无扩展名)'}`);
  if (fs.statSync(imgPath).size > MAX_IMAGE_BYTES) throw new Error('图片过大 (上限 10MB)');
  const mime = MIME_MAP[ext];
  const base64 = fs.readFileSync(imgPath).toString('base64');
  return `data:${mime};base64,${base64}`;
}

async function applyConfig(cfg, logFn = console.log, opts = {}) {
  const parts = [];

  if (cfg.enableWallpaper) {
    const bgUrl = await resolveWallpaperBgUrl(cfg.imagePath);
    const opacity = Math.min(1, Math.max(0, Number(cfg.opacity ?? 0.12)));

    const wpCss = `
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        z-index: 99999;
        pointer-events: none;
        background-image: url(${JSON.stringify(bgUrl)});
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
    const statsPort = await ensureStatsServer();
    parts.push(buildStatsBarInjectJS(cfg.lang, cfg.statsClickTarget, cfg.statsBarItems, statsPort));
  } else {
    parts.push(buildStatsBarRemoveJS());
  }

  if (cfg.enableEscCancel) {
    parts.push(buildEscCancelInjectJS(cfg.lang));
  } else {
    parts.push(buildEscCancelRemoveJS());
  }

  const expression = parts.join('; ');
  const targets = await ensureCDPReady(logFn, opts.launch !== false, getCdpPort(cfg));
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
  const host = await getHostVersion(getCdpPort(cfg));
  const hostLabel = host?.version ? `Antigravity ${host.version}` : 'Antigravity (CDP offline)';
  let cursor = 0;
  let statusMsg = t(cfg).hint;

  const getItems = () => {
    const tr = t(cfg);
    return [
      {
        key: 'lang',
        label: tr.langLabel,
        action: () => {
          cfg.lang = cfg.lang === 'en' ? 'zh' : 'en';
          saveConfig(cfg);
          statusMsg = t(cfg).hint;
        },
      },
      {
        key: 'toggleWallpaper',
        label: `[${cfg.enableWallpaper ? 'x' : ' '}] ${tr.enableWallpaper}`,
        action: () => {
          cfg.enableWallpaper = !cfg.enableWallpaper;
          saveConfig(cfg);
        },
      },
      {
        key: 'imagePath',
        label: `    ${tr.imagePath}: ${cfg.imagePath || tr.unset}`,
        needInput: true,
        action: async () => {
          const val = await promptText(tr.promptImg, cfg.imagePath);
          cfg.imagePath = val;
          saveConfig(cfg);
        },
      },
      {
        key: 'opacity',
        label: `    ${tr.opacity}:   ${cfg.opacity}`,
        needInput: true,
        action: async () => {
          const val = await promptText(tr.promptOpacity, String(cfg.opacity));
          const num = Number(val);
          if (!Number.isNaN(num)) {
            cfg.opacity = Math.min(1, Math.max(0, num));
            saveConfig(cfg);
          } else {
            statusMsg = tr.warnOpacity;
          }
        },
      },
      {
        key: 'toggleInput',
        label: `[${cfg.enableInputStyle ? 'x' : ' '}] ${tr.enableFlat}`,
        action: () => {
          cfg.enableInputStyle = !cfg.enableInputStyle;
          saveConfig(cfg);
        },
      },
      {
        key: 'toggleStatsBar',
        label: `[${cfg.enableStatsBar ? 'x' : ' '}] ${tr.enableStats}`,
        action: () => {
          cfg.enableStatsBar = !cfg.enableStatsBar;
          saveConfig(cfg);
        },
      },
      {
        key: 'statsBarItems',
        label: `    ${tr.statsBarItems}: ${normalizeStatsBarItems(cfg.statsBarItems).join(', ')}`,
        needInput: true,
        action: async () => {
          const cur = normalizeStatsBarItems(cfg.statsBarItems).join(', ');
          const val = await promptText(tr.promptStatsItems, cur);
          cfg.statsBarItems = normalizeStatsBarItems(val.split(','));
          saveConfig(cfg);
        },
      },
      {
        key: 'apply',
        label: tr.apply,
        action: async () => {
          statusMsg = tr.injecting;
          render();
          try {
            const count = await applyConfig(cfg, (m) => {
              statusMsg = m;
              render();
            });
            saveConfig(cfg);
            statusMsg = tr.applied(count);
          } catch (err) {
            statusMsg = `[error] ${err.message || err}`;
          }
        },
      },
      {
        key: 'clearAll',
        label: tr.clearAll,
        action: async () => {
          try {
            const count = await applyConfig(
              { ...cfg, enableWallpaper: false, enableInputStyle: false, enableStatsBar: false, enableEscCancel: false },
              (m) => {
                statusMsg = m;
                render();
              }
            );
            statusMsg = tr.clearedAll(count);
          } catch (err) {
            statusMsg = `[error] ${err.message || err}`;
          }
        },
      },
      {
        key: 'quit',
        label: tr.quit,
        action: () => {
          process.stdout.write('\x1b[?25h\n');
          process.exit(0);
        },
      },
    ];
  };

  function render() {
    const tr = t(cfg);
    const items = getItems();
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(`\x1b[1;36m${tr.title}\x1b[0m`);
    console.log(`${hostLabel}  |  ${tr.cdpPort}: ${getCdpPort(cfg)}  |  ${tr.configFile}: ${CONFIG_PATH}\n`);

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

export function startWatchLoop(intervalMs = 3000) {
  ensureStatsServer().catch((err) => {
    console.error('[warn] 统计服务启动失败:', err && err.message);
  });

  const tick = async () => {
    try {
      const currentCfg = loadConfig();
      if (
        !currentCfg.enableWallpaper &&
        !currentCfg.enableInputStyle &&
        !currentCfg.enableStatsBar &&
        !currentCfg.enableEscCancel
      ) {
        return;
      }
      const targets = await getTargets(getCdpPort(currentCfg));
      if (!targets) return;
      const pages = targets.filter(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('data:')
      );
      for (const page of pages) {
        const check = await evalOverCDP(
          page.webSocketDebuggerUrl,
          `(${currentCfg.enableWallpaper ? '!document.getElementById(' + JSON.stringify(WALLPAPER_STYLE_ID) + ')' : 'false'}) || (${currentCfg.enableInputStyle ? '!document.getElementById(' + JSON.stringify(UI_STYLE_ID) + ')' : 'false'}) || (${currentCfg.enableStatsBar ? '!window.__agyStatsTimer' : 'false'}) || (${currentCfg.enableEscCancel ? '!window.__agyEscCancelHandler' : 'false'})`
        );
        if (check && check.result && check.result.value === true) {
          await applyConfig(currentCfg, () => {}, { launch: false });
          break;
        }
      }
    } catch {
      // CDP 未就绪或页面切换中，下个周期重试
    }
  };

  tick();
  return setInterval(tick, intervalMs);
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

  startWatchLoop(3000);
}

export { getHostVersion, loadConfig, saveConfig, applyConfig, ensureStatsServer, normalizePort, getCdpPort };

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
  if (arg1 === '--apply') {
    const count = await applyConfig(cfg, () => {});
    console.log(JSON.stringify({ ok: true, count }));
    return;
  }

  if (arg1 === '--clear') {
    cfg.enableWallpaper = false;
    cfg.enableInputStyle = true;
    const count = await applyConfig(cfg);
    console.log(`[ok] 已清除壁纸（保留输入框样式改善），共 ${count} 个窗口`);
    return;
  }

  if (arg1 === '--clear-all') {
    const count = await applyConfig({ ...cfg, enableWallpaper: false, enableInputStyle: false, enableStatsBar: false, enableEscCancel: false });
    console.log(`[ok] 已清除所有注入样式，共 ${count} 个窗口`);
    return;
  }

  cfg.enableWallpaper = true;
  if (arg1.startsWith('-')) {
    console.error(`[error] 未知参数: ${arg1}\n用法: --apply | --clear | --clear-all | --watch | <图片路径或URL> [透明度]`);
    process.exit(1);
  }
  cfg.imagePath = /^(https?:\/\/|data:image\/)/i.test(arg1) ? arg1 : path.resolve(arg1);
  if (process.argv[3] !== undefined) {
    cfg.opacity = Math.min(1, Math.max(0, Number(process.argv[3])));
  }
  saveConfig(cfg);
  const count = await applyConfig(cfg);
  console.log(`[ok] 已注入壁纸到 ${count} 个窗口`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((err) => {
    console.error('[error]', err.message || err);
    process.exit(1);
  });
}
