# 油猴脚本

这个目录专门放 Tampermonkey / Violentmonkey / Quax 的用户脚本，云端可以直接在 GitHub 网页上编辑。

约定：

- 一个脚本一个 `.user.js` 文件，文件名小写短横线，比如 `bilibili-cleaner.user.js`。
- 头部 `==UserScript==` 元数据块必填，`@version` 每次改动 +1，管理器靠它判断有没有更新。
- `_template.user.js` 是空白模板，复制改名再写。
- 脚本里不要写账号 cookie、token、私人 Key；需要私密配置走 `GM_getValue`，值只留在本机。

导入方式：

1. 浏览器装 Tampermonkey（或 Violentmonkey）。
2. 打开脚本的 raw 地址，管理器会弹出「安装用户脚本」；或复制内容后在管理器里「新建 → 粘贴 → 保存」。
3. 想跟随云端更新：在管理器里对该脚本用「更新 URL」指向仓库 raw 地址即可。
