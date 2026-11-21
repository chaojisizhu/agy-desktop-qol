import {
  STATS_BAR_VERSION,
  UI_STYLE_ID,
  WALLPAPER_STYLE_ID,
  getCdpPort,
  loadConfig,
} from './config.mjs';
import { evalOverCDP, getTargets, isInjectablePage } from './cdp.mjs';
import { applyConfig } from './inject.mjs';
import { ensureStatsServer, getActiveStatsPort } from './stats-server.mjs';

export function buildNeedInjectExpression(cfg, activeStatsPort) {
  const checks = [];
  if (cfg.enableWallpaper && cfg.imagePath) {
    checks.push(`!document.getElementById(${JSON.stringify(WALLPAPER_STYLE_ID)})`);
  }
  if (cfg.enableInputStyle) {
    checks.push(`!document.getElementById(${JSON.stringify(UI_STYLE_ID)})`);
  }
  if (cfg.enableStatsBar) {
    checks.push('!window.__agyStatsTimer');
    checks.push(`window.__agyStatsVersion !== ${STATS_BAR_VERSION}`);
    if (activeStatsPort) {
      checks.push(`window.__agyStatsPort !== ${Number(activeStatsPort)}`);
    }
  }
  if (cfg.enableEscCancel) {
    checks.push('!window.__agyEscCancelHandler');
  }
  return checks.length > 0 ? checks.join(' || ') : 'false';
}

export function startWatchLoop(intervalMs = 3000) {
  ensureStatsServer().catch((err) => {
    console.error('[warn] 统计服务启动失败:', err && err.message);
  });

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const currentCfg = loadConfig();
      const hasEffectiveWallpaper = Boolean(
        currentCfg.enableWallpaper && currentCfg.imagePath
      );
      if (
        !hasEffectiveWallpaper &&
        !currentCfg.enableInputStyle &&
        !currentCfg.enableStatsBar &&
        !currentCfg.enableEscCancel
      ) {
        return;
      }
      const statsPort = currentCfg.enableStatsBar
        ? getActiveStatsPort() || (await ensureStatsServer())
        : null;
      const targets = await getTargets(getCdpPort(currentCfg));
      if (!targets) return;
      const pages = targets.filter(isInjectablePage);
      const checkExpr = buildNeedInjectExpression(currentCfg, statsPort);
      if (checkExpr === 'false') return;

      for (const page of pages) {
        const check = await evalOverCDP(page.webSocketDebuggerUrl, checkExpr);
        if (check && check.result && check.result.value === true) {
          await applyConfig(currentCfg, () => {}, {
            launch: false,
            startStatsServer: true,
            tolerantWallpaper: true,
            statsPort,
          });
          break;
        }
      }
    } catch {
      // CDP 未就绪或页面切换中，下个周期重试
    } finally {
      running = false;
    }
  };

  tick();
  return setInterval(tick, intervalMs);
}
