'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./lib/store');
const { runAll, fetchCredits } = require('./lib/checkin');
const { WsHub } = require('./lib/ws');
const { readQoderToken, exchangePatToken, readPat } = require('./lib/local-token');

// 手机要访问的是局域网 IP，写死会在换网络后失效；没给 DAKA_HOST 时自动挑本机局域网 IPv4。
function detectLanIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal
        && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return '127.0.0.1';
}

const HOST = process.env.DAKA_HOST || detectLanIp();
const PORT = Number(process.env.PORT || 8787);
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const hub = new WsHub();
const liveLogs = [];
const MAX_LIVE = 200;
let running = false;
let creditsRunning = false;
let lastRun = null;
let lastAutoDate = '';
let lastCatchupDate = '';

function nowText() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function pushLog(msg, extra) {
  const item = Object.assign({
    t: Date.now(),
    time: nowText(),
    msg: String(msg)
  }, extra || {});
  liveLogs.push(item);
  if (liveLogs.length > MAX_LIVE) liveLogs.shift();
  hub.broadcast({ type: 'log', item });
  console.log(`[${item.time}] ${item.msg}`);
}

function phoneUrl() {
  return `http://${HOST}:${PORT}`;
}

function snapshot() {
  const cfg = store.loadConfig();
  return {
    type: 'state',
    running,
    creditsRunning,
    lastRun,
    today: store.todayCN(),
    clients: hub.count(),
    phoneUrl: phoneUrl(),
    auto: cfg.auto,
    config: store.publicConfig(cfg),
    credits: store.loadCredits(),
    logs: store.loadLogs().slice(0, 40),
    live: liveLogs.slice(-80)
  };
}

function applyToken(got, cfg) {
  if (!cfg.platforms.qoder) cfg.platforms.qoder = { enable: true };
  cfg.platforms.qoder.accessToken = got.accessToken;
  cfg.platforms.qoder.enable = true;
  cfg.tokenSource = got.source || 'local-qoder';
  cfg.tokenMessage = got.message || '已获取 token';
  cfg.tokenExpiresAt = Number(got.expiresAt || 0);
  store.saveConfig(cfg);
  pushLog('已获取 Qoder token（来源: ' + cfg.tokenSource + '），无需手动填写');
  return true;
}

// PAT 换来的 job token 实测只有 24h。服务不重启的话第二天就是过期 token，
// 所以每次干活前先看到期时间，提前 1 小时用 pat.txt 重换一次。
async function refreshPatToken() {
  const cfg = store.loadConfig();
  if (cfg.tokenSource !== 'qoder-pat') return;
  const exp = Number(cfg.tokenExpiresAt || 0);
  if (exp && Date.now() < exp - 3600 * 1000) return;
  const pat = readPat();
  if (!pat) return;
  pushLog('PAT token 已到期或临近到期，重新换取…');
  try {
    const ex = await exchangePatToken(pat);
    if (ex.ok) {
      applyToken({ accessToken: ex.accessToken, expiresAt: ex.expiresAt, source: 'qoder-pat' }, cfg);
    } else {
      pushLog('PAT 重新换取失败: ' + (ex.message || '未知原因'));
    }
  } catch (e) {
    pushLog('PAT 重新换取异常: ' + e.message);
  }
}

