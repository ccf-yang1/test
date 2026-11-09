'use strict';

const {
  TIMEOUT_QUERY, TIMEOUT_CLAIM, postRequest,
  httpErr, mkErr, sleep, AUTH_CODE_RE
} = require('./http');
const store = require('./store');
const { checkinQoder, fetchCredits } = require('./qoder');

async function checkinTrae(cfg, onLog) {
  if (!cfg.accessToken) throw new Error('缺少 accessToken');
  if (!cfg.deviceId) throw new Error('缺少 deviceId');

  const base = (cfg.host || 'https://api.trae.cn').replace(/`/g, '').trim();
  const headers = {
    'Authorization': `Cloud-IDE-JWT ${cfg.accessToken}`,
    'Content-Type': 'application/json',
    'x-device-id': cfg.deviceId
  };
  if (cfg.userRegion) headers['X-User-Region'] = cfg.userRegion;
  const postBody = { req_source: 1 };

  onLog('[Trae] 查询签到状态...');
  const status = await postRequest(
    `${base}/trae/api/v2/ug/checkin_credits/status`,
    headers, postBody, TIMEOUT_QUERY, onLog, 'Trae'
  );

  const traeHttpErr = httpErr(status, 'Trae status');
  if (traeHttpErr) throw mkErr(traeHttpErr.message, traeHttpErr.credentialInvalid);

  if (!status.json || status.json.code !== 0) {
    const detail = (status.json && (status.json.message || status.json.msg)) || status.raw;
    const authish = !!status.json && (status.json.enable === false || AUTH_CODE_RE.test(String(status.json.code) + ' ' + String(detail)));
    throw mkErr(`status 异常: code=${status.json && status.json.code}, msg=${detail}` + (authish ? ' (凭证已失效,请更新凭证)' : ''), authish);
  }

  if (status.json.enable === false) {
    return { success: false, message: '签到活动未开启' };
  }

  if (status.json.checked_in === true || status.json.did_checked_in === true) {
    return { success: true, message: '今日已签到,跳过', alreadyCheckedIn: true };
  }

  const maxRetry = 2;
  const retryDelays = [1000, 3000];

  for (let i = 0; i < maxRetry; i++) {
    onLog(`[Trae] 调用 claim 接口(第${i + 1}次)...`);
    const claim = await postRequest(
      `${base}/trae/api/v2/ug/checkin_credits/claim`,
      headers, postBody, TIMEOUT_CLAIM, onLog, 'Trae'
    );

    if (claim.json && claim.json.code === 0) {
      const points = (claim.json.data && claim.json.data.points) || claim.json.points || status.json.credits || 200;
      return { success: true, message: `签到成功 +${points} 积分`, points };
    }

    if (claim.json && claim.json.code === 1001) {
      return { success: true, message: '今日已签到', alreadyCheckedIn: true };
    }

    if (claim.json && claim.json.code === 9074) {
      if (i < maxRetry - 1) {
        const delay = retryDelays[i];
        onLog(`[Trae] 9074 设备号校验未通过,${delay}ms 后重试`);
        await sleep(delay);
        continue;
      }
      onLog('[Trae] 重试用尽,回查 status...');
      const reCheck = await postRequest(
        `${base}/trae/api/v2/ug/checkin_credits/status`,
        headers, postBody, TIMEOUT_QUERY, onLog, 'Trae'
      );
      if (reCheck.json && (reCheck.json.checked_in === true || reCheck.json.did_checked_in === true)) {
        return { success: true, message: '今日已签到(claim 返回 9074 但回查已到账)', alreadyCheckedIn: true };
      }
      return { success: false, message: `签到失败: 9074 设备号校验未通过(请重新获取凭证更新 deviceId),重试${maxRetry}次仍未成功` };
    }

    const msg = (claim.json && claim.json.message) || claim.raw || '未知错误';
    return { success: false, message: `签到失败: ${msg}` };
  }

  return { success: false, message: '签到失败: 重试用尽' };
}

async function checkinWorkBuddy(cfg, onLog) {
  if (!cfg.accessToken) throw new Error('缺少 accessToken');
  if (!cfg.uid) throw new Error('缺少 uid');

  const base = 'https://www.codebuddy.cn';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.accessToken}`,
    'X-User-Id': String(cfg.uid)
  };

  onLog('[WorkBuddy] 查询签到状态...');
  const status = await postRequest(
    `${base}/v2/billing/meter/checkin-activity-status`,
    headers, {}, TIMEOUT_QUERY, onLog, 'WorkBuddy'
  );

  const wbHttpErr = httpErr(status, 'WorkBuddy status');
  if (wbHttpErr) throw mkErr(wbHttpErr.message, wbHttpErr.credentialInvalid);

  if (!status.json || status.json.code !== 0) {
    const detail = (status.json && (status.json.msg || status.json.message)) || status.raw;
    const authish = !!status.json && AUTH_CODE_RE.test(String(status.json.code) + ' ' + String(detail));
    throw mkErr(`status 异常: code=${status.json && status.json.code}, msg=${detail}` + (authish ? ' (凭证已失效,请更新凭证)' : ''), authish);
  }

  if (status.json.data && status.json.data.active === false) {
    return { success: false, message: '签到活动未开启' };
  }

  if (status.json.data && status.json.data.today_checked_in === true) {
    return { success: true, message: '今日已签到,跳过', alreadyCheckedIn: true };
  }

  onLog('[WorkBuddy] 调用 claim 接口...');
  const claim = await postRequest(
    `${base}/v2/billing/meter/daily-checkin`,
    headers, {}, TIMEOUT_CLAIM, onLog, 'WorkBuddy'
  );

  if (claim.json && claim.json.code === 0) {
    const credit = (claim.json.data && claim.json.data.credit) || 0;
    const streak = (claim.json.data && claim.json.data.streak_days) || 0;
    return { success: true, message: `签到成功 +${credit} 积分,连签${streak}天`, credit, streak };
  }

  if (claim.json && claim.json.code === 10001) {
    return { success: true, message: '今日已签到', alreadyCheckedIn: true };
  }

  const msg = (claim.json && claim.json.msg) || claim.raw || '未知错误';
  return { success: false, message: `签到失败: ${msg}` };
}

