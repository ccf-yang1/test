'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const QODER_SECRET_KEYS = [
  'secret://aicoding.auth.userInfo',
  'secret://aicoding.auth.userPlan'
];

const OPEN_API = 'https://openapi.qoder.com.cn';

// 来源一：Qoder CN CLI 的本地登录态（~/.qoder-cn/.auth/user）。
// 实现参考 TokenTracker (xiufengsun) src/lib/qoder-cn-cli-limits.js 的
// readQoderCnCliCredentials —— 官方 CLI 的 WASM 凭据编解码：AES-128-CBC，
// key=iv=machine_id 前 16 字符，明文 JSON 取 security_oauth_token || access_token。
function readCliCredentials() {
  const root = (process.env.QODERCN_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.qoder-cn');
  try {
    const encrypted = fs.readFileSync(path.join(root, '.auth', 'user'), 'utf8').trim();
    const machineId = fs.readFileSync(path.join(root, '.auth', 'machine_id'), 'utf8').trim();
    const key = Buffer.from(machineId.slice(0, 16), 'utf8');
    if (key.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
    const user = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final()
    ]).toString('utf8'));
    const token = user.security_oauth_token || user.access_token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

// PAT（控制台「设置 → 个人访问令牌」创建）→ 换 openapi 可用的短时 Bearer。
// 换取端点与响应字段参考 TokenTracker 同款实现：POST /api/v1/jobToken/exchange。
// 注意：不传 onLog，响应体含 token，绝不进日志。
async function exchangePatToken(pat) {
  const { postRequest } = require('./http');
  const res = await postRequest(
    `${OPEN_API}/api/v1/jobToken/exchange`,
    { Accept: 'application/json' },
    { personal_token: pat },
    8000, null, 'Qoder'
  );
  const j = (res && res.json) || {};
  const t = j.token || j.device_token || j.access_token;
  if (typeof t === 'string' && t.trim()) {
    // expires_at 是 ISO；换出来的 job token 实测只有 24h，靠 server 侧到期前重换
    const exp = Date.parse(String(j.expires_at || ''));
    return { ok: true, accessToken: t.trim(), expiresAt: Number.isFinite(exp) ? exp : 0 };
  }
  const msg = res ? `HTTP ${res.http} ${String(res.raw || '').slice(0, 160)}` : '无响应';
  return { ok: false, message: `PAT 换取 token 失败: ${msg}` };
}

// PAT 来源：环境变量 QODERCN_PERSONAL_ACCESS_TOKEN，或 daka 目录下 pat.txt（已 gitignore）。
function readPat() {
  const envPat = process.env.QODERCN_PERSONAL_ACCESS_TOKEN || '';
  if (envPat.trim()) return envPat.trim();
  try {
    const f = path.join(__dirname, '..', 'pat.txt');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  } catch {}
  return '';
}

function appData() {
  return process.env.APPDATA || '';
}

function qoderPaths() {
  const root = path.join(appData(), 'QoderCN');
  return {
    vscdb: path.join(root, 'User', 'globalStorage', 'state.vscdb'),
    localState: path.join(root, 'Local State')
  };
}

function copyFileUnlocked(src) {
  const tmp = path.join(os.tmpdir(), `cred_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
  fs.copyFileSync(src, tmp);
  const buf = fs.readFileSync(tmp);
  try { fs.unlinkSync(tmp); } catch {}
  return buf;
}

function readVarint(buf, off) {
  let result = 0;
  for (let i = 0; i < 9; i++) {
    const b = buf[off + i];
    if (i === 8) { result = result * 256 + b; return [result, off + 9]; }
    result = (result << 7) | (b & 0x7f);
    if (!(b & 0x80)) return [result, off + i + 1];
  }
}

function readSqliteItemTable(fileBuf) {
  const pageSize = fileBuf.readUInt16BE(16);
  const reserved = fileBuf[20];
  const pageCount = Math.floor(fileBuf.length / pageSize);
  const U = pageSize - reserved;
  const X = U - 35;
  const M = Math.floor(((U - 12) * 32) / 255);
  const rows = [];

  for (let pgno = 1; pgno <= pageCount; pgno++) {
    const base = (pgno - 1) * pageSize;
    const pageType = fileBuf[base + (pgno === 1 ? 100 : 0)];
    if (pageType !== 0x0d) continue;
    const headerStart = base + (pgno === 1 ? 100 : 0);
    const cellCount = fileBuf.readUInt16BE(headerStart + 3);
    const contentStartRel = fileBuf.readUInt16BE(headerStart + 5);
    const contentStart = contentStartRel === 0 ? base + U : base + contentStartRel;

    for (let c = 0; c < cellCount; c++) {
      const cellPtrRel = fileBuf.readUInt16BE(headerStart + 8 + c * 2);
      if (cellPtrRel === 0 || cellPtrRel >= U) continue;
      let off = base + cellPtrRel;
      try {
        let payloadLen;
        [payloadLen, off] = readVarint(fileBuf, off);
        let rowid;
        [rowid, off] = readVarint(fileBuf, off);
        if (!Number.isFinite(payloadLen) || payloadLen <= 0 || payloadLen > fileBuf.length) continue;
        let K;
        if (payloadLen <= X) K = payloadLen;
        else {
          K = M + ((payloadLen - M) % (U - 4));
          if (K > X) K = M;
        }
        if (off + K > base + U) continue;
        let payload = fileBuf.subarray(off, off + K);
        if (payloadLen > K) {
          let nextPage = fileBuf.readUInt32BE(off + K);
          const parts = [payload];
          let remaining = payloadLen - K;
          let guard = 0;
          while (nextPage !== 0 && remaining > 0 && guard++ < 10000) {
            if (nextPage < 1 || nextPage > pageCount) throw new Error('overflow 页号越界');
            const oBase = (nextPage - 1) * pageSize;
            const next = fileBuf.readUInt32BE(oBase);
            const take = Math.min(U - 4, remaining);
            parts.push(fileBuf.subarray(oBase + 4, oBase + 4 + take));
            remaining -= take;
            nextPage = remaining > 0 ? next : 0;
          }
          payload = Buffer.concat(parts);
        }
        if (payload.length !== payloadLen) continue;
        const [headerLen, hEnd] = readVarint(payload, 0);
        let p = hEnd;
        const serials = [];
        while (p < headerLen) {
          const [s, np] = readVarint(payload, p);
          serials.push(s); p = np;
        }
        let body = headerLen;
        const cols = [];
        let bad = false;
        for (const s of serials) {
          if (s === 0) { cols.push(null); continue; }
          let len = 0;
          if (s >= 13 && s % 2 === 1) len = (s - 13) / 2;
          else if (s >= 12 && s % 2 === 0) len = (s - 12) / 2;
          else if (s === 1) len = 1;
          else if (s === 2) len = 2;
          else if (s === 3) len = 3;
          else if (s === 4) len = 4;
          else if (s === 5) len = 6;
          else if (s === 6) len = 8;
          else if (s >= 7 && s <= 9) { cols.push(null); continue; }
          else { bad = true; break; }
          if (body + len > payload.length) { bad = true; break; }
          cols.push(payload.subarray(body, body + len));
          body += len;
        }
        if (!bad && cols.length >= 2 && cols[0]) {
          rows.push({ key: cols[0].toString('utf8'), value: cols[1] });
        }
      } catch {}
    }
  }
  return rows;
}

function dpapiDecrypt(blobBuf) {
  const bin = path.join(os.tmpdir(), `dpapi_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(bin, blobBuf);
  try {
    const ps = `Add-Type -AssemblyName System.Security;` +
      `$b=[IO.File]::ReadAllBytes('${bin.replace(/'/g, "''")}');` +
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, {
      timeout: 20000, encoding: 'utf8', windowsHide: true
    }).trim();
    return Buffer.from(out, 'base64');
  } finally {
    try { fs.unlinkSync(bin); } catch {}
  }
}

function chromiumDecrypt(encryptedBuf, aesKey) {
  if (encryptedBuf.subarray(0, 3).toString('latin1') !== 'v10') {
    throw new Error('密文不是 v10 格式');
  }
  const nonce = encryptedBuf.subarray(3, 15);
  const tag = encryptedBuf.subarray(encryptedBuf.length - 16);
  const data = encryptedBuf.subarray(15, encryptedBuf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function extractToken(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 5) return '';
  const direct = obj.token || obj.accessToken || obj.access_token || obj.jwt || obj.bearer
    || (obj.auth && (obj.auth.accessToken || obj.auth.token || obj.auth.access_token)) || '';
  if (typeof direct === 'string' && direct) return direct;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v && /token|auth|jwt|bearer/i.test(k)) return v;
    if (v && typeof v === 'object') {
      const found = extractToken(v, (depth || 0) + 1);
      if (found) return found;
    }
  }
  return '';
}

