const DEFAULT_CONF = {
  baseUrl: 'https://localhost:9998',
  endpoints: {
    challenge: '/api/v1/public/captcha/challenge',
    redeem: '/api/v1/public/captcha/redeem',
    checkin: '/api/v1/users/wallet/checkin',
    wallet: '/api/v1/users/wallet',
  },
  assets: { wasm: '/captcha/cap_wasm_bg.wasm', glue: '/captcha/cap_wasm.js' },
  auth: { header: '', value: '' },
  autoCheckin: { start: '09:00', windowMinutes: 30 },
};

const AUTO_KEY = 'daily-checkin';

let CONF = null;
async function conf() {
  if (CONF) return CONF;
  try {
    const r = await fetch(chrome.runtime.getURL('config.json'));
    const j = await r.json();
    CONF = {
      baseUrl: (j.baseUrl || DEFAULT_CONF.baseUrl).replace(/\/+$/, ''),
      endpoints: Object.assign({}, DEFAULT_CONF.endpoints, j.endpoints || {}),
      assets: Object.assign({}, DEFAULT_CONF.assets, j.assets || {}),
      auth: Object.assign({}, DEFAULT_CONF.auth, j.auth || {}),
      autoCheckin: Object.assign({}, DEFAULT_CONF.autoCheckin, j.autoCheckin || {}),
    };
  } catch (_) {
    CONF = JSON.parse(JSON.stringify(DEFAULT_CONF));
  }
  return CONF;
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
const isAuth = (r) =>
  [400, 401, 403].includes(r.status) ||
  (r.json && (r.json.code === 401 || r.json.code === 403));

async function req(method, path, body) {
  const c = await conf();
  const headers = { Accept: '*/*' };
  if (c.auth && c.auth.header) headers[c.auth.header] = c.auth.value;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(c.baseUrl + path, {
    method,
    credentials: 'include',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

function capHash(str, len) {
  let f = 2166136261;
  for (let k = 0; k < str.length; k++) {
    f ^= str.charCodeAt(k);
    f += (f << 1) + (f << 4) + (f << 7) + (f << 8) + (f << 24);
  }
  let u = f >>> 0;
  let out = '';
  while (out.length < len) {
    u ^= u << 13; u ^= u >>> 17; u ^= u << 5; u >>>= 0;
    out += u.toString(16).padStart(8, '0');
  }
  return out.substring(0, len);
}

let WASM = null;
async function getWasm() {
  if (WASM) return WASM;
  const c = await conf();
  const r = await fetch(c.baseUrl + c.assets.wasm);
  if (!r.ok) throw new Error(`wasm 下载失败 HTTP ${r.status}`);
  const bytes = await r.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {
    wbg: { __wbindgen_init_externref_table: () => {} },
  });
  WASM = instance.exports;
  return WASM;
}

const enc = new TextEncoder();
function solvePow(a, b) {
  const ex = WASM;
  const ba = enc.encode(a);
  const pa = ex.__wbindgen_malloc(ba.length, 1) >>> 0;
  new Uint8Array(ex.memory.buffer).set(ba, pa);
  const bb = enc.encode(b);
  const pb = ex.__wbindgen_malloc(bb.length, 1) >>> 0;
  new Uint8Array(ex.memory.buffer).set(bb, pb);
  return BigInt.asUintN(64, ex.solve_pow(pa, ba.length, pb, bb.length));
}

async function directRun() {
  const c = await conf();
  const lines = [];
  const push = (text, cls) => lines.push({ text, cls: cls || '' });
  const t0 = Date.now();
  let mark = t0;
  const lap = () => { const n = Date.now(); const d = n - mark; mark = n; return d; };

  const w0 = await req('GET', c.endpoints.wallet);
  if (isAuth(w0)) return { fallback: true, status: w0.status };
  const d0 = (w0.json && w0.json.data) || {};
  push(`当前余额 ${fmt(d0.balance)}   日额度 ${fmt(d0.daily_token_balance)}/${fmt(d0.daily_token_limit)}`, 'dim');

  const r1 = await req('POST', c.endpoints.challenge);
  if (isAuth(r1)) return { fallback: true, status: r1.status };
  if (!r1.json || !r1.json.challenge) throw new Error(`challenge 失败 HTTP ${r1.status}`);

  const raw = r1.json.challenge;
  const token = r1.json.token;
  const isArr = Array.isArray(raw);
  const n = isArr ? raw.length : raw.c;
  const s = isArr ? 0 : raw.s;
  const d = isArr ? 0 : raw.d;
  push(`[1/4] challenge  c=${n} s=${s} d=${d}   (${lap()} ms)`);

  await getWasm();
  const pairs = isArr ? raw : Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return [capHash(`${token}${i}`, s), capHash(`${token}${i}d`, d)];
  });
  const solutions = pairs.map(([salt, target]) => Number(solvePow(salt, target)));
  push(`[2/4] 解出 ${n} 题    (${lap()} ms)`);

  const r3 = await req('POST', c.endpoints.redeem, { token, solutions });
  const capToken = r3.json && r3.json.token;
  if (!r3.json || r3.json.success !== true || !capToken) {
    throw new Error(`redeem 失败 HTTP ${r3.status}: ${r3.text.slice(0, 120)}`);
  }
  push(`[3/4] redeem 通过    (${lap()} ms)`, 'ok');

  const r4 = await req('POST', c.endpoints.checkin, { captcha_token: capToken });
  if (isAuth(r4)) return { fallback: true, status: r4.status };
  if (!r4.json || r4.json.code !== 0) {
    throw new Error(`checkin 失败 HTTP ${r4.status}: ${r4.text.slice(0, 120)}`);
  }
  push(`[4/4] checkin ${JSON.stringify(r4.json.data || {})}    (${lap()} ms)`, 'ok');

  const w1 = await req('GET', c.endpoints.wallet);
  const d1 = (w1.json && w1.json.data) || {};
  const diff = typeof d1.balance === 'number' && typeof d0.balance === 'number' ? d1.balance - d0.balance : null;
  const q0 = d0.daily_token_balance, q1 = d1.daily_token_balance;
  const qdiff = typeof q1 === 'number' && typeof q0 === 'number' ? q1 - q0 : null;
  push('');
  push(`余额 ${fmt(d0.balance)} → ${fmt(d1.balance)}${diff === null ? '' : `  (${diff >= 0 ? '+' : ''}${fmt(diff)})`}`,
    diff > 0 ? 'ok' : 'dim');
  push(`日额度 ${fmt(q0)} → ${fmt(q1)}${qdiff === null ? '' : `  (${qdiff >= 0 ? '+' : ''}${fmt(qdiff)})`} / 上限 ${fmt(d1.daily_token_limit)}`, 'dim');
  if (!diff && !qdiff) push('余额与日额度都没变：要么今天已签到（幂等返回 true），要么签到只记账不发放额度。', 'warn');
  push(`直连模式全链路 ${Date.now() - t0} ms`, 'warn');

  return { lines, credited: diff, mode: 'direct', ok: true };
}

async function findSiteTab() {
  const c = await conf();
  const tabs = await chrome.tabs.query({ url: [c.baseUrl + '/*'] });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs[0];
}

function waitComplete(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return resolve(t);
      } catch (e) { return reject(e); }
      if (Date.now() - t0 > timeout) return reject(new Error('页面加载超时'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function pageRun() {
  const c = await conf();
  let tab = await findSiteTab();
  let created = null;
  if (!tab) {
    created = await chrome.tabs.create({ url: c.baseUrl + '/', active: false });
    await waitComplete(created.id);
    tab = created;
  } else if (tab.status !== 'complete') {
    await waitComplete(tab.id).catch(() => {});
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (cfg) => { window.__powConf = cfg; },
    args: [c],
  });

  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    files: ['flow.js'],
  });

  if (created) chrome.tabs.remove(created.id).catch(() => {});
  return Object.assign({ mode: 'page' }, res && res.result);
}