async function loadLocalToken() {
  const cfg = store.loadConfig();
  cfg.host = HOST;
  cfg.port = PORT;

  // 来源一/二：本机 Qoder CN（CLI 或 IDE 登录态）
  const got = readQoderToken();
  if (got.ok) return applyToken(got, cfg);

  // 来源三：个人访问令牌 PAT → 换取短时 token
  const pat = readPat();
  if (pat) {
    pushLog('本机未读到 Qoder 登录态，尝试用个人访问令牌(PAT)换取…');
    try {
      const ex = await exchangePatToken(pat);
      if (ex.ok) return applyToken({ accessToken: ex.accessToken, expiresAt: ex.expiresAt, source: 'qoder-pat' }, cfg);
      cfg.tokenSource = 'none';
      cfg.tokenMessage = ex.message || 'PAT 换取失败';
      store.saveConfig(cfg);
      pushLog('PAT 换取失败: ' + cfg.tokenMessage);
      pushLog('若令牌过期或无效，请到 qoder.com.cn 控制台「个人访问令牌」重新生成，更新 pat.txt');
      return false;
    } catch (e) {
      pushLog('PAT 换取异常: ' + e.message);
    }
  }

  cfg.tokenSource = 'none';
  cfg.tokenMessage = got.message || '未能自动读取 token';
  store.saveConfig(cfg);
  pushLog('读取 token 失败: ' + cfg.tokenMessage);
  pushLog('可在本机登录 Qoder CN，或把个人访问令牌写入 daka/pat.txt 后重启');
  return false;
}

function persistResults(results, trigger) {
  const date = store.todayCN();
  const entries = [];
  for (const [platform, r] of Object.entries(results || {})) {
    const entry = {
      platform,
      success: !!(r && r.success),
      message: (r && r.message) || '',
      alreadyCheckedIn: !!(r && r.alreadyCheckedIn),
      credentialInvalid: !!(r && r.credentialInvalid),
      credit: r && (r.credit || r.points) || 0,
      trigger: trigger || 'manual',
      created_at: Date.now(),
      date
    };
    store.appendLog(entry);
    entries.push(entry);
  }
  lastRun = { date, trigger: trigger || 'manual', at: Date.now(), results };
  return entries;
}

async function doCheckin(names, trigger) {
  if (running) return { ok: false, message: '正在签到中,请稍候' };
  running = true;
  hub.broadcast({ type: 'running', running: true });
  pushLog(`开始签到 (${trigger || 'manual'}) ${names && names.length ? names.join(',') : '全部平台'}`);
  try {
    await refreshPatToken();
    const cfg = store.loadConfig();
    const results = await runAll(
      cfg.platforms,
      names && names.length ? names : ['qoder'],
      msg => pushLog(msg),
      { skipIdempotent: trigger === 'auto' || trigger === 'catchup' }
    );
    persistResults(results, trigger);
    hub.broadcast(snapshot());
    return { ok: true, results };
  } catch (e) {
    pushLog('签到异常: ' + e.message);
    return { ok: false, message: e.message };
  } finally {
    running = false;
    hub.broadcast({ type: 'running', running: false });
    hub.broadcast(snapshot());
  }
}

async function doCredits() {
  if (creditsRunning) return { ok: false, message: '正在查询余额,请稍候' };
  await refreshPatToken();
  const cfg = store.loadConfig();
  const q = cfg.platforms && cfg.platforms.qoder;
  if (!q || !q.accessToken) return { ok: false, message: '未配置 Qoder 凭证' };
  creditsRunning = true;
  hub.broadcast({ type: 'creditsRunning', running: true });
  pushLog('开始查询 Qoder 余额');
  try {
    const r = await fetchCredits(q, msg => pushLog(msg));
    if (r.ok) {
      store.saveCredits(Object.assign({}, r, { at: Date.now() }));
      pushLog(`[Qoder] 余额 ${r.credits.remain_effective} / ${r.credits.size}（已用 ${r.credits.used}）`);
    } else {
      pushLog('[Qoder] 余额查询失败: ' + r.message);
    }
    hub.broadcast(snapshot());
    return r;
  } catch (e) {
    pushLog('余额查询异常: ' + e.message);
    return { ok: false, message: e.message };
  } finally {
    creditsRunning = false;
    hub.broadcast({ type: 'creditsRunning', running: false });
    hub.broadcast(snapshot());
  }
}

