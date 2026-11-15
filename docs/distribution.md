# 分发

自用的扩展不经过商店，正式版本发布在 [GitHub Releases](https://github.com/ming-kang/Oshawott/releases)

`npm run package` 构建两端的正式版，在 `dist/` 下生成（`<版本>` 取自 `package.json`）：

| 文件 | 用途 |
|:-:|---|
| `oshawott-<版本>-chromium.zip` | 解压后在 Chromium 系浏览器中加载 |
| `oshawott-<版本>-firefox.xpi` | 未签名的 Firefox 扩展包 |
| `oshawott-<版本>-source.zip` | 已提交代码的源码包，Firefox 签名时提交给 AMO |

## Chromium 系

1. 从 Release 或 `dist/` 取得 zip，解压到一个长期保留的目录，例如 `%LOCALAPPDATA%\Oshawott\chromium`
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启开发者模式，点击“加载已解压的扩展程序”，选择该目录
3. 更新时用新 zip 覆盖该目录，再在扩展页重新加载 Oshawott

开发者模式需保持开启：从 Chrome 134 起，关闭它会停用所有已解压的扩展。manifest 固定了 `key`，扩展 ID 始终是 `nbemmciikpdicdifcdfapndnmmjcmdaa`，对话、文件和 API Key 都属于这个 ID，更新或移动目录不会丢失，“移除”扩展才会删除。

## Firefox

Oshawott 通过 addons.mozilla.org（AMO）unlisted 渠道签名（自动审核约 5 分钟）

扩展 ID 为 `oshawott@astralyn`，历史版本在[版本管理页](https://addons.mozilla.org/developers/addon/b56f8e683b5642fd9774/versions)

### 安装与更新

1. 从[最新 Release](https://github.com/ming-kang/Oshawott/releases/latest) 下载 `oshawott-<版本>-firefox.xpi`
2. 在 `about:addons` 的齿轮菜单中选择“从文件安装附加组件”。第一次安装前，先移除 `about:debugging` 中临时加载的 Oshawott

manifest 的 `update_url` 指向最新 Release 中的 `updates.json`，Firefox 通常每天检查一次，下载更高版本并校验 SHA-256；文件须带有 `oshawott@astralyn` 的 AMO 签名

### 准备凭据

登录 AMO [开发者中心](https://addons.mozilla.org/developers/)，开启两步验证并接受分发协议，然后在 [API 凭据](https://addons.mozilla.org/developers/addon/api/key/)页生成 JWT issuer 和 secret

本地签名时写进仓库根目录的 `.env`：

```sh
WEB_EXT_API_KEY=<JWT issuer>
WEB_EXT_API_SECRET=<JWT secret>
```

GitHub 发布需要在仓库 **Settings → Secrets and variables → Actions** 中添加同名的两个仓库 Secret

### 发布新版本

```sh
npm version patch   # 或 minor、major
git push --follow-tags
```

`npm version` 提高版本号、提交并创建 `v<版本>` tag

tag 触发 Release 工作流：先运行完整 CI，再核对 tag 和版本号、提交 AMO 签名，最后发布 Chromium zip、签名后的 Firefox xpi 和 `updates.json`

需要本地签名或排错时运行 `npm run sign:firefox`，产物在 `dist/signed/`

web-ext 参数接在 `--` 后，例如 `npm run sign:firefox -- --api-proxy=http://127.0.0.1:7890`。

### 排错

- **`Forbidden`**：凭据正确时，先到开发者中心接受新的条款
- **版本已存在**：提高版本号
- **等待超时**：web-ext 默认最多等校验 5 分钟、审核 15 分钟（`--approval-timeout` 可调），超时后 AMO 仍会继续审核；先等审核完成，不要重新提交同一版本
- **取回签名文件**：等待超时或删除了 `dist/signed/` 时，到版本管理页下载；也可以用 `.env` 的凭据生成 JWT，带请求头 `Authorization: JWT <token>` 请求 `https://addons.mozilla.org/api/v5/addons/addon/oshawott@astralyn/versions/v<版本>/`，再带同样的请求头下载返回的 `file.url`

### 说明

- **源码包**：构建产物经过 esbuild 打包压缩，AMO 要求附上源码和构建方法（`npm ci && npm run build`）
- **检查**：`npx web-ext@10 lint --self-hosted --source-dir dist/firefox` 按 AMO 的规则检查构建
- **不经过 AMO**：Developer Edition、Nightly、ESR 和 [unbranded 构建](https://wiki.mozilla.org/Add-ons/Extension_Signing#Unbranded_Builds)可以在 `about:config` 将 `xpinstall.signatures.required` 设为 `false`，直接安装未签名的 xpi
