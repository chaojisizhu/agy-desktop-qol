import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyConfig,
  loadConfig,
  saveConfig,
  startWatchLoop,
} from '../../agy-desktop-qol.mjs';

const fallbackSdk = pathToFileURL(
  path.join(os.homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs')
).href;

const { SidecarApp, Response } = await import('sidecar_sdk').catch(() => import(fallbackSdk));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NO_STORE = { 'Cache-Control': 'no-store' };

// 父进程退出时自动清理自身，避免重启 Antigravity 后残留旧进程占用 9223 端口并覆盖注入
const parentPid = process.ppid;
if (parentPid && parentPid > 1) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 3000).unref();
}

// 在 Sidecar 后台进程内直接托管统计服务 (9223) 与 CDP 自动注入守护
startWatchLoop(3000);

const app = new SidecarApp();

app.page('/', () =>
  new Response(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), {
    contentType: 'text/html; charset=utf-8',
    headers: NO_STORE,
  })
);

app.api(
  '/api/config',
  async () => ({ ...loadConfig(), daemonOnline: true }),
  'GET'
);

app.api(
  '/api/config',
  async (data) => {
    const next = { ...loadConfig(), ...data };
    saveConfig(next);
    try {
      const count = await applyConfig(next, () => {});
      return { ok: true, count, config: next, daemonOnline: true };
    } catch (err) {
      return {
        ok: false,
        config: next,
        daemonOnline: true,
        error: err.message || String(err),
      };
    }
  },
  'POST'
);

app.run();