function tickAuto() {
  const cfg = store.loadConfig();
  if (!cfg.auto || cfg.auto.enable === false) return;
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const today = now.toISOString().slice(0, 10);
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const hour = Number(cfg.auto.hour == null ? 10 : cfg.auto.hour);
  const minute = Number(cfg.auto.minute == null ? 1 : cfg.auto.minute);
  const catchupHour = Number(cfg.auto.catchupHour == null ? 11 : cfg.auto.catchupHour);
  const catchupMinute = Number(cfg.auto.catchupMinute == null ? 0 : cfg.auto.catchupMinute);
  if (h === hour && m === minute && lastAutoDate !== today) {
    lastAutoDate = today;
    doCheckin(null, 'auto');
    return;
  }
  if (h === catchupHour && m === catchupMinute && lastCatchupDate !== today) {
    lastCatchupDate = today;
    if (store.todaySuccess('qoder')) {
      pushLog('[补签] 今日 Qoder 已签到,跳过 11:00 补打');
      return;
    }
    pushLog('[补签] 今日尚未打卡,11:00 自动补打');
    doCheckin(['qoder'], 'catchup');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => {
      chunks.push(c);
      if (chunks.reduce((n, x) => n + x.length, 0) > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/status') {
    return sendJson(res, 200, snapshot());
  }

  if (req.method === 'GET' && p === '/api/logs') {
    return sendJson(res, 200, { logs: store.loadLogs() });
  }

  if (req.method === 'POST' && p === '/api/checkin') {
    const body = await readBody(req);
    const names = Array.isArray(body.platforms) ? body.platforms : (body.platform ? [body.platform] : null);
    const result = await doCheckin(names, body.trigger || 'manual');
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST' && p === '/api/credits') {
    const result = await doCredits();
    return sendJson(res, 200, result);
  }

  if (req.method === 'GET' && p === '/api/credits') {
    return sendJson(res, 200, { ok: true, credits: store.loadCredits() });
  }

  if (req.method === 'POST' && p === '/api/config') {
    const body = await readBody(req);
    const cfg = store.loadConfig();
    if (body.auto) {
      cfg.auto = Object.assign({}, cfg.auto, body.auto);
    }
    if (body.platforms) {
      for (const [name, patch] of Object.entries(body.platforms)) {
        if (!cfg.platforms[name]) cfg.platforms[name] = {};
        const cur = cfg.platforms[name];
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'accessToken' && (!v || String(v).includes('...'))) continue;
          cur[k] = v;
        }
      }
    }
    store.saveConfig(cfg);
    hub.broadcast(snapshot());
    return sendJson(res, 200, { ok: true, config: store.publicConfig(cfg) });
  }

  sendJson(res, 404, { ok: false, message: 'not found' });
}

const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api/')) {
    handleApi(req, res).catch(e => sendJson(res, 400, { ok: false, message: e.message }));
    return;
  }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket) => {
  const p = (req.url || '').split('?')[0];
  if (p !== '/ws') {
    socket.destroy();
    return;
  }
  hub.handleUpgrade(req, socket);
});

hub.on('connection', client => {
  hub.send(client, snapshot());
  pushLog(`手机端已连接,当前 ${hub.count()} 个客户端`);
});

hub.on('message', (client, msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ping') {
    hub.send(client, { type: 'pong', t: Date.now() });
    return;
  }
  if (msg.type === 'checkin') {
    const names = Array.isArray(msg.platforms) ? msg.platforms : (msg.platform ? [msg.platform] : ['qoder']);
    doCheckin(names, msg.trigger || 'manual');
  }
  if (msg.type === 'credits') {
    doCredits();
  }
  if (msg.type === 'config') {
    const cfg = store.loadConfig();
    if (msg.auto) cfg.auto = Object.assign({}, cfg.auto, msg.auto);
    store.saveConfig(cfg);
    hub.broadcast(snapshot());
  }
});

store.loadConfig();
loadLocalToken().catch(e => console.error('loadLocalToken error:', e.message));
setInterval(tickAuto, 20 * 1000);
tickAuto();

server.listen(PORT, '0.0.0.0', () => {
  console.log('签到服务已启动');
  console.log('本机: ' + `http://127.0.0.1:${PORT}`);
  console.log('手机请打开: ' + phoneUrl());
  console.log('关闭本窗口 或 Ctrl+C 停止服务');
});