function readQoderToken() {
  if (process.platform !== 'win32') {
    return { ok: false, message: '自动读 token 只在 Windows 本机（已登录 Qoder）可用' };
  }
  const cli = readCliCredentials();
  if (cli) return { ok: true, accessToken: cli, source: 'cli-creds' };
  const { vscdb, localState } = qoderPaths();
  if (!fs.existsSync(vscdb) || !fs.existsSync(localState)) {
    return { ok: false, message: '未找到登录态：CLI 目录(~/.qoder-cn/.auth/user)和 IDE 目录(%APPDATA%\\QoderCN)都没有' };
  }
  const dbBuf = copyFileUnlocked(vscdb);
  const rows = readSqliteItemTable(dbBuf);
  const local = JSON.parse(fs.readFileSync(localState, 'utf8'));
  const encKeyRaw = Buffer.from(local.os_crypt.encrypted_key, 'base64');
  if (encKeyRaw.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    return { ok: false, message: 'Qoder Local State 密钥格式异常' };
  }
  const aesKey = dpapiDecrypt(encKeyRaw.subarray(5));
  let accessToken = '';
  for (const secretKey of QODER_SECRET_KEYS) {
    const hit = rows.find(r => r.key === secretKey);
    if (!hit) continue;
    try {
      const wrapped = JSON.parse(hit.value.toString('utf8'));
      const encrypted = Buffer.from(wrapped.data);
      const plain = chromiumDecrypt(encrypted, aesKey);
      try {
        const j = JSON.parse(plain);
        const t = extractToken(j, 0);
        if (t) accessToken = t;
      } catch {}
    } catch {}
  }
  if (!accessToken) return { ok: false, message: 'Qoder 本地库里没有 accessToken，请确认已登录' };
  return { ok: true, accessToken };
}

module.exports = { readQoderToken, qoderPaths, exchangePatToken, readPat, readCliCredentials };
