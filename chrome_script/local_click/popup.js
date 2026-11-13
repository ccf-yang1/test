const matchFor = () => [SITE_URL.replace(/\/+$/, '') + '/*'];
let SITE_URL = 'https://localhost:9998/';
let AUTO = { start: '09:00', windowMinutes: 30 };

async function loadConf() {
  try {
    const r = await fetch(chrome.runtime.getURL('config.json'));
    const j = await r.json();
    if (j && j.baseUrl) SITE_URL = String(j.baseUrl).replace(/\/+$/, '') + '/';
    if (j && j.autoCheckin) AUTO = Object.assign(AUTO, j.autoCheckin);
  } catch (_) {}
  renderAutoLabel();
}

function renderAutoLabel() {
  const el = document.getElementById('autoLabel');
  if (!el) return;
  const [h, m] = String(AUTO.start).split(':');
  const s = new Date(2000, 0, 1, Number(h) || 0, Number(m) || 0, 0);
  const e = new Date(s.getTime() + (Number(AUTO.windowMinutes) || 30) * 60000);
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  el.textContent = `每天 ${hm(s)}–${hm(e)} 随机自动签到`;
}

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const btn = $('go');
const authBox = $('auth');
const codeEl = $('code');
const siteEl = $('site');

function clear() {
  logEl.textContent = '';
}

function line(text, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

async function checkSite() {
  try {
    const tabs = await chrome.tabs.query({ url: matchFor() });
    if (tabs.length) {
      siteEl.textContent = '站点已打开';
      siteEl.className = 'site ok';
    } else {
      siteEl.textContent = '直连模式（无需打开站点）';
      siteEl.className = 'site dim';
    }
  } catch (_) {
    siteEl.textContent = '';
  }
}

$('open').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: matchFor() });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: SITE_URL });
  }
  window.close();
});

btn.addEventListener('click', async () => {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '执行中…';
  clear();
  authBox.hidden = true;
  line('执行中，请稍候…', 'dim');

  try {
    const res = await chrome.runtime.sendMessage({ type: 'RUN' });
    clear();

    if (!res) return line('后台无响应，请重新加载扩展。', 'bad');
    if (!res.ok) return line(`执行失败：${res.error}`, 'bad');

    const data = res.data;
    if (!data || !Array.isArray(data.lines)) {
      return line('页面无返回数据（可能被站点 CSP 拦截），刷新站点页面后重试。', 'bad');
    }

    for (const it of data.lines) line(it.text, it.cls);

    if (data.needAuth) {
      codeEl.textContent = data.status ? `（HTTP ${data.status}）` : '';
      authBox.hidden = false;
      return;
    }

    if (data.mode === 'direct') line('模式：直连（未打开任何页面）', 'dim');
    else if (data.mode === 'page') {
      line(data.switched
        ? `模式：页面回退（直连返回 HTTP ${data.switched}，cookie 未被跨站请求携带）`
        : '模式：页面回退', 'dim');
    }
    if (data.note) line(`直连失败原因：${data.note}`, 'dim');

    if (typeof data.credited === 'number') {
      if (data.credited > 0) line(`\n✔ 签到成功，额度 +${data.credited}`, 'ok');
      else if (data.credited === 0) line('\n本次未增加额度（今日可能已签到）', 'warn');
    }
  } catch (e) {
    clear();
    line(`异常：${(e && e.message) || e}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = '开始完整签到';
    checkSite();
  }
});


/* ---------------- 自动签到 ---------------- */
const autoBox = $('auto');
const autoInfo = $('autoInfo');

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderAuto(s) {
  autoBox.checked = !!s.autoEnabled;
  const next = s.autoEnabled ? `下次：${fmtTime(s.nextRun)}` : '未开启';
  let last = '上次：—';
  if (s.lastRun && s.lastRun.at) {
    const flag = s.lastRun.ok ? '<span class="ok">成功</span>' : '<span class="bad">失败</span>';
    const extra = s.lastRun.needAuth ? '（未登录）'
      : (typeof s.lastRun.credited === 'number' ? `（额度 ${s.lastRun.credited >= 0 ? '+' : ''}${s.lastRun.credited}）` : '');
    last = `上次：${fmtTime(s.lastRun.at)} ${flag}${extra}`;
  }
  autoInfo.innerHTML = `${next}<br>${last}`;
}

async function loadAuto() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AUTO_GET' });
    if (res && res.ok) renderAuto(res.data);
    else autoInfo.textContent = '状态读取失败';
  } catch (_) {
    autoInfo.textContent = '状态读取失败';
  }
}

autoBox.addEventListener('change', async () => {
  autoBox.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AUTO_SET', enabled: autoBox.checked });
    if (res && res.ok) renderAuto({ autoEnabled: res.data.autoEnabled, nextRun: res.data.nextRun });
    else autoInfo.textContent = '设置失败';
  } catch (_) {
    autoInfo.textContent = '设置失败';
  } finally {
    autoBox.disabled = false;
  }
});

loadConf().then(() => { checkSite(); loadAuto(); });
