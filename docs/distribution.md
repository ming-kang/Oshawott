# 分发

自用的扩展不经过商店。`npm run package` 构建两端的正式版，并在 `dist/` 下生成：

| 文件 | 用途 |
|---|---|
| `oshawott-<版本>-chromium.zip` | 解压后在 Chromium 系浏览器中加载 |
| `oshawott-<版本>-firefox.xpi` | 未签名的 Firefox 扩展包，`npm run sign:firefox` 把同样的内容交给 AMO 签名 |
| `oshawott-<版本>-source.zip` | 已提交代码的源码包（`git archive HEAD`），签名时一并提交给 AMO |

版本号取自 `package.json`。发布新版本前先提高它：Firefox 只把版本号更高的包当作更新，AMO 也不接受重复的版本号。

## Chromium 系（Chrome、Edge、Brave 等）

1. 把 zip 解压到一个长期保留的目录，例如 `%LOCALAPPDATA%\Oshawott\chromium`，浏览器每次都从这里读取扩展
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启开发者模式，点击“加载已解压的扩展程序”，选择该目录

- **开发者模式**：要一直开启。从 Chrome 134 起，关闭开发者模式会停用所有已解压加载的扩展
- **更新**：用新 zip 的内容覆盖同一目录，再在扩展页点击 Oshawott 的重新加载按钮
- **数据**：manifest 中固定了 `key`，扩展 ID 始终是 `nbemmciikpdicdifcdfapndnmmjcmdaa`，对话、文件和 API Key 都属于这个 ID。更新或移动目录不会丢失数据；“移除”扩展会删除这些数据
- **CRX**：Windows 和 macOS 上的 Chrome 只从 Chrome 应用商店安装 `.crx`，自己打包的需要配置企业策略，自用没有必要

## Firefox

Firefox 正式版只安装 Mozilla 签过名的扩展（自签名证书无效）。Oshawott 走 addons.mozilla.org（AMO）的 unlisted 渠道：每个版本由自动审核签名，大约 5 分钟，扩展不会公开上架，签好的 xpi 自己保存和安装。

扩展已在 AMO 登记：ID `oshawott@astralyn`，AMO 标识 `b56f8e683b5642fd9774`，版本和签名文件在[版本管理页](https://addons.mozilla.org/developers/addon/b56f8e683b5642fd9774/versions)。AMO 上的扩展状态显示为“incomplete”，只说明没有公开上架的资料，不影响签名。

### 准备凭据

1. 登录[开发者中心](https://addons.mozilla.org/developers/)。AMO 要求开发者账号开启两步验证，并接受分发协议
2. 在 [API 凭据](https://addons.mozilla.org/developers/addon/api/key/) 页生成 JWT issuer 和 secret，写进仓库根目录的 `.env`（已被 git 忽略）：

   ```sh
   WEB_EXT_API_KEY=<JWT issuer>
   WEB_EXT_API_SECRET=<JWT secret>
   ```

### 发布新版本

1. 提高 `package.json` 中的 `version` 并提交：AMO 对每个版本号只签一次，提交的源码包取自 `HEAD`
2. 运行 `npm run sign:firefox`：构建打包后，用 `web-ext sign` 把 `dist/firefox` 和源码包提交到 unlisted 渠道，审核通过后下载签好的 xpi。需要代理时加上 web-ext 的参数，例如 `npm run sign:firefox -- --api-proxy=http://127.0.0.1:7890`
3. 签好的 xpi 保存为 `dist/signed/b56f8e683b5642fd9774-<版本>.xpi`，重新打包不会清掉它。在 `about:addons` 的齿轮菜单中选择“从文件安装附加组件”，或把文件拖进 Firefox 窗口。已安装旧版本时即原地升级，数据保留；第一次安装前先移除 `about:debugging` 中临时加载的 Oshawott

### 重新下载已签名的版本

签名文件一直保存在 AMO 上，`dist/signed/` 删除了也能取回（同一版本号不能再签名一次）：

- **网页**：登录 AMO，打开[版本管理页](https://addons.mozilla.org/developers/addon/b56f8e683b5642fd9774/versions)，点对应版本的文件链接
- **API**：用 `.env` 中的凭据生成 JWT，请求 `GET https://addons.mozilla.org/api/v5/addons/addon/oshawott@astralyn/versions/v<版本>/`（请求头 `Authorization: JWT <token>`），再带同样的认证下载返回的 `file.url`

### 说明

- **源码包**：构建产物经过 esbuild 打包和压缩，AMO 要求同时提供源码和构建方法（`npm ci && npm run build`）。有未提交的改动时，`npm run package` 会提示
- **审核超时**：web-ext 默认最多等待校验 5 分钟、审核 15 分钟（`--approval-timeout` 可调）。超时后签名仍在 AMO 上继续，通过后按“重新下载已签名的版本”取回
- **常见错误**：凭据正确却返回 `Forbidden`，先到开发者中心接受新的条款；提示版本已存在，提高版本号
- **数据收集声明**：AMO 要求新扩展声明 `data_collection_permissions`。Oshawott 会把页面内容和标签页的地址、标题发给用户选择的模型服务，所以声明了 `websiteContent` 和 `browsingActivity`，安装时 Firefox 会列出。Firefox 140 起才支持这项声明，因此最低版本是 140
- **更新检查**：manifest 没有 `update_url`，Firefox 不会自动检查更新，新版本手动安装
- **检查**：`npx web-ext@10 lint --self-hosted --source-dir dist/firefox` 按 AMO 的规则检查构建。目前没有错误，只有 1 个警告：数据收集声明在 Firefox for Android 142 才支持。Oshawott 依赖 Android 上没有的侧边栏，Mozilla 建议确认 Android 可用后才设置 `gecko_android`，所以保留这个警告。Pi-AI 中只在 Node 里使用的 `import()`（读文件、环境变量和 AWS SDK）在构建时换成直接失败（`scripts/lib/pi-ai.mjs`），在浏览器中行为不变

### 不经过 AMO

- **未签名安装**：Developer Edition、Nightly、ESR 和 Mozilla 为扩展开发者提供的 [unbranded 构建](https://wiki.mozilla.org/Add-ons/Extension_Signing#Unbranded_Builds)中，可以在 `about:config` 把 `xpinstall.signatures.required` 设为 `false`，再安装 `dist/oshawott-<版本>-firefox.xpi`
- **临时加载**：`about:debugging` 中加载的扩展在 Firefox 重启后失效，只适合开发