const RUNNERS = {
  trae: checkinTrae,
  workbuddy: checkinWorkBuddy,
  qoder: checkinQoder
};

async function runPlatform(name, cfg, onLog) {
  const runner = RUNNERS[name];
  if (!runner) return { success: false, message: `未知平台: ${name}` };
  if (!cfg || cfg.enable === false) return { success: false, message: `${name} 已禁用` };
  onLog(`========== ${name} 开始签到 ==========`);
  try {
    return await runner(cfg, onLog);
  } catch (e) {
    return { success: false, message: e.message, credentialInvalid: !!e.credentialInvalid };
  }
}

async function runAll(platforms, names, onLog, opts) {
  const skipIdempotent = opts && opts.skipIdempotent;
  const list = names && names.length ? names : ['qoder'];
  const results = {};
  const pending = [];

  for (const name of list) {
    if (skipIdempotent && store.todaySuccess(name)) {
      results[name] = { success: true, message: '今日已签到(当日幂等跳过)', alreadyCheckedIn: true };
      onLog(`[幂等] ${name}: 今日已有成功记录,跳过`);
      continue;
    }
    pending.push(name);
  }

  const settled = await Promise.allSettled(pending.map(name => runPlatform(name, platforms[name], onLog)));
  pending.forEach((name, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results[name] = s.value;
      onLog(`[结果] ${name}: ${s.value && s.value.message}`);
    } else {
      const msg = (s.reason && s.reason.message) || String(s.reason);
      results[name] = { success: false, message: msg, credentialInvalid: !!(s.reason && s.reason.credentialInvalid) };
      onLog(`[异常] ${name}: ${msg}`);
    }
  });

  return results;
}

module.exports = { runPlatform, runAll, RUNNERS, fetchCredits };
