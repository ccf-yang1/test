#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import random
import signal
import subprocess
import sys
import time
import urllib3
from datetime import datetime, timedelta

import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

M32 = 0xFFFFFFFF
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE_URL = "https://monkeycode-ai.com"
USER_FILE = "userinfo.json"
STATE_FILE = "auto_state.json"
LOG_FILE = "auto_checkin.log"
WINDOW_START = "08:00:00"
WINDOW_END = "11:00:00"

EP_CHALLENGE = "/api/v1/public/captcha/challenge"
EP_REDEEM = "/api/v1/public/captcha/redeem"
EP_LOGIN = "/api/v1/users/password-login"
EP_STATUS = "/api/v1/users/status"
EP_CHECKIN = "/api/v1/users/wallet/checkin"
EP_WALLET = "/api/v1/users/wallet"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
)

USERS = [
  {"email": "33@qq.com", "password": "x"}, # iphone
  {"email": "5@gmail.com", "password": "x"}, # github
  {"email": "yehe@bullbaby.com", "password": "x"}, # douyin
]

STOP = False


def _i32(x):
    x &= M32
    return x - 0x100000000 if x & 0x80000000 else x


def _shl(x, n):
    return _i32((x & M32) << n)


def _shr(x, n):
    return (x & M32) >> n


def cap_hash(text, length):
    units = []
    raw = str(text).encode("utf-16-le")
    for i in range(0, len(raw), 2):
        units.append(raw[i] | (raw[i + 1] << 8))
    f = 2166136261
    for ch in units:
        f = _i32(f)
        f = _i32(f ^ ch)
        f = f + (_shl(f, 1) + _shl(f, 4) + _shl(f, 7) + _shl(f, 8) + _shl(f, 24))
    u = f & M32
    out = ""
    while len(out) < length:
        u = (_i32(u) ^ _shl(u, 13)) & M32
        u = (_i32(u) ^ _shr(u, 17)) & M32
        u = (_i32(u) ^ _shl(u, 5)) & M32
        out += "%08x" % u
    return out[:length]


def solve_pow(salt, target):
    bits = len(target) * 4
    want = int(target, 16)
    shift = 64 - bits
    salt_bytes = salt.encode()
    n = 0
    while True:
        digest = hashlib.sha256(salt_bytes + str(n).encode()).digest()
        if (int.from_bytes(digest[:8], "big") >> shift) == want:
            return n
        n += 1


