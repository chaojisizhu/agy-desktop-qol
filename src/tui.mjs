import readline from 'node:readline';
import {
  getCdpPort,
  getConfigPath,
  loadConfig,
  normalizePort,
  normalizeStatsBarItems,
  saveConfig,
  t,
} from './config.mjs';
import { getHostVersion } from './cdp.mjs';
import { applyConfig } from './inject.mjs';

async function promptText(question, defaultValue = '', currentLabel = '当前', allowClear = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` (${currentLabel}: ${defaultValue})` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim().replace(/^['"]|['"]$/g, '');
      if (allowClear && trimmed === '-') {
        resolve('');
        return;
      }
      resolve(trimmed || defaultValue);
    });
  });
}

export async function runTUI() {
  let cfg = loadConfig();
  let host = await getHostVersion(getCdpPort(cfg));
  const getHostLabel = () =>
    host?.version ? `Antigravity ${host.version}` : 'Antigravity (CDP offline)';
  let cursor = 0;
  let statusMsg = t(cfg).hint;
  let busy = false;

  const restoreTerminal = () => {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      // ignore
    }
    process.stdout.write('\x1b[?25h\n');
  };

  const getItems = () => {
    const tr = t(cfg);
    return [
      {
        key: 'lang',
        label: tr.langLabel,
        action: () => {
          cfg.lang = cfg.lang === 'en' ? 'zh' : 'en';
          cfg = saveConfig(cfg);
          statusMsg = t(cfg).hint;
        },
      },
      {
        key: 'cdpPort',
        label: `    ${tr.cdpPort}: ${getCdpPort(cfg)}`,
        needInput: true,
        action: async () => {
          const val = await promptText(
            tr.promptCdpPort,
            String(getCdpPort(cfg)),
            tr.currentValue
          );
          const port = normalizePort(val, null);
          if (port !== null) {
            cfg.cdpPort = port;
            cfg = saveConfig(cfg);
            host = await getHostVersion(port);
          } else {
            statusMsg = tr.warnPort;
          }
        },
      },
      {
        key: 'toggleWallpaper',
        label: `[${cfg.enableWallpaper ? 'x' : ' '}] ${tr.enableWallpaper}`,
        action: () => {
          cfg.enableWallpaper = !cfg.enableWallpaper;
          cfg = saveConfig(cfg);
        },
      },
      {
        key: 'imagePath',
        label: `    ${tr.imagePath}: ${cfg.imagePath || tr.unset}`,
        needInput: true,
        action: async () => {
          const val = await promptText(
            tr.promptImg,
            cfg.imagePath,
            tr.currentValue,
            true
          );
          cfg.imagePath = val;
          cfg = saveConfig(cfg);
        },
      },
      {
        key: 'opacity',
        label: `    ${tr.opacity}:   ${cfg.opacity}`,
        needInput: true,
        action: async () => {
          const val = await promptText(
            tr.promptOpacity,
            String(cfg.opacity),
            tr.currentValue
          );
          const num = Number(val);
          if (Number.isFinite(num) && num >= 0 && num <= 1) {
            cfg.opacity = Number(num.toFixed(4));
            cfg = saveConfig(cfg);
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
          cfg = saveConfig(cfg);
        },
      },
      {
        key: 'toggleEscCancel',
        label: `[${cfg.enableEscCancel ? 'x' : ' '}] ${tr.enableEscCancel}`,
        action: () => {
          cfg.enableEscCancel = !cfg.enableEscCancel;
          cfg = saveConfig(cfg);
        },
      },
      {
        key: 'toggleStatsBar',
        label: `[${cfg.enableStatsBar ? 'x' : ' '}] ${tr.enableStats}`,
        action: () => {
          cfg.enableStatsBar = !cfg.enableStatsBar;
          cfg = saveConfig(cfg);
        },
      },
      {
        key: 'statsClickTarget',
        label: `    ${tr.statsClickTarget}: ${cfg.statsClickTarget || tr.unset}`,
        needInput: true,
        action: async () => {
          const val = await promptText(
            tr.promptClickTarget,
            cfg.statsClickTarget,
            tr.currentValue,
            true
          );
          cfg.statsClickTarget = val;
          cfg = saveConfig(cfg);
        },
      },
      {
        key: 'statsBarItems',
        label: `    ${tr.statsBarItems}: ${normalizeStatsBarItems(cfg.statsBarItems).join(', ')}`,
        needInput: true,
        action: async () => {
          const cur = normalizeStatsBarItems(cfg.statsBarItems).join(', ');
          const val = await promptText(tr.promptStatsItems, cur, tr.currentValue);
          cfg.statsBarItems = normalizeStatsBarItems(val.split(','));
          cfg = saveConfig(cfg);
        },
      },
      {
        key: 'apply',
        label: tr.apply,
        action: async () => {
          statusMsg = tr.injecting;
          render();
          try {
            const count = await applyConfig(
              cfg,
              (m) => {
                statusMsg = m;
                render();
              },
              { startStatsServer: false }
            );
            cfg = saveConfig(cfg);
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
          statusMsg = tr.injecting;
          render();
          try {
            cfg = saveConfig({
              ...cfg,
              enableWallpaper: false,
              enableInputStyle: false,
              enableStatsBar: false,
              enableEscCancel: false,
            });
            const count = await applyConfig(
              cfg,
              (m) => {
                statusMsg = m;
                render();
              },
              { startStatsServer: false }
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
          restoreTerminal();
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
    console.log(
      `${getHostLabel()}  |  ${tr.cdpPort}: ${getCdpPort(cfg)}  |  ${tr.configFile}: ${getConfigPath()}\n`
    );

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
    if (!key || busy) return;
    const items = getItems();

    if ((key.ctrl && key.name === 'c') || key.name === 'q') {
      restoreTerminal();
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
      busy = true;
      try {
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
      } finally {
        busy = false;
      }
      render();
    }
  };

  process.stdin.on('keypress', onKeypress);
}
