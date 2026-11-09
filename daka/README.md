# Qoder 打卡（本机 PC）

Node 零依赖服务，跑在 Windows 工作站上，手机同一 Wi-Fi 打开局域网地址即可点按钮。

## 用法

1. 双击 `start.bat`（弹出 CMD 窗口，关窗口即停服务）
2. 窗口会打印 `手机请打开: http://<本机局域网IP>:8787`，手机访问这个地址

两个按钮：

- **打开 · 打卡**
- **获取余额**（随时可查）

10:01 自动首打；当天没签则 11:00 补打。服务没启动时不会补打卡。

## 要不要填 token

不用手填。启动时按三个来源依次尝试：

1. Qoder CN CLI 登录态 `~/.qoder-cn/.auth/user`（AES-128-CBC，key/iv 取 `machine_id` 前 16 字符）
2. Qoder CN IDE 登录态（`%APPDATA%\QoderCN` 的 `state.vscdb` + DPAPI/Chromium 解密）
3. 个人访问令牌：环境变量 `QODERCN_PERSONAL_ACCESS_TOKEN`，或本目录 `pat.txt`（已 gitignore）

PAT 路线会调 `POST /api/v1/jobToken/exchange` 换 Bearer；换来的 job token 只有 24 小时有效，
每次打卡/查余额前会看到期时间，提前 1 小时自动重换，所以服务可以一直开着不动。
令牌失效时到 qoder.com.cn 控制台「设置 → 个人访问令牌」重新生成，覆盖 `pat.txt` 后重启服务。

token 与 PAT 只在内存和 `config.json` / `pat.txt` 里，这两个文件都不进 git，日志里只留掩码。

## 手机地址

局域网 IP 由程序自动检测（挑第一个非回环私有 IPv4），不用写死。
仍想用固定地址或 IP 检测不合适用 `DAKA_HOST=192.168.1.110 node server.js` 覆盖。
