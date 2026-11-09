'use strict';

const https = require('https');
const http = require('http');

const TIMEOUT_QUERY = 8000;
const TIMEOUT_CLAIM = 10000;

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').slice(0, 1000);
}

function request(method, url, headers, body, timeout, onLog, tag) {
  const p = tag ? `[${tag}] ` : '';
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'http:' ? http : https;
    if (onLog) onLog(`${p}[${method}] ${url}`);
    const hdrs = Object.assign({}, headers || {});
    if (payload) {
      hdrs['Content-Type'] = hdrs['Content-Type'] || 'application/json';
      hdrs['Content-Length'] = payload.length;
    }
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers: hdrs
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (onLog) onLog(`${p}  HTTP ${res.statusCode}`);
        let json;
        try { json = JSON.parse(raw); } catch { json = undefined; }
        if (onLog) onLog(`${p}  响应: ${json !== undefined ? JSON.stringify(json).slice(0, 1000) : oneLine(raw)}`);
        resolve(json !== undefined ? { ok: true, http: res.statusCode, json, raw } : { ok: true, http: res.statusCode, raw });
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function postRequest(url, headers, body, timeout, onLog, tag) {
  return request('POST', url, headers, body || {}, timeout || TIMEOUT_QUERY, onLog, tag);
}

function getRequest(url, headers, timeout, onLog, tag) {
  return request('GET', url, headers, null, timeout || TIMEOUT_QUERY, onLog, tag);
}

const AUTH_CODE_RE = /TOKEN|AUTH|UNAUTHORIZED|EXPIRE|LOGIN/i;

function httpErr(res, label) {
  if (!res) return { message: `${label} 无响应`, credentialInvalid: false };
  if (res.ok === false) return { message: `${label} 请求失败: ${res.error || '网络错误/超时'}`, credentialInvalid: false };
  if (res.http === 401 || res.http === 403) {
    const j = res.json || {};
    return {
      message: `${label} 凭证已失效(${j.code || j.message || ('HTTP ' + res.http)}),请更新凭证`,
      credentialInvalid: true
    };
  }
  if (res.http !== 200) return { message: `${label} 接口异常: HTTP ${res.http}`, credentialInvalid: false };
  return null;
}

function respErr(res, label) {
  const e = httpErr(res, label);
  if (e) return e;
  const j = res.json;
  if (!j || typeof j !== 'object') {
    return { message: `${label} 响应无法解析: ${String(res.raw || '').slice(0, 200)}`, credentialInvalid: false };
  }
  const code = j.code;
  if (code === undefined || code === null || code === 0 || code === '0') return null;
  const detail = j.message || j.msg || '';
  const authish = AUTH_CODE_RE.test(String(code) + ' ' + String(detail));
  return {
    message: `${label} ${authish ? '凭证已失效' : '接口返回错误'}[${code}${detail ? ': ' + detail : ''}]${authish ? ',请更新凭证' : ''}`,
    credentialInvalid: authish
  };
}

function mkErr(message, credentialInvalid) {
  const e = new Error(message);
  e.credentialInvalid = !!credentialInvalid;
  return e;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  TIMEOUT_QUERY,
  TIMEOUT_CLAIM,
  postRequest,
  getRequest,
  httpErr,
  respErr,
  mkErr,
  sleep,
  AUTH_CODE_RE
};
