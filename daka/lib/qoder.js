'use strict';

const { TIMEOUT_QUERY, TIMEOUT_CLAIM, postRequest, getRequest, httpErr, respErr, sleep } = require('./http');

const BASE_CN = 'https://openapi.qoder.com.cn';
const PATH_CAMPAIGNS = '/sash/api/v1/me/campaigns';
const PATH_CLAIM = id => `/sash/api/v1/me/campaigns/${id}/claim`;
const PATH_CHECKIN_STATUS = '/sash/api/v1/me/daily-check-in/status';
const PATH_CHECKIN_CLAIM = '/sash/api/v1/me/daily-check-in/claim';
const PATH_QUOTA = '/api/v2/quota/usage';
const PATH_CREDIT_SUMMARY = '/sash/api/v1/ai-conversations/credits-summary';
const DESKTOP_VERSION = '0.4.8';
const CLAIM_GAP = 1000;

function desktopHeaders(token) {
  return {
    Accept: 'application/json',
    'User-Agent': 'Qoder',
    Authorization: `Bearer ${token}`,
    'cosy-clienttype': '10',
    'cosy-version': DESKTOP_VERSION
  };
}

function plainHeaders(token) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`
  };
}

function num(d, k) {
  const v = d && d[k];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function campaignNeedsRetry(listJson) {
  if (!listJson || typeof listJson !== 'object') return false;
  const items = listJson.campaigns || [];
  if (!items.length) return true;
  if (listJson.showCampaign === false && !listJson.claimable) return true;
  return !items.some(c => c && c.claimStatus === 'CLAIMABLE' && (!c.actionType || c.actionType === 'CLAIM_BENEFIT'));
}

async function getCampaigns(token, onLog) {
  const url = BASE_CN + PATH_CAMPAIGNS;
  let list = await getRequest(url, desktopHeaders(token), TIMEOUT_QUERY, onLog, 'Qoder');
  if (list.http === 401 || list.http === 403) {
    onLog('[Qoder] 桌面端头被拒,回退普通 Bearer');
    list = await getRequest(url, plainHeaders(token), TIMEOUT_QUERY, onLog, 'Qoder');
  }
  return list;
}

async function checkinQoder(cfg, onLog) {
  if (!cfg.accessToken) throw new Error('缺少 accessToken');
  const token = cfg.accessToken;
  onLog('[Qoder] 查询活动列表...');

  let list = await getCampaigns(token, onLog);
  let qErr = respErr(list, 'Qoder campaigns');
  if (qErr) {
    onLog(`[结果] qoder: ${qErr.message}`);
    return { success: false, credentialInvalid: qErr.credentialInvalid, message: qErr.message };
  }

  for (const wait of [800, 2000]) {
    if (!campaignNeedsRetry(list.json)) break;
    onLog(`[Qoder] 活动列表为空或无可领项,${wait}ms 后重试`);
    await sleep(wait);
    list = await getCampaigns(token, onLog);
    qErr = respErr(list, 'Qoder campaigns');
    if (qErr) {
      return { success: false, credentialInvalid: qErr.credentialInvalid, message: qErr.message };
    }
  }

  const campResult = await claimCampaigns(token, list.json || {}, onLog);
  if (campResult.done) {
    const credits = await fetchCreditsQuiet(cfg, onLog);
    return Object.assign({}, campResult.result, { credits });
  }

  onLog('[Qoder] 活动平台未拿到可领项,走旧 daily-check-in 兜底');
  const daily = await checkinDaily(token, onLog);
  const credits = await fetchCreditsQuiet(cfg, onLog);
  return Object.assign({}, daily, { credits });
}

async function claimCampaigns(token, payload, onLog) {
  const all = (payload.campaigns || []).filter(c => c);
  const claimable = all.filter(c =>
    (!c.actionType || c.actionType === 'CLAIM_BENEFIT') && c.claimStatus === 'CLAIMABLE'
  );
  const claimedCamps = all.filter(c => {
    if (c.claimStatus !== 'CLAIMED') return false;
    const amount = (c.benefit && c.benefit.amount) || 0;
    return amount > 0 || !c.actionType || c.actionType === 'CLAIM_BENEFIT';
  });

  if (claimable.length === 0 && claimedCamps.length > 0) {
    return {
      done: true,
      result: { success: true, message: '今日已领取(签到成功,幂等)', alreadyCheckedIn: true }
    };
  }

  if (claimable.length === 0) {
    return { done: false };
  }

  let claimed = 0;
  let totalCredit = 0;
  let claimFail = null;
  let blocked = false;
  const hdrs = Object.assign({}, desktopHeaders(token), { 'Content-Type': 'application/json' });

  for (const camp of claimable) {
    const cid = camp.campaignId;
    const amount = (camp.benefit && camp.benefit.amount) || 0;
    onLog(`[Qoder] 领取活动 ${cid} (+${amount} Credits)...`);
    const claim = await postRequest(BASE_CN + PATH_CLAIM(cid), hdrs, {}, TIMEOUT_CLAIM, onLog, 'Qoder');
    const cErr = httpErr(claim, `Qoder claim(${cid})`);
    const j = claim.json || {};
    const failure = String(j.failureCode || '').toUpperCase();
    const status = String(j.status || '').toUpperCase();

    if (cErr) {
      claimFail = cErr;
      onLog(`[Qoder] 活动 ${cid} 领取失败: ${cErr.message}`);
    } else if (failure === 'SAME_PERSON_ALREADY_CLAIMED' || status === 'BLOCKED') {
      blocked = true;
      onLog(`[Qoder] 活动 ${cid} 同人已领(按设备去重)`);
    } else if (status === 'CLAIMED' || status === 'GRANTED' || status === 'SUCCESS') {
      if (j.replayed) {
        onLog(`[Qoder] 活动 ${cid} 已领取过(replayed),跳过`);
      } else {
        claimed++;
        totalCredit += amount || Number(j.amount || 0);
      }
    } else {
      claimFail = {
        message: `活动 ${cid} 领取失败: ${j.message || j.code || claim.raw || '未知响应'}`,
        credentialInvalid: false
      };
      onLog(`[Qoder] 活动 ${cid} 领取失败: ${JSON.stringify(j || claim.raw)}`);
    }
    await sleep(CLAIM_GAP);
  }

  if (claimed > 0) {
    return {
      done: true,
      result: { success: true, message: `签到成功 +${totalCredit} Credits,共${claimed}项`, credit: totalCredit }
    };
  }
  if (blocked) {
    return {
      done: true,
      result: { success: true, message: '同人已领取(本机其他账号/官方客户端已领)', alreadyCheckedIn: true }
    };
  }
  if (claimFail) {
    return {
      done: true,
      result: { success: false, credentialInvalid: claimFail.credentialInvalid, message: `Qoder 领取失败: ${claimFail.message}` }
    };
  }
  return {
    done: true,
    result: { success: true, message: '今日已领取(无新增)', alreadyCheckedIn: true }
  };
}

async function checkinDaily(token, onLog) {
  const st = await getRequest(
    BASE_CN + PATH_CHECKIN_STATUS,
    desktopHeaders(token),
    TIMEOUT_QUERY, onLog, 'Qoder'
  );
  if (st.http === 404 || st.http === 405 || st.http === 410) {
    return { success: false, message: '今日无待领取活动,且旧签到接口未开放' };
  }
  const e = httpErr(st, 'Qoder daily-check-in');
  if (e) return { success: false, credentialInvalid: e.credentialInvalid, message: e.message };

  const q = st.json || {};
  const last = q.lastClaimedAt ? new Date(Number(q.lastClaimedAt) * 1000) : null;
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const lastDay = last ? new Date(last.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';
  const status = String(q.status || '');
  if (status === 'CLAIMED' && lastDay === today) {
    return { success: true, message: '今日已签到', alreadyCheckedIn: true, credit: Number(q.rewardCredits || 0) };
  }
  if (status !== 'CLAIMABLE' && status !== 'CLAIMED') {
    return { success: false, message: `官方签到活动未开放 (status=${status || '?'})` };
  }

  onLog('[Qoder] 调用旧 daily-check-in/claim...');
  const claim = await postRequest(
    BASE_CN + PATH_CHECKIN_CLAIM,
    Object.assign({}, desktopHeaders(token), { 'Content-Type': 'application/json' }),
    {}, TIMEOUT_CLAIM, onLog, 'Qoder'
  );
  const cErr = httpErr(claim, 'Qoder daily claim');
  if (cErr) {
    if (String(claim.raw || '').includes('ALREADY_CLAIMED')) {
      return { success: true, message: '今日已签到', alreadyCheckedIn: true };
    }
    return { success: false, credentialInvalid: cErr.credentialInvalid, message: cErr.message };
  }
  const r = claim.json || {};
  if (String(r.result || '') === 'ALREADY_CLAIMED' || (r.success === false && /ALREADY/i.test(String(r.error || '')))) {
    return { success: true, message: '今日已签到', alreadyCheckedIn: true };
  }
  if (r.success === false) {
    return { success: false, message: String(r.error || r.message || '旧签到领取失败') };
  }
  const reward = Number(r.rewardCredits || 0);
  return { success: true, message: `签到成功 +${reward} 积分`, credit: reward };
}

function parseQuota(q) {
  const uq = q.userQuota || {};
  const aq = q.addOnQuota || {};
  let remain = Math.floor(num(uq, 'remaining') + num(aq, 'remaining'));
  let used = Math.floor(num(uq, 'used') + num(aq, 'used'));
  let size = Math.floor(num(uq, 'total') + num(aq, 'total'));
  const packages = [
    { name: '基础额度', remain: Math.floor(num(uq, 'remaining')), used: Math.floor(num(uq, 'used')), size: Math.floor(num(uq, 'total')) },
    { name: '赠送/签到额度', remain: Math.floor(num(aq, 'remaining')), used: Math.floor(num(aq, 'used')), size: Math.floor(num(aq, 'total')) }
  ];

  let shared = null;
  for (const key of ['orgResourcePackage', 'sharedQuota', 'teamQuota', 'poolQuota', 'sharedCredits', 'sharedCredit']) {
    const src = q[key];
    if (src && typeof src === 'object') {
      const cap = num(src, 'cap') || num(src, 'total');
      shared = {
        remain: Math.floor(num(src, 'remaining')),
        used: Math.floor(num(src, 'used')),
        size: Math.floor(cap),
        available: src.available !== false,
        unlimited: cap < 0,
        source: key
      };
      packages.push({ name: '共享额度', remain: shared.remain, used: shared.used, size: shared.size });
      break;
    }
  }

  const sharedAvail = (shared && shared.available && !shared.unlimited) ? shared.remain : 0;
  const remainEffective = remain + sharedAvail;
  return {
    remain,
    remain_effective: remainEffective,
    used,
    size,
    exceeded: !!q.isQuotaExceeded,
    usage_pct: q.totalUsagePercentage,
    packages,
    shared,
    updated_at: Date.now(),
    updated_iso: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  };
}

async function fetchCredits(cfg, onLog) {
  if (!cfg || !cfg.accessToken) return { ok: false, message: '缺少 accessToken' };
  const token = cfg.accessToken;
  onLog('[Qoder] 查询额度...');
  let res = await getRequest(BASE_CN + PATH_QUOTA, desktopHeaders(token), 15000, onLog, 'Qoder');
  if (res.http === 401 || res.http === 403) {
    onLog('[Qoder] 额度接口桌面端头被拒,回退普通 Bearer');
    res = await getRequest(BASE_CN + PATH_QUOTA, plainHeaders(token), 15000, onLog, 'Qoder');
  }
  const e = httpErr(res, 'Qoder quota');
  if (e) return { ok: false, message: e.message, credentialInvalid: e.credentialInvalid };
  if (!res.json || typeof res.json !== 'object') {
    return { ok: false, message: '额度响应无法解析' };
  }
  const credits = parseQuota(res.json);
  let summary = null;
  const sum = await getRequest(BASE_CN + PATH_CREDIT_SUMMARY, desktopHeaders(token), 15000, onLog, 'Qoder');
  if (sum.json && typeof sum.json === 'object') {
    summary = {
      total: Number(sum.json.totalCredits || 0),
      peak: Number(sum.json.peakCredits || 0),
      peak_date: String(sum.json.peakDate || ''),
      unit: String(sum.json.unit || 'credits')
    };
  }
  return { ok: true, credits, summary };
}

async function fetchCreditsQuiet(cfg, onLog) {
  try {
    const r = await fetchCredits(cfg, onLog);
    return r.ok ? r.credits : null;
  } catch (e) {
    onLog('[Qoder] 刷新额度失败: ' + e.message);
    return null;
  }
}

module.exports = { checkinQoder, fetchCredits, desktopHeaders };
