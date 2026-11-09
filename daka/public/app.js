(() => {
  let state = null;
  let ws = null;
  let timer = null;

  const $ = id => document.getElementById(id);
  const connPill = $('connPill');
  const liveEl = $('liveLogs');
  const historyEl = $('history');
  const autoEnable = $('autoEnable');
  const autoHint = $('autoHint');

  function setConn(ok, text) {
    connPill.textContent = text;
    connPill.className = 'status-pill ' + (ok ? 'on' : 'off');
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function badge(ok, text) {
    return `<span class="badge ${ok ? 'ok' : 'bad'}">${text}</span>`;
  }

  function renderBalance() {
    const pack = state && state.credits;
    const c = pack && pack.credits;
    if (!c) {
      $('balanceMain').textContent = '--';
      $('balanceHint').textContent = '随时可查，点「获取余额」';
      $('balancePkgs').innerHTML = '';
      return;
    }
    $('balanceMain').textContent = String(c.remain_effective != null ? c.remain_effective : c.remain);
    const when = c.updated_iso || '';
    const extra = pack.summary ? ` · 累计消耗 ${pack.summary.total}` : '';
    $('balanceHint').textContent = `剩余 ${c.remain_effective} / ${c.size}，已用 ${c.used}${extra}${when ? ' · ' + when : ''}`;
    $('balancePkgs').innerHTML = (c.packages || []).map(p =>
      `<div class="pkg-row"><span>${p.name}</span><span>${p.remain} / ${p.size}</span></div>`
    ).join('');
  }

  function render() {
    if (!state) return;
    const cfg = state.config || {};
    const p = (cfg.platforms && cfg.platforms.qoder) || {};
    const logs = state.logs || [];
    const today = state.today;
    const todayLog = logs.find(l => l.platform === 'qoder' && l.date === today);
    const busy = !!state.running;

    $('btnCheckin').disabled = busy;
    $('btnCredits').disabled = !!state.creditsRunning;
    if (todayLog && todayLog.success) {
      $('btnCheckin').textContent = todayLog.alreadyCheckedIn ? '今日已打卡' : '打开 · 已签到';
    } else {
      $('btnCheckin').textContent = '打开 · 打卡';
    }

    if (state.phoneUrl) {
      $('phoneHint').textContent = '手机打开 ' + state.phoneUrl;
    }
    autoEnable.checked = !!(cfg.auto && cfg.auto.enable !== false);
    const h = cfg.auto && cfg.auto.hour != null ? cfg.auto.hour : 10;
    const m = cfg.auto && cfg.auto.minute != null ? cfg.auto.minute : 1;
    const ch = cfg.auto && cfg.auto.catchupHour != null ? cfg.auto.catchupHour : 11;
    const cm = cfg.auto && cfg.auto.catchupMinute != null ? cfg.auto.catchupMinute : 0;
    autoHint.textContent = `北京时间 ${pad(h)}:${pad(m)} 首打，忘记则 ${pad(ch)}:${pad(cm)} 补打`;

    renderBalance();

    liveEl.textContent = (state.live || []).map(x => `[${x.time.slice(11, 19)}] ${x.msg}`).join('\n');
    liveEl.scrollTop = liveEl.scrollHeight;

    historyEl.innerHTML = logs.slice(0, 20).map(l => `
      <div class="his-item">
        ${badge(l.success, l.success ? '成功' : '失败')}
        <b>${l.platform === 'credits' ? '余额' : 'Qoder'}</b>
        ${l.date} ${l.trigger || ''}
        <div class="meta">${l.message || ''}</div>
      </div>`).join('') || '<div class="meta">暂无记录</div>';

    const hint = $('tokenHint');
    if (p.configured) {
      hint.textContent = (cfg.tokenMessage || '已从本机 Qoder 自动读取 token') + '（' + (p.accessToken || '已配置') + '）';
    } else {
      hint.textContent = cfg.tokenMessage || '未读到 token。在这台 PC 登录 Qoder 后重新双击 start.bat';
    }
  }

  async function api(path, method, body) {
    const res = await fetch(path, {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    return res.json();
  }

  async function refresh() {
    state = await api('/api/status');
    render();
  }

  function checkin() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'checkin', platforms: ['qoder'], trigger: 'manual' }));
      return;
    }
    api('/api/checkin', 'POST', { platforms: ['qoder'], trigger: 'manual' }).then(refresh);
  }

  function credits() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'credits' }));
      return;
    }
    api('/api/credits', 'POST', {}).then(refresh);
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => setConn(true, '已连接');
    ws.onclose = () => {
      setConn(false, '已断开,重连中');
      clearTimeout(timer);
      timer = setTimeout(connect, 1500);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'state') {
        state = msg;
        render();
      } else if (msg.type === 'log') {
        if (!state) return;
        state.live = (state.live || []).concat([msg.item]);
        render();
      } else if (msg.type === 'running') {
        if (state) state.running = msg.running;
        render();
      } else if (msg.type === 'creditsRunning') {
        if (state) state.creditsRunning = msg.running;
        render();
      }
    };
  }

  $('btnCheckin').onclick = checkin;
  $('btnCredits').onclick = credits;
  $('clearLive').onclick = () => {
    if (state) { state.live = []; render(); }
  };
  autoEnable.onchange = () => {
    api('/api/config', 'POST', { auto: { enable: autoEnable.checked } }).then(refresh);
  };
  connect();
  refresh().catch(() => setConn(false, '服务未启动'));
})();
