# 路线图

本文记录功能计划与分发策略的决策。架构上的现状见 [架构](docs/architecture.md)，发布操作细节见 [开发](docs/development.md)。

## 当前状态与总原则

- 0.1.0：框架和界面已在真实 Chromium 和 Firefox 中跑通（开发构建的演示模型）；每个对话的 `/workspace` 持久文件区与 `fetch` 工具已接入，面板支持下载和删除，见 [文件与 fetch](docs/files.md)。
- **尚未用真实模型做端到端验证**（offscreen 文档里的 SSE 长流式、各提供商的跨域行为、alarm 心跳与 SW 休眠的交互......）

## 功能计划

参照 [Pi-Tab](https://github.com/aitimos/pi-tab) 1.2.0 ，列出 Oshawatt 需要的功能

>  Oshawatt 的单 Engine + chord + 按需注入结构优于 Pi-Tab，可以采用更优雅的方案实现需要的功能。

### 1. 运行中介入（steer / followUp）

pi-durable 原生支持，Pi-Tab 已在生产使用（`prompt` / `steer` / `followUp` / `queuedMessages` / `changeQueuedMessage`）：

- 提交时带 `whenBusy: "steer" | "followUp" | "reject"`（`SubmissionDraft`），队列策略由 `steeringMode` / `followUpMode` 控制（`"all" | "one-at-a-time"`）。
- 改动面：`Chat` 契约的 `send` 加 `whenBusy` 参数；面板在运行中把发送拆成「插队 / 排队」，并显示可编辑的待发送队列。Durable 包揽状态，只剩 UI。
- 价值：Agent 跑偏时可随时拉回，是体验分水岭。

### 2. 截图 + 图片输入

- Broker 调 `tabs.captureVisibleTab`，复用现有逐站 host 权限，新增 `page_screenshot` 工具。Pi-Tab 的页面内注入形态做不到整页截图，这是差异化优势。
- 配套：消息内容支持图片块（`UserInput`），面板支持粘贴 / 拖拽图片，需视觉模型。
- 目标组合：截图（视觉）+ `page_snapshot`（结构）+ 调试工具（运行态），覆盖复杂页面理解。

### 3. 附件上传

- 面板选择 / 拖入文件，写入对话的 `/workspace`（基于现有的持久文件区），模型用 `read` / Code Mode 处理。
- 对比 Pi-Tab：它只支持文本 / 图片且文件随内存 Linux 重建丢失；Oshawatt 是任意文件 + IndexedDB 持久。

### 4. 页面调试工具（`js_eval` / `get_console` / `get_network`）

- **`js_eval` 决策：MAIN world 执行**。用 `scripting.executeScript({ world: "MAIN" })`，拿到真实页面 JS 上下文，不受页面 CSP 限制，无新依赖；返回值须可序列化。Firefox 128+ 支持 `world: "MAIN"`。不采用 Pi-Tab 的 sval 解释器方案（隔离世界里解释执行，读不到页面全局状态，还多一个依赖）。标记 `replay: "unsafe"`。
- `get_console` / `get_network`：内容脚本 **attach 注入时即开始** hook console / fetch 持续捕获（而不是首次调用时），工具只是读取缓冲。标记 `replay: "safe"`。

### 5. 多 Agent / 跨标签页协作（低优先级）

- pi-durable 的 `submit` 明确允许工具向另一个对话提交任务（"a subagent's conversation is an ordinary one"），配合 `TargetDoc` + `Browser.openTab`，一个 `chat_open(url)` 工具即可建对话、开标签页、派任务，全程在 Engine 内完成。

## 分发方式

### Chromium：CWS unlisted

[官方文档](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)：

- **unlisted 与公开上架走同一套审核和政策**

- $5 一次性开发者注册费（按账号），Google 账号需开两步验证；新账号最多同时发布 2 个扩展。

- 审核多数几天完成，宽泛 host 权限等会拉长（[审核流程](https://developer.chrome.com/docs/webstore/review-process)）。

  更新 = 新 zip + 递增版本号 + 重新审核，审核期间旧版本可用；可勾选审核通过后暂不发布。

材料清单：128×128 图标；至少一张 1280×800 或 640×400 截图（`scripts/screenshots.mjs` 直接出）；<132 字符短描述与详细描述；单一用途声明；隐私政策 URL；EU trader 身份声明。

审核要点：

- `<all_urls>` 放在 `optional_host_permissions`、由用户手势逐站授权，是官方认可的低风险形态（不出现在安装警告、升级免重新授权、审核评级更低），但隐私实践页仍要逐项写理由。
- `wasm-unsafe-eval` 需说明：Code Mode 的 QuickJS 是本地打包的 wasm，非远程代码；全部代码随包分发，天然满足远程代码政策。

权限理由表（隐私实践页用，AMO 侧复用）：

| 权限 | 理由 |
|:-:|---|
| `tabs` | 列出和打开标签页，让 Agent 跨标签页工作 |
| `scripting` + `activeTab` | 用户授权后按需向页面注入内容脚本，执行快照 / 点击等页面工具 |
| `alarms` | 后台被回收后按定时任务唤醒，恢复未完成的运行 |
| `offscreen` | Engine 文档承载模型流式请求与 Code Mode Worker |
| `sidePanel` | 对话界面 |
| 静态 host 权限（五个模型 API 域名） | 用户配置 API key 后向模型服务发请求 |
| `optional_host_permissions`（`<all_urls>`） | 用户逐站授权后页面工具才能在该站点工作；安装时不请求任何站点 |
| `unlimitedStorage`（如添加） | 对话记录与对话文件持久保存在本机 IndexedDB |

### Firefox：AMO 自分发签名

- CI 里 `web-ext sign --channel unlisted`：上传 AMO 自动签名（通常几分钟、无人工审核），签名的 `.xpi` 挂 GitHub Release。
- 配 `browser_specific_settings.gecko.update_url` 指向自托管的 update manifest（GitHub Pages 放 JSON），Firefox 端获得真自动更新——体验反而好于 Chromium 端。
- 待办：换掉占位 ID `oshawatt@example.org`；填 AMO 要求的 `data_collection_permissions`（基本不收集数据，声明简单）；AMO API key 进 CI secret。

### 过渡期与通用项

- 当前过渡：GitHub zip + 加载已解压（Chromium）。
- **manifest 固定 `"key"`**：已解压扩展的 ID 默认从解压路径推导，而 IndexedDB 挂在 `chrome-extension://<id>` 下——ID 一变，全部对话记录与 API key 失联。固定 `key` 后 ID 与路径无关，公钥提交进仓库。这件事现在就该做。
- 面板内版本检查：调 GitHub releases API，有新版本提示用户（CWS unlisted 上线前是 Chromium 端唯一的更新通道）。
- 写 PRIVACY.md：key 只存本机 IndexedDB、逐站授权、仅访问模型 API 和用户已授权的 URL。两端商店的隐私材料都从这里复用。
- release 自动化：参考 Pi-Tab `scripts/release.mjs`（conventional commits 推版本号），加双端 zip 与 xpi 签名两步。

## 参考来源

- [Chrome Web Store 分发与可见性](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)（unlisted 定义、同一审核流程）
- [Chrome Web Store 审核流程](https://developer.chrome.com/docs/webstore/review-process)（时长与加严因素）
- [隐私实践标签页](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)（权限理由、远程代码声明）
- [注册开发者账号](https://developer.chrome.com/docs/webstore/register)（$5 费用）
- [宽泛 host 权限的审核成本](https://mv3-extension.com/manifest-v3-architecture-extension-lifecycle/host-permissions-and-site-access/the-review-cost-of-all-urls-and-broad-host-patterns/)（optional 权限的低风险形态）
- [Pi-Tab](https://github.com/aitimos/pi-tab)（功能面对照；steer / 队列的生产验证）
