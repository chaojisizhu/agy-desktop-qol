import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DEFAULT_CDP_PORT, getCdpPort, normalizePort, sleep, t } from './config.mjs';

export function getCdpUrl(cfgOrPort) {
  const port =
    typeof cfgOrPort === 'number'
      ? normalizePort(cfgOrPort, DEFAULT_CDP_PORT)
      : getCdpPort(cfgOrPort);
  return `http://127.0.0.1:${port}`;
}

export function isInjectablePage(target) {
  if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  const url = String(target.url || '');
  if (
    url.startsWith('data:') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome-devtools://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('chrome://')
  ) {
    return false;
  }
  return true;
}

export async function getTargets(cdpPort = DEFAULT_CDP_PORT) {
  try {
    const res = await fetch(`${getCdpUrl(cdpPort)}/json`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function launchAntigravity(cdpPort = DEFAULT_CDP_PORT) {
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

export async function getHostVersion(cdpPort = DEFAULT_CDP_PORT) {
  try {
    const res = await fetch(`${getCdpUrl(cdpPort)}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const m = String(j['User-Agent'] || '').match(/Antigravity\/([\d.]+)/);
    return { version: m ? m[1] : null, chrome: j.Browser || null };
  } catch {
    return null;
  }
}

export async function ensureCDPReady(
  logFn = console.log,
  launch = true,
  cdpPort = DEFAULT_CDP_PORT,
  lang = 'zh'
) {
  const port = normalizePort(cdpPort, DEFAULT_CDP_PORT);
  const tr = t({ lang });
  let targets = await getTargets(port);
  if (targets) return targets;
  if (!launch) {
    throw new Error(tr.errNoCdp(port));
  }

  logFn(
    lang === 'en'
      ? `[info] CDP port ${port} not detected, launching Antigravity Desktop...`
      : `[info] 未检测到 CDP 端口 ${port}，正在启动 Antigravity Desktop...`
  );
  launchAntigravity(port);

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    targets = await getTargets(port);
    if (targets && targets.some(isInjectablePage)) {
      return targets;
    }
  }

  throw new Error(tr.errCdpLaunchTimeout(port));
}

export function evalOverCDP(wsUrl, expression, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore close error
      }
      fn(val);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error('CDP WebSocket timeout'));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true },
          })
        );
      } catch (err) {
        finish(reject, err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === 1) {
          if (msg.error) {
            finish(reject, new Error(msg.error.message || 'CDP error'));
          } else if (msg.result && msg.result.exceptionDetails) {
            const detail =
              msg.result.exceptionDetails.exception?.description ||
              msg.result.exceptionDetails.text ||
              '';
            finish(reject, new Error('Injected script exception: ' + detail));
          } else {
            finish(resolve, msg.result);
          }
        }
      } catch {
        // ignore unrelated frame
      }
    });

    ws.addEventListener('error', (ev) => {
      const msg = ev?.error?.message || ev?.message || 'CDP WebSocket connection failed';
      finish(reject, new Error(msg));
    });

    ws.addEventListener('close', () => {
      if (!settled) {
        finish(reject, new Error('CDP WebSocket closed before response'));
      }
    });
  });
}
