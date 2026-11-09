# Qoder 打卡（本机 PC）

放到装了 Qoder 的 Windows PC 上运行。手机同一 Wi-Fi 打开固定地址。

## 用法

1. 本机先打开并登录 Qoder CN
2. 双击 `start.bat`（弹出 CMD 窗口，关窗口即停服务）
3. 手机浏览器打开：http://192.168.1.10:8787

两个按钮：

- **打开 · 打卡**
- **获取余额**（随时可查）

10:01 自动首打；当天没签则 11:00 补打。

## 要不要填 token

不用手填。`start.bat` 启动时会从本机 `%APPDATA%\QoderCN` 登录态自动读 token。

读不到时，先在这台电脑登录 Qoder，再重新双击 `start.bat`。

## 手机地址

固定 `http://192.168.1.10:8787`。PC 局域网 IP 变了，把 `config.json` 里的 `host` 改成新 IP。
