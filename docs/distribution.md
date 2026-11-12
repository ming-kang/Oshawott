# 分发

自用的扩展不经过商店。`npm run package` 构建两端的正式版，在 `dist/` 下生成（`<版本>` 取自 `package.json`）：

| 文件 | 用途 |
|---|---|
| `oshawott-<版本>-chromium.zip` | 解压后在 Chromium 系浏览器中加载 |
| `oshawott-<版本>-firefox.xpi` | 未签名的 Firefox 扩展包 |
| `oshawott-<版本>-source.zip` | 已提交代码的源码包，Firefox 签名时提交给 AMO |

## Chromium 系

1. 把 zip 解压到一个长期保留的目录，例如 `%LOCALAPPDATA%\Oshawott\chromium`
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启开发者模式，点击“加载已解压的扩展程序”，选择该目录
3. 更新时用新 zip 覆盖该目录，再在扩展页重新加载 Oshawott

开发者模式需保持开启：从 Chrome 134 起，关闭它会停用所有已解压的扩展。manifest 固定了 `key`，扩展 ID 始终是 `nbemmciikpdicdifcdfapndnmmjcmdaa`，对话、文件和 API Key 都属于这个 ID，更新或移动目录不会丢失，“移除”扩展才会删除。

## Firefox

Firefox 正式版只安装 Mozilla 签名的扩展。Oshawott 走 addons.mozilla.org（AMO）的 unlisted 渠道：不公开上架，自动审核约 5 分钟。扩展已在 AMO 登记，ID 为 `oshawott@astralyn`，签过的版本都在[版本管理页](https://addons.mozilla.org/developers/addon/b56f8e683b5642fd9774/versions)。AMO 上的状态显示“incomplete”，只是因为没有上架资料，不影响签名。

### 准备凭据

登录 AMO [开发者中心](https://addons.mozilla.org/developers/)，开启两步验证并接受分发协议，然后在 [API 凭据](https://addons.mozilla.org/developers/addon/api/key/)页生成 JWT issuer 和 secret，写进仓库根目录的 `.env`（已被 git 忽略）：

```sh
WEB_EXT_API_KEY=<JWT issuer>
WEB_EXT_API_SECRET=<JWT secret>
```

### 发布新版本

1. 提高 `package.json` 的 `version` 并提交：AMO 每个版本号只签一次，源码包取自 `HEAD`
2. 运行 `npm run sign:firefox`：打包后把 `dist/firefox` 和源码包提交给 AMO，审核通过后下载到 `dist/signed/b56f8e683b5642fd9774-<版本>.xpi`。web-ext 的参数接在 `--` 后，例如 `npm run sign:firefox -- --api-proxy=http://127.0.0.1:7890`
3. 在 `about:addons` 的齿轮菜单中选择“从文件安装附加组件”。已安装时原地升级，数据保留；第一次安装前先移除 `about:debugging` 中临时加载的 Oshawott

manifest 没有 `update_url`，Firefox 不会自动检查更新，新版本都按这三步手动安装。

### 排错

- **`Forbidden`**：凭据正确时，先到开发者中心接受新的条款
- **版本已存在**：提高版本号
- **等待超时**：web-ext 默认最多等校验 5 分钟、审核 15 分钟（`--approval-timeout` 可调），超时后 AMO 仍会继续审核
- **取回签名文件**：等待超时或删除了 `dist/signed/` 时，到版本管理页下载；也可以用 `.env` 的凭据生成 JWT，带请求头 `Authorization: JWT <token>` 请求 `https://addons.mozilla.org/api/v5/addons/addon/oshawott@astralyn/versions/v<版本>/`，再带同样的请求头下载返回的 `file.url`

### 说明

- **源码包**：构建产物经过 esbuild 打包压缩，AMO 要求附上源码和构建方法（`npm ci && npm run build`）。有未提交的改动时，`npm run package` 会提示
- **数据收集声明**：AMO 要求新扩展声明 `data_collection_permissions`。Oshawott 会把页面内容和标签页的地址、标题发给所选的模型服务，因此声明了 `websiteContent` 和 `browsingActivity`，安装时 Firefox 会列出。这项声明从 Firefox 140 起支持，所以最低版本是 140
- **检查**：`npx web-ext@10 lint --self-hosted --source-dir dist/firefox` 按 AMO 的规则检查构建。唯一的警告是 Android 版 Firefox 142 才支持数据收集声明：Oshawott 依赖 Android 上没有的侧边栏，所以不声明 `gecko_android`
- **不经过 AMO**：Developer Edition、Nightly、ESR 和 [unbranded 构建](https://wiki.mozilla.org/Add-ons/Extension_Signing#Unbranded_Builds)可以在 `about:config` 把 `xpinstall.signatures.required` 设为 `false`，直接安装未签名的 xpi。`about:debugging` 临时加载的扩展在重启后失效，只适合开发
