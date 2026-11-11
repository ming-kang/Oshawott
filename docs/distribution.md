# 分发

自用的扩展不经过商店。`npm run package` 构建两端的正式版，并在 `dist/` 下生成：

| 文件 | 用途 |
|---|---|
| `oshawott-<版本>-chromium.zip` | 解压后在 Chromium 系浏览器中加载 |
| `oshawott-<版本>-firefox.xpi` | 未签名的 Firefox 扩展包：交给 AMO 签名，或装进允许未签名扩展的 Firefox |
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

Firefox 正式版和 Beta 版只安装 Mozilla 签过名的扩展，自签名证书无效，`xpinstall.signatures.required` 在这两个版本中也不起作用。因此有两种方式。

### AMO 不公开签名（正式版）

提交到 addons.mozilla.org 的 unlisted 渠道：由自动审核签名，扩展不会出现在 AMO 上，签好的 xpi 自己保存和安装。

1. 登录 [AMO 开发者中心](https://addons.mozilla.org/developers/)，首次使用时接受分发协议，在 [API 凭据](https://addons.mozilla.org/developers/addon/api/key/) 页生成 JWT issuer 和 secret，写进仓库根目录的 `.env`（已被 git 忽略）：

   ```sh
   WEB_EXT_API_KEY=<JWT issuer>
   WEB_EXT_API_SECRET=<JWT secret>
   ```

2. 运行 `npm run sign:firefox`：先执行 `npm run package`，再用 `web-ext sign` 把 `dist/firefox` 和源码包提交到 unlisted 渠道，等待自动审核后下载签好的 xpi。需要代理时在后面加上 web-ext 的参数，例如 `npm run sign:firefox -- --api-proxy=http://127.0.0.1:7890`
3. 签好的 xpi 保存在 `dist/signed/`（重新打包不会清掉它）。在 `about:addons` 的齿轮菜单中选择“从文件安装附加组件”，或把文件拖进 Firefox 窗口

- **源码包**：构建产物经过 esbuild 打包和压缩，AMO 要求同时提供源码和构建方法（`npm ci && npm run build`）。源码包取自 `HEAD`，所以先提交改动；有未提交的改动时，`npm run package` 会提示
- **审核超时**：web-ext 默认最多等待校验 5 分钟、审核 15 分钟（`--approval-timeout` 可调）。超时后签名仍会在 AMO 上继续，审核通过后可以在开发者中心该版本的页面下载
- **扩展 ID**：`oshawott@astralyn`，第一次签名后归属于签名的 AMO 账号
- **数据收集声明**：AMO 要求新扩展声明 `data_collection_permissions`。Oshawott 会把页面内容和标签页的地址、标题发给用户选择的模型服务，所以声明了 `websiteContent` 和 `browsingActivity`，安装时 Firefox 会列出。Firefox 140 起才支持这项声明，因此最低版本是 140
- **更新**：提高版本号后重新签名，安装新的 xpi 即原地升级，数据保留。manifest 没有 `update_url`，Firefox 不会自动检查更新
- **检查**：`npx web-ext@10 lint --self-hosted --source-dir dist/firefox` 按 AMO 的规则检查构建。目前没有错误；4 个警告不影响签名：数据收集声明在 Firefox for Android 142 才支持，以及打包进来的依赖中参数为变量的 `import()`

### 未签名安装（Developer Edition、Nightly、ESR）

在 `about:config` 中把 `xpinstall.signatures.required` 设为 `false`，再按上面第 3 步安装 `dist/oshawott-<版本>-firefox.xpi`。不需要 AMO 账号，但只有这几个版本和 Mozilla 为扩展开发者提供的 [unbranded 构建](https://wiki.mozilla.org/Add-ons/Extension_Signing#Unbranded_Builds)支持。

`about:debugging` 中的临时加载在 Firefox 重启后失效，只适合开发。
