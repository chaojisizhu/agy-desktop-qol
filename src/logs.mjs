import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getLanguageServerLogPath() {
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

export function readLogTail(filePath, maxBytes = 24576) {
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
      const raw = buf.toString('utf8');
      if (start > 0) {
        const firstNl = raw.indexOf('\n');
        return firstNl >= 0 ? raw.slice(firstNl + 1) : '';
      }
      return raw;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function parseGlogTimestamp(line, now = new Date()) {
  // e.g. I1119 12:01:59.123456
  const m = String(line || '').match(/[IWEF](\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return null;
  const month = Number(m[1]) - 1;
  const day = Number(m[2]);
  const hour = Number(m[3]);
  const minute = Number(m[4]);
  const second = Number(m[5]);
  const ms = m[6] ? Number(m[6].padEnd(3, '0').slice(0, 3)) : 0;

  let year = now.getFullYear();
  let dt = new Date(year, month, day, hour, minute, second, ms);
  // 跨年边界修复: 1月1日读到12月31日的日志时年份减 1
  if (dt.getTime() > now.getTime() + 86400000) {
    year -= 1;
    dt = new Date(year, month, day, hour, minute, second, ms);
  }
  return dt.getTime();
}

export function inspectLanguageServerLogText(tail, sinceMs, nowMs = Date.now()) {
  if (!tail) return null;

  const lines = tail.split('\n').filter(Boolean);
  const nowDate = new Date(nowMs);
  const cutoff = Math.max(0, (sinceMs || nowMs) - 15000);
  let retryInfo = null;
  const activeMonitors = new Map();
  let requestSent = false;
  let requestSentTs = 0;

  for (const raw of lines) {
    if (raw.includes('csrf_interceptor.go')) continue;
    const ts = parseGlogTimestamp(raw, nowDate);
    if (ts && ts < cutoff) continue;
    const eventTs = ts || nowMs;

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
        ts: eventTs,
      };
    }

    // 2. LLM safety monitor start / finish
    const monStart = raw.match(/LLM Monitor\s+(\S+?):\s+(Starting evaluation|Calling LLM)/);
    if (monStart) {
      activeMonitors.set(monStart[1], eventTs);
    }
    const monDone = raw.match(/Monitor\s+(\S+)\s+FINISHED:/);
    if (monDone) {
      activeMonitors.delete(monDone[1]);
    }

    // 3. Stream request reached server
    const urlMatch = raw.match(/URL:\s+(https:\/\/\S+streamGenerateContent\S*)/);
    if (urlMatch && (!sinceMs || !ts || ts >= sinceMs - 2000)) {
      requestSent = true;
      requestSentTs = eventTs;
      // 如果新的流式请求在 retry 之后发出，说明重试已发出新请求，清除过期的 retry 状态
      if (retryInfo && eventTs > retryInfo.ts) {
        retryInfo = null;
      }
    }
  }

  let activeMonitor = null;
  for (const [name, startTs] of activeMonitors.entries()) {
    if (nowMs - startTs <= 60000) {
      activeMonitor = name;
    }
  }

  return {
    retryInfo,
    activeMonitor,
    requestSent,
    requestSentTs,
  };
}

export function inspectLanguageServerLog(sinceMs, opts = {}) {
  const logPath = opts.logPath || getLanguageServerLogPath();
  if (!logPath) return null;
  const tail = readLogTail(logPath, 24576);
  if (!tail) return null;
  return inspectLanguageServerLogText(tail, sinceMs, opts.nowMs || Date.now());
}