async function executeFlow() {
  try {
    const direct = await directRun();
    if (!direct.fallback) return direct;
    return Object.assign({}, await pageRun(), { switched: direct.status });
  } catch (e) {
    const out = await pageRun();
    return Object.assign({}, out, { note: String((e && e.message) || e) });
  }
}

/* ---------------- 定时任务 ---------------- */
function slotOf(day, auto) {
  const [h, m] = String(auto.start || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
  const base = new Date(day);
  base.setHours(h, m, 0, 0);
  const len = Math.max(1, Number(auto.windowMinutes) || 30) * 60000;
  return [base.getTime(), base.getTime() + len];
}

function nextSlot(auto, now = new Date()) {
  let [s, e] = slotOf(now, auto);
  if (now.getTime() >= s) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    [s, e] = slotOf(tomorrow, auto);
  }
  return s + Math.floor(Math.random() * (e - s));
}

async function scheduleNext(force) {
  const c = await conf();
  const auto = c.autoCheckin || DEFAULT_CONF.autoCheckin;
  const sig = `${auto.start}|${auto.windowMinutes}`;
  const st = await chrome.storage.local.get(['autoEnabled', 'nextRun', 'nextSig']);
  const existing = await chrome.alarms.get(AUTO_KEY);

  if (!st.autoEnabled) {
    await chrome.alarms.clear(AUTO_KEY);
    await chrome.storage.local.set({ nextRun: null, nextSig: sig });
    return null;
  }

  const reusable =
    !force && existing && st.nextSig === sig &&
    typeof st.nextRun === 'number' && st.nextRun > Date.now() + 1000;

  if (reusable) return st.nextRun;

  await chrome.alarms.clear(AUTO_KEY);
  const when = nextSlot(auto);
  await chrome.alarms.create(AUTO_KEY, { when });
  await chrome.storage.local.set({ nextRun: when, nextSig: sig });
  return when;
}

async function runAuto() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const { lastRun } = await chrome.storage.local.get('lastRun');
  if (lastRun && lastRun.date === today && lastRun.ok) return;

  const data = await executeFlow();
  const ok = !!(data && data.ok === true && !data.needAuth);
  await chrome.storage.local.set({
    lastRun: {
      date: today,
      at: Date.now(),
      ok,
      mode: data && data.mode,
      needAuth: !!(data && data.needAuth),
      credited: data && typeof data.credited === 'number' ? data.credited : null,
      summary: data && data.lines ? data.lines.map((l) => l.text).join(' | ') : '',
    },
  });

  try {
    await chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
    await chrome.action.setBadgeBackgroundColor({ color: ok ? '#3fb950' : '#f85149' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 60000);
  } catch (_) {}
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== AUTO_KEY) return;
  runAuto().finally(() => scheduleNext(true));
});

chrome.runtime.onInstalled.addListener(() => scheduleNext(true));
chrome.runtime.onStartup.addListener(() => scheduleNext(false));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'RUN') {
    executeFlow().then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'AUTO_GET') {
    (async () => {
      await scheduleNext(false);
      const st = await chrome.storage.local.get(['autoEnabled', 'nextRun', 'lastRun']);
      sendResponse({ ok: true, data: st });
    })();
    return true;
  }

  if (msg.type === 'AUTO_SET') {
    chrome.storage.local.set({ autoEnabled: !!msg.enabled }).then(async () => {
      const next = await scheduleNext();
      sendResponse({ ok: true, data: { autoEnabled: !!msg.enabled, nextRun: next } });
    });
    return true;
  }
});