class Client:
    def __init__(self, base_url, timeout=20, verify=False):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.verify = verify
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "User-Agent": UA,
                "Origin": self.base_url,
            }
        )

    def req(self, method, path, body=None):
        headers = {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        resp = self.session.request(
            method,
            self.base_url + path,
            headers=headers,
            data=None if body is None else json.dumps(body),
            timeout=self.timeout,
            verify=self.verify,
            allow_redirects=True,
        )
        text = resp.text
        try:
            payload = resp.json()
        except ValueError:
            payload = None
        return resp.status_code, payload, text

    @staticmethod
    def is_auth_error(status, payload):
        if status in (400, 401, 403):
            return True
        return bool(payload) and payload.get("code") in (401, 403)

    def logged_in(self):
        status, payload, _ = self.req("GET", EP_STATUS)
        if status == 200 and payload and payload.get("code") == 0:
            return bool((payload.get("data") or {}).get("user"))
        return False

    def solve_captcha(self):
        status, payload, text = self.req("POST", EP_CHALLENGE)
        if not payload or not payload.get("challenge"):
            raise RuntimeError("challenge failed: HTTP %s %s" % (status, text[:160]))
        raw = payload["challenge"]
        token = payload["token"]
        if isinstance(raw, list):
            pairs = [(str(p[0]), str(p[1])) for p in raw]
        else:
            count = int(raw["c"])
            s_len = int(raw["s"])
            d_len = int(raw["d"])
            pairs = [
                (cap_hash(token + str(i), s_len), cap_hash(token + str(i) + "d", d_len))
                for i in range(1, count + 1)
            ]
        solutions = [solve_pow(salt, target) for salt, target in pairs]
        status, payload, text = self.req(
            "POST", EP_REDEEM, {"token": token, "solutions": solutions}
        )
        cap_token = (payload or {}).get("token")
        if not payload or payload.get("success") is not True or not cap_token:
            raise RuntimeError("redeem failed: HTTP %s %s" % (status, text[:160]))
        return cap_token

    def login(self, email, password):
        cap_token = self.solve_captcha()
        status, payload, text = self.req(
            "POST",
            EP_LOGIN,
            {"email": email, "password": password, "captcha_token": cap_token},
        )
        if not payload or payload.get("code") != 0:
            raise RuntimeError("login failed: HTTP %s %s" % (status, text[:200]))
        return payload.get("data") or {}

    def wallet(self):
        status, payload, _ = self.req("GET", EP_WALLET)
        if self.is_auth_error(status, payload) or not payload or payload.get("code") != 0:
            return None
        return payload.get("data") or {}

    def checkin(self):
        cap_token = self.solve_captcha()
        return self.req("POST", EP_CHECKIN, {"captcha_token": cap_token})


def _fmt(value):
    if isinstance(value, (int, float)):
        return "{:,}".format(value)
    return str(value)


def describe(before, after):
    parts = []
    b0, b1 = before.get("balance"), after.get("balance")
    if isinstance(b0, (int, float)) and isinstance(b1, (int, float)):
        parts.append("余额 %s → %s (%+d)" % (_fmt(b0), _fmt(b1), int(b1 - b0)))
    q0, q1 = before.get("daily_token_balance"), after.get("daily_token_balance")
    if isinstance(q0, (int, float)) and isinstance(q1, (int, float)):
        parts.append("日额度 %s → %s (%+d)" % (_fmt(q0), _fmt(q1), int(q1 - q0)))
    if not parts:
        return "无余额信息"
    return "，".join(parts)


def run_account(account, opts):
    email = account["email"]
    password = account.get("password", "")
    client = Client(opts.base_url, timeout=opts.timeout, verify=opts.verify)
    client.login(email, password)
    before = client.wallet()
    if before is None:
        raise RuntimeError("登录后读取钱包失败")
    status, payload, text = client.checkin()
    if Client.is_auth_error(status, payload):
        client.login(email, password)
        before = client.wallet() or before
        status, payload, text = client.checkin()
    if not payload or payload.get("code") != 0:
        raise RuntimeError("checkin failed: HTTP %s %s" % (status, text[:200]))
    after = client.wallet()
    if after is None:
        raise RuntimeError("签到后读取钱包失败")
    return describe(before, after)


def script_path(name):
    return name if os.path.isabs(name) else os.path.join(BASE_DIR, name)


def make_logger(path=None):
    def log(message):
        line = "%s %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), message)
        print(line, flush=True)
        if path:
            try:
                with open(path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except OSError:
                pass

    return log


def normalize_users(data):
    if isinstance(data, dict):
        if isinstance(data.get("users"), list):
            data = data["users"]
        elif isinstance(data.get("accounts"), list):
            data = data["accounts"]
        else:
            data = [data]
    if not isinstance(data, list):
        return []
    users = []
    seen = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        email = str(item.get("email") or item.get("user") or item.get("username") or "").strip()
        password = item.get("password")
        if not email or password is None:
            continue
        if email in seen:
            continue
        seen.add(email)
        users.append({"email": email, "password": str(password)})
    return users


def load_users_file(path, write_template=False):
    if not os.path.exists(path):
        if write_template:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump([{"email": "test@qq.com", "password": "test"}], fh, ensure_ascii=False, indent=2)
                fh.write("\n")
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        raise RuntimeError("读取 %s 失败: %s" % (path, exc))
    return normalize_users(data)


def resolve_users(args):
    if args.email:
        return [{"email": args.email, "password": args.password}]
    path = script_path(args.user_file)
    users = load_users_file(path, write_template=True)
    if users:
        return users
    hardcoded = normalize_users(USERS)
    if hardcoded:
        return hardcoded
    raise RuntimeError(
        "没有可用账号：请编辑 %s（或直接在脚本 USERS 列表中硬编码）" % path
    )


def parse_clock(text):
    parts = [int(p) for p in str(text).split(":")]
    while len(parts) < 3:
        parts.append(0)
    h, m, s = parts[:3]
    if not (0 <= h < 24 and 0 <= m < 60 and 0 <= s < 60):
        raise ValueError("时间格式不合法: %s" % text)
    return h, m, s


def window_bounds(day_start, start_text, end_text):
    h, m, s = parse_clock(start_text)
    begin = day_start.replace(hour=h, minute=m, second=s, microsecond=0)
    h, m, s = parse_clock(end_text)
    end = day_start.replace(hour=h, minute=m, second=s, microsecond=0)
    if end <= begin:
        raise ValueError("窗口结束时间必须晚于开始时间")
    return begin, end


def choose_time(now, email, state, opts):
    entry = state.get(email) or {}
    for offset in (0, 1):
        day = now.date() + timedelta(days=offset)
        if entry.get("last_run") == day.isoformat():
            continue
        day_start = datetime.combine(day, datetime.min.time())
        begin, end = window_bounds(day_start, opts.window_start, opts.window_end)
        lo = max(begin, now + timedelta(seconds=5))
        if lo >= end:
            continue
        span = int((end - lo).total_seconds())
        return lo + timedelta(seconds=random.randint(0, max(0, span)))
    return None


def spread_ok(target, schedule, gap=30):
    for current in schedule.values():
        if current and abs((current - target).total_seconds()) < gap:
            return False
    return True


def load_state(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    accounts = data.get("accounts") if isinstance(data, dict) else None
    return accounts if isinstance(accounts, dict) else {}


def save_state(path, state):
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"accounts": state}, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except OSError:
        pass


def mark_state(path, state, email, ok, detail):
    state[email] = {
        "last_run": datetime.now().date().isoformat(),
        "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "ok": bool(ok),
        "detail": detail,
    }
    save_state(path, state)


def run_once(opts, log):
    failed = 0
    for account in opts.users:
        email = account["email"]
        try:
            detail = run_account(account, opts)
            log("[ok] %s %s" % (email, detail))
        except Exception as exc:
            failed += 1
            log("[fail] %s %s" % (email, exc))
    return 1 if failed else 0


def auto_loop(opts, log):
    state = load_state(opts.state_path)
    schedule = {}
    log(
        "自动任务启动：窗口 %s~%s，账号 %d 个，状态文件 %s"
        % (opts.window_start, opts.window_end, len(opts.users), opts.state_path)
    )
    while not STOP:
        now = datetime.now()
        for account in opts.users:
            email = account["email"]
            target = schedule.get(email)
            if target and target > now:
                continue
            if target is None:
                picked = None
                for _ in range(8):
                    candidate = choose_time(now, email, state, opts)
                    if candidate is None:
                        break
                    picked = candidate
                    if spread_ok(candidate, schedule):
                        break
                if picked is None:
                    continue
                schedule[email] = picked
                log("计划 %s -> %s" % (email, picked.strftime("%Y-%m-%d %H:%M:%S")))

        due = sorted(
            ((schedule[a["email"]], a) for a in opts.users if schedule.get(a["email"]) and schedule[a["email"]] <= datetime.now()),
            key=lambda item: item[0],
        )
        if due:
            _, account = due[0]
            email = account["email"]
            schedule.pop(email, None)
            log("开始执行 %s（新建会话，重新登录）" % email)
            ok = False
            detail = ""
            for attempt in range(1, max(1, opts.retries) + 1):
                if STOP:
                    break
                try:
                    detail = run_account(account, opts)
                    log("[ok] %s %s" % (email, detail))
                    ok = True
                    break
                except Exception as exc:
                    detail = str(exc)
                    log("[fail] %s (%d/%d) %s" % (email, attempt, opts.retries, exc))
                    if attempt < opts.retries:
                        time.sleep(min(60, 10 * attempt))
            mark_state(opts.state_path, state, email, ok, detail)
            continue

        upcoming = [t for t in schedule.values() if t]
        wait = 30.0 if not upcoming else (min(upcoming) - datetime.now()).total_seconds()
        time.sleep(max(0.5, min(wait, 30.0)))

    log("自动任务已停止")


def spawn_background(argv, log_path):
    handle = open(log_path, "ab")
    env = dict(os.environ)
    env["CAP_AUTO_CHILD"] = "1"
    kwargs = dict(
        stdin=subprocess.DEVNULL,
        stdout=handle,
        stderr=handle,
        env=env,
        cwd=BASE_DIR,
    )
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__)] + argv, **kwargs
    )
    print("已转入后台运行 pid=%s" % proc.pid)
    print("日志文件: %s" % log_path)


