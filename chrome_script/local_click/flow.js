(async () => {
  const C0 = window.__powConf || {};
  const E = C0.endpoints || {};
  const A = C0.assets || {};
  const CONF = {
    CHALLENGE: E.challenge || '/api/v1/public/captcha/challenge',
    REDEEM:    E.redeem    || '/api/v1/public/captcha/redeem',
    CHECKIN:   E.checkin   || '/api/v1/users/wallet/checkin',
    WALLET:    E.wallet    || '/api/v1/users/wallet',
    GLUE:      A.glue      || '/captcha/cap_wasm.js',
    AUTH_HEADER: C0.auth && C0.auth.header
      ? { name: C0.auth.header, value: C0.auth.value }
      : null,
  };

  const lines = [];
  const push = (text, cls) => lines.push({ text, cls: cls || '' });
  const done = (extra) => Object.assign({ lines }, extra);

  let MOD = null;
  async function getSolver() {
    if (MOD) return MOD;
    try {
      const url = new URL(CONF.GLUE, location.origin).href;
      const m = await import(url);
      if (typeof m.default === 'function') {
        try { await m.default(); } catch (_) {}
      }
      if (typeof m.solve_pow === 'function') { MOD = m; return MOD; }
    } catch (_) {}
    return null;
  }

  const enc = new TextEncoder();
  function rawSolve(a, b) {
    const ex = window.__capExports;
    if (!ex) throw new Error('没有可用的 wasm：import 失败且页面未加载实例，请刷新站点页面再试');
    const ba = enc.encode(a);
    const pa = ex.__wbindgen_malloc(ba.length, 1) >>> 0;
    new Uint8Array(ex.memory.buffer).set(ba, pa);
    const bb = enc.encode(b);
    const pb = ex.__wbindgen_malloc(bb.length, 1) >>> 0;
    new Uint8Array(ex.memory.buffer).set(bb, pb);
    return BigInt.asUintN(64, ex.solve_pow(pa, ba.length, pb, bb.length));
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

  async function req(method, path, body) {
    const headers = { Accept: '*/*' };
    if (CONF.AUTH_HEADER && CONF.AUTH_HEADER.name) headers[CONF.AUTH_HEADER.name] = CONF.AUTH_HEADER.value;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, {
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

  const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
  const isAuthErr = (r) =>
    [400, 401, 403].includes(r.status) ||
    (r.json && (r.json.code === 401 || r.json.code === 403));

  const t0 = performance.now();
  let mark = t0;
  const lap = () => { const n = performance.now(); const d = n - mark; mark = n; return d; };

  try {
    /* 0. 鉴权检查 */
    const w0 = await req('GET', CONF.WALLET);
    if (isAuthErr(w0)) {
      push('未登录 / 凭证失效，请先在该站点完成认证。', 'bad');
      return done({ needAuth: true, status: w0.status });
    }
    const d0 = (w0.json && w0.json.data) || {};
    push(`当前余额 ${fmt(d0.balance)}   日额度 ${fmt(d0.daily_token_balance)}/${fmt(d0.daily_token_limit)}`, 'dim');

    /* 1. challenge */
    const r1 = await req('POST', CONF.CHALLENGE);
    if (isAuthErr(r1)) {
      push('challenge 被拒绝，请先登录后再试。', 'bad');
      return done({ needAuth: true, status: r1.status });
    }
    if (!r1.json || !r1.json.challenge) throw new Error(`challenge 失败 HTTP ${r1.status}: ${r1.text.slice(0, 120)}`);

    const raw = r1.json.challenge;
    const token = r1.json.token;
    const isArr = Array.isArray(raw);
    const c = isArr ? raw.length : raw.c;
    const s = isArr ? 0 : raw.s;
    const d = isArr ? 0 : raw.d;
    push(`[1/4] challenge  c=${c} s=${s} d=${d}   (${lap().toFixed(0)} ms)`);

    /* 2. 派生 + 求解 */
    const m = await getSolver();
    const solve = (a, b) => (m ? m.solve_pow(a, b) : rawSolve(a, b));
    const pairs = isArr ? raw : Array.from({ length: c }, (_, k) => {
      const i = k + 1;
      return [capHash(`${token}${i}`, s), capHash(`${token}${i}d`, d)];
    });
    const solutions = pairs.map(([salt, target]) => Number(solve(salt, target)));
    push(`[2/4] 解出 ${c} 题    (${lap().toFixed(0)} ms)`);

    /* 3. redeem */
    const r3 = await req('POST', CONF.REDEEM, { token, solutions });
    const capToken = r3.json && r3.json.token;
    if (!r3.json || r3.json.success !== true || !capToken) {
      throw new Error(`redeem 失败 HTTP ${r3.status}: ${r3.text.slice(0, 140)}`);
    }
    push(`[3/4] redeem 通过    (${lap().toFixed(0)} ms)`, 'ok');

    /* 4. checkin */
    const r4 = await req('POST', CONF.CHECKIN, { captcha_token: capToken });
    if (isAuthErr(r4)) {
      push('签到接口拒绝凭证，请重新登录后再试。', 'bad');
      return done({ needAuth: true, status: r4.status });
    }
    if (!r4.json || r4.json.code !== 0) {
      throw new Error(`checkin 失败 HTTP ${r4.status}: ${r4.text.slice(0, 140)}`);
    }
    const cd = r4.json.data || {};
    push(`[4/4] checkin ${JSON.stringify(cd)}    (${lap().toFixed(0)} ms)`, 'ok');

    /* 5. 余额变化 */
    const w1 = await req('GET', CONF.WALLET);
    const d1 = (w1.json && w1.json.data) || {};
    const diff = typeof d1.balance === 'number' && typeof d0.balance === 'number' ? d1.balance - d0.balance : null;
    push('');
    const q0 = d0.daily_token_balance, q1 = d1.daily_token_balance;
    const qdiff = typeof q1 === 'number' && typeof q0 === 'number' ? q1 - q0 : null;
    push(`余额 ${fmt(d0.balance)} → ${fmt(d1.balance)}${diff === null ? '' : `  (${diff >= 0 ? '+' : ''}${fmt(diff)})`}`,
      diff > 0 ? 'ok' : 'dim');
    push(`日额度 ${fmt(q0)} → ${fmt(q1)}${qdiff === null ? '' : `  (${qdiff >= 0 ? '+' : ''}${fmt(qdiff)})`} / 上限 ${fmt(d1.daily_token_limit)}`, 'dim');
    if (!diff && !qdiff) push('余额与日额度都没变：要么今天已签到（幂等返回 true），要么签到只记账不发放额度。', 'warn');
    if (cd.checked_in === false) push('提示：服务端返回 checked_in=false', 'warn');
    push(`全链路 ${(performance.now() - t0).toFixed(0)} ms`, 'warn');

    return done({ needAuth: false, ok: true, credited: diff });
  } catch (e) {
    push(String((e && e.message) || e), 'bad');
    return done({ needAuth: false, ok: false });
  }
})();
