'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');
const LOG_PATH = path.join(ROOT, 'sign_log.json');
const CREDITS_PATH = path.join(ROOT, 'credits.json');
const MAX_LOGS = 300;

function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function defaultConfig() {
  return readJson(EXAMPLE_PATH, {
    host: '192.168.1.10',
    port: 8787,
    auto: { enable: true, hour: 10, minute: 1, catchupHour: 11, catchupMinute: 0 },
    platforms: {
      qoder: { enable: true, accessToken: '' }
    }
  });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = defaultConfig();
    writeJson(CONFIG_PATH, cfg);
    return cfg;
  }
  const cfg = readJson(CONFIG_PATH, defaultConfig());
  const base = defaultConfig();
  cfg.auto = Object.assign({}, base.auto, cfg.auto || {});
  cfg.platforms = cfg.platforms || {};
  for (const name of Object.keys(base.platforms)) {
    cfg.platforms[name] = Object.assign({}, base.platforms[name], cfg.platforms[name] || {});
  }
  return cfg;
}

function saveConfig(cfg) {
  writeJson(CONFIG_PATH, cfg);
  return cfg;
}

function loadLogs() {
  const logs = readJson(LOG_PATH, []);
  return Array.isArray(logs) ? logs : [];
}

function appendLog(entry) {
  const logs = loadLogs();
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  writeJson(LOG_PATH, logs);
  return entry;
}

function todaySuccess(platform) {
  const today = todayCN();
  return loadLogs().some(l => l.platform === platform && l.date === today && l.success === true);
}

function maskToken(s) {
  if (!s) return '';
  s = String(s);
  if (s.length <= 12) return '********';
  return s.slice(0, 6) + '...' + s.slice(-4);
}

function loadCredits() {
  return readJson(CREDITS_PATH, null);
}

function saveCredits(data) {
  writeJson(CREDITS_PATH, data);
  return data;
}

function publicConfig(cfg) {
  const platforms = {};
  for (const [name, p] of Object.entries(cfg.platforms || {})) {
    platforms[name] = {
      enable: p.enable !== false,
      configured: !!(p.accessToken && String(p.accessToken).trim()),
      accessToken: maskToken(p.accessToken),
      deviceId: p.deviceId || '',
      userId: p.userId || '',
      host: p.host || '',
      userRegion: p.userRegion || '',
      uid: p.uid || ''
    };
  }
  return {
    host: cfg.host || '192.168.1.10',
    port: cfg.port || 8787,
    auto: cfg.auto,
    tokenSource: cfg.tokenSource || '',
    tokenMessage: cfg.tokenMessage || '',
    tokenExpiresAt: Number(cfg.tokenExpiresAt || 0),
    platforms
  };
}

module.exports = {
  todayCN,
  loadConfig,
  saveConfig,
  loadLogs,
  appendLog,
  todaySuccess,
  loadCredits,
  saveCredits,
  publicConfig,
  CONFIG_PATH
};
