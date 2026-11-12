// ==UserScript==
// @name         签到
// @namespace    local.pow.audit
// @version      8.0.0
// @description  challenge -> 派生 salt/target -> wasm 求 nonce -> redeem -> checkin -> wallet，一条完整签到链路
// @match        https://-ai.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ================== 配置（接口都在这里改） ================== */
  const CONF = {
    CHALLENGE: '/api/v1/public/captcha/challenge',  // POST，无 body
    REDEEM:    '/api/v1/public/captcha/redeem',     // POST {token, solutions}
    CHECKIN:   '/api/v1/users/wallet/checkin',      // POST {captcha_token}
    WALLET:    '/api/v1/users/wallet',              // GET
    GLUE:      '/captcha/cap_wasm.js',              // 站点 wasm 胶水
    CREDENTIALS: 'include',                         // 带 cookie
    AUTH_HEADER: null,                              // 例 {name:'Authorization', value:'Bearer xxx'}
  };
  /* ========================================================== */

  /* ============ 1. 记录 wasm 实例（不做包裹） ============ */
  const CAP = { real: null };
  const noteInst = (inst) => {
    if (inst && inst.exports && typeof inst.exports.solve_pow === 'function') CAP.real = inst.exports;
  };
  try {
    const f = WebAssembly.instantiate;
    WebAssembly.instantiate = function (...a) {
      return f.apply(this, a).then((r) => { noteInst(r && r.instance ? r.instance : r); return r; });
    };
  } catch (_) {}
  try {
    const f = WebAssembly.instantiateStreaming;
    if (f) WebAssembly.instantiateStreaming = function (...a) {
      return f.apply(this, a).then((r) => { noteInst(r && r.instance); return r; });
    };
  } catch (_) {}

  /* ============ 2. 求解器 ============ */
  let MOD = null;
  async function getSolver() {
    if (MOD) return MOD;
    try {
      const m = await import(CONF.GLUE);
      if (typeof m.default === 'function') { try { await m.default(); } catch (_) {} }
      if (typeof m.solve_pow === 'function') { MOD = m; return MOD; }
    } catch (_) {}
    return null;
  }

  const enc = new TextEncoder();
  function rawSolve(a, b) {
    const ex = CAP.real;
    if (!ex) throw new Error('没有可用的 wasm');
    const ba = enc.encode(a);
    const pa = ex.__wbindgen_malloc(ba.length, 1) >>> 0;
    new Uint8Array(ex.memory.buffer).set(ba, pa);
    const bb = enc.encode(b);
    const pb = ex.__wbindgen_malloc(bb.length, 1) >>> 0;
    new Uint8Array(ex.memory.buffer).set(bb, pb);
    return BigInt.asUintN(64, ex.solve_pow(pa, ba.length, pb, bb.length));
  }

  /* ============ 3. Cap 派生：FNV-1a + xorshift32 ============ */
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

  /* ============ 4. UI ============ */
  let logEl = null;
  const log = (m, c) => {
    if (!logEl) return console.log('[pow]', m);
    const d = document.createElement('div');
    if (c) d.className = c;
    d.textContent = m;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  };

  function mount() {
    const style = document.createElement('style');
    style.textContent = `
    #pow-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:min(580px,94vw);
      font:12px/1.6 ui-monospace,Consolas,monospace;color:#e6edf3;background:#0d1117;
      border:1px solid #30363d;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden}
    #pow-panel .hd{display:flex;justify-content:space-between;padding:8px 10px;background:#161b22;
      border-bottom:1px solid #30363d;font-weight:600}
    #pow-panel .bd{padding:10px;max-height:46vh;overflow:auto;white-space:pre-wrap;word-break:break-all}
    #pow-panel .ft{padding:8px;border-top:1px solid #30363d;background:#161b22}
    #pow-panel button{width:100%;padding:8px;border-radius:6px;cursor:pointer;font:inherit;
      color:#e6edf3;background:#21262d;border:1px solid #30363d}
    #pow-panel button:hover{background:#30363d}
    #pow-panel button[disabled]{opacity:.45;cursor:not-allowed}
    #pow-panel .ok{color:#3fb950}.bad{color:#f85149}.dim{color:#8b949e}.warn{color:#d29922}`;
    document.head.appendChild(style);

    const p = document.createElement('div');
    p.id = 'pow-panel';
    p.innerHTML = `<div class="hd"><span>PoW 签到</span></div>
      <div class="bd" id="pow-log"></div>
      <div class="ft"><button id="pow-go">开始签到</button></div>`;
    document.body.appendChild(p);
    logEl = p.querySelector('#pow-log');
    p.querySelector('#pow-go').addEventListener('click', runFlow);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  /* ============ 5. 请求封装 ============ */
  async function req(method, path, body) {
    const headers = { Accept: '*/*' };
    if (CONF.AUTH_HEADER && CONF.AUTH_HEADER.name) headers[CONF.AUTH_HEADER.name] = CONF.AUTH_HEADER.value;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, {
      method,
      credentials: CONF.CREDENTIALS,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, json, text };
  }

  const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));

  /* ============ 6. 完整流程 ============ */
  async function runFlow() {
    const btn = document.querySelector('#pow-go');
    if (btn.disabled) return;
    btn.disabled = true;
    logEl.textContent = '';
    const t0 = performance.now();
    let mark = t0;
    const lap = () => { const n = performance.now(); const d = n - mark; mark = n; return d; };

    try {
      const m = await getSolver();
      const solve = (a, b) => (m ? m.solve_pow(a, b) : rawSolve(a, b));
      if (!m && !CAP.real) { log('没有可用的 wasm，先刷新页面。', 'bad'); return; }

      /* --- 0. 签到前余额 --- */
      const w0 = await req('GET', CONF.WALLET);
      const bal0 = w0.json && w0.json.data ? w0.json.data.balance : null;
      log(`[0/4] 当前余额：${fmt(bal0)}  日额度：${fmt(w0.json?.data?.daily_token_balance)}/${fmt(w0.json?.data?.daily_token_limit)}`, 'dim');

      /* --- 1. challenge --- */
      const r1 = await req('POST', CONF.CHALLENGE);
      if (!r1.json || !r1.json.challenge) throw new Error(`challenge 失败 HTTP ${r1.status}: ${r1.text.slice(0, 120)}`);
      const raw = r1.json.challenge;
      const token = r1.json.token;
      const isArr = Array.isArray(raw);
      const c = isArr ? raw.length : raw.c;
      const s = isArr ? 0 : raw.s;
      const d = isArr ? 0 : raw.d;
      log(`[1/4] challenge：c=${c} s=${s} d=${d}  token=${String(token).slice(0, 12)}…  (${lap().toFixed(0)} ms)`);

      /* --- 2. 派生 + 求解 --- */
      const pairs = isArr ? raw : Array.from({ length: c }, (_, k) => {
        const i = k + 1;
        return [capHash(`${token}${i}`, s), capHash(`${token}${i}d`, d)];
      });
      const solutions = pairs.map(([salt, target]) => Number(solve(salt, target)));
      log(`[2/4] 解出 ${c} 题（salt[0]=${pairs[0][0]} target[0]=${JSON.stringify(pairs[0][1])}）  (${lap().toFixed(0)} ms)`);

      /* --- 3. redeem --- */
      const r3 = await req('POST', CONF.REDEEM, { token, solutions });
      const capToken = r3.json && r3.json.token;
      if (!r3.json || r3.json.success !== true || !capToken) {
        throw new Error(`redeem 失败 HTTP ${r3.status}: ${r3.text.slice(0, 160)}`);
      }
      log(`[3/4] redeem 通过，captcha_token=${capToken}  (${lap().toFixed(0)} ms)`, 'ok');

      /* --- 4. checkin --- */
      const r4 = await req('POST', CONF.CHECKIN, { captcha_token: capToken });
      if (!r4.json || r4.json.code !== 0) {
        throw new Error(`checkin 失败 HTTP ${r4.status}: ${r4.text.slice(0, 160)}`);
      }
      log(`[4/4] checkin：${JSON.stringify(r4.json.data)}  (${lap().toFixed(0)} ms)`, 'ok');

      /* --- 5. 签到后余额 --- */
      const w1 = await req('GET', CONF.WALLET);
      const d1 = (w1.json && w1.json.data) || {};
      const bal1 = d1.balance;
      const diff = typeof bal1 === 'number' && typeof bal0 === 'number' ? bal1 - bal0 : null;
      log(`\n余额：${fmt(bal0)} → ${fmt(bal1)}${diff === null ? '' : `  (${diff >= 0 ? '+' : ''}${fmt(diff)})`}`, diff > 0 ? 'ok' : 'dim');
      log(`日额度：${fmt(d1.daily_token_balance)}/${fmt(d1.daily_token_limit)}`, 'dim');

      log(`\n全链路耗时 ${(performance.now() - t0).toFixed(0)} ms `, 'warn');
    } catch (e) {
      log(`\n✘ ${e && e.message ? e.message : e}`, 'bad');
    } finally {
      btn.disabled = false;
    }
  }

  window.__powAudit = { getSolver, rawSolve, capHash, runFlow, CAP, CONF };
})();