def on_signal(signum, frame):
    global STOP
    STOP = True


def main(argv=None):
    parser = argparse.ArgumentParser(description="本地服务自动登录 + 签到")
    parser.add_argument("--auto", action="store_true", help="后台常驻，按账号随机时间自动登录并签到")
    parser.add_argument("--foreground", action="store_true", help="配合 --auto 时不转后台")
    parser.add_argument("--user-file", default=os.environ.get("CAP_USER_FILE", USER_FILE))
    parser.add_argument("--state-file", default=STATE_FILE)
    parser.add_argument("--log", default=None, help="非后台模式下的日志文件")
    parser.add_argument("--window-start", default=WINDOW_START)
    parser.add_argument("--window-end", default=WINDOW_END)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--base-url", default=os.environ.get("CAP_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--email", default=None)
    parser.add_argument("--password", default=os.environ.get("CAP_PASSWORD", ""))
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--verify", action="store_true", help="校验 TLS 证书")
    parser.add_argument("--repeat", type=int, default=0, help="非 --auto 模式每隔 N 秒重复执行")
    args = parser.parse_args(argv)

    signal.signal(signal.SIGINT, on_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, on_signal)

    log_path = script_path(LOG_FILE)
    if args.auto and not args.foreground and not os.environ.get("CAP_AUTO_CHILD"):
        spawn_background(list(sys.argv[1:] if argv is None else argv), log_path)
        return 0

    log = make_logger(args.log if args.log else None)

    try:
        args.users = resolve_users(args)
    except Exception as exc:
        print("[error] %s" % exc, file=sys.stderr)
        return 2
    if not args.users:
        print("[error] 未找到账号", file=sys.stderr)
        return 2
    args.state_path = script_path(args.state_file)

    if args.auto:
        try:
            auto_loop(args, log)
        except Exception as exc:
            log("[fatal] %s" % exc)
            return 1
        return 0

    while True:
        started = time.time()
        code = run_once(args, log)
        if args.repeat <= 0 or STOP:
            return code
        time.sleep(max(1.0, args.repeat - (time.time() - started)))


if __name__ == "__main__":
    sys.exit(main())
