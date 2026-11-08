# 架构

Oshawott 由四个角色组成，彼此通过 chord 远程对象通信。

## 角色

| 角色 | 职责 | Chromium | Firefox |
|:-:|---|:-:|:-:|
| **Engine** | Durable Harness、模型、工具、持久状态 | offscreen `engine.html` | 事件页 `background.js` |
| **Broker** | 标签页、脚本注入、alarm | Service Worker | 与 Engine 同在事件页 |
| **Panel** | 对话与文件界面 | side panel | sidebar |
| **Page** | 页面工具的 DOM 实现 | 按需注入 `page.js` | 同左 |

角色代码两端共用，浏览器差异只出现在 `src/entries/`。Chromium 用 offscreen 文档运行 Engine，是因为那里能开 Worker、能跑长时间的流式请求；但 offscreen 文档只能用 `runtime` API，所以浏览器操作都交给 Broker 做。

## 连接

| 连接 | 建立方式 | 对象 |
|:-:|---|:-:|
| Panel → Engine | Port `oshawott:panel`，断开后自动重连 | `Workspace`、`Chat({id})` |
| Engine → Broker | 需要浏览器能力或被 alarm 唤醒时，Port `oshawott:broker` | `Browser` |
| Engine → Page | Broker 注入脚本后，页面连接 Port `oshawott:tab` | `Page({tabId})` |

- 所有契约都在 `src/contracts/`。
- 只有 Engine 注册 `runtime.onConnect`，并根据 Port 名称、发送方和 frame 校验连接。
- 后台由两条一次性消息唤醒：`ensureEngine` 和 `wakeBroker`。
- `src/link/port-link.ts` 负责 Chromium Port 的 JSON/base64 帧，缓存监听器装好之前到达的消息，并报告关闭。

## 状态

| 存储 | 内容 |
|:-:|---|
| IndexedDB `oshawott` | Durable 对话；`WorkspaceDoc`（对话列表、默认模型与思考档位、待删除的文件）；`ProvidersDoc`（非秘密的自定义服务与自定义模型）；`TargetDoc`（每个对话的目标标签页） |
| IndexedDB `oshawott-files` | 对话文件，见[文件与 Fetch](files.md) |
| IndexedDB `oshawott-models` | Pi-AI `ModelsStore` 保存的已发现模型目录；自定义覆盖在读取时应用，不改写原始目录 |
| IndexedDB `oshawott-credentials` | API key，只有 Engine 读写 |
| Panel `localStorage` | 主题、语言 |

Panel 用 `self.follow` 直接观察 Durable 状态，自己不另存一份对话。Provider 摘要由 Engine 从运行时注册表派生，只包含配置状态和模型能力，不包含 Key。自定义 Profile 与发现目录分别在 Engine 启动、恢复模型工作前加载。

## 生命周期

1. Panel 发送 `ensureEngine`，然后连接 Engine。
2. Engine 拿到 Web Lock `oshawott:engine` 后，打开存储和 Harness，执行 `resume()`，再接受 Panel 连接。
3. 页面工具第一次用到某个标签页时，Engine 让 Broker 注入 Page，等页面的 Port 连上。

Durable 通过 `onWake` 安排唤醒，Broker 用 alarm `oshawott:wake` 在后台被回收后叫醒 Engine。运行期间每 60 秒设一次心跳 alarm；有更早的定时任务就按定时任务来；没有运行也没有定时任务时清除 alarm。

重启后从最后一次提交继续。工具执行前会先记录调用；中断后只有 `replay: "safe"` 的调用会重新执行，`unsafe` 的调用返回 `interrupted`，避免重复产生副作用。

## 边界

- `Workspace`、`Chat` 只对 Panel 开放；`Browser`、`Page` 只对 Engine 开放。
- Page 运行在 isolated world：能读写 DOM，看不到页面脚本的变量和函数；不向页面主世界注入代码。元素 `ref` 用 `WeakRef` 保存在页面内存里，格式为 `<页面加载>.<快照代数>.e<n>`。新快照、整页加载或离开快照时的 URL（不含 hash，返回原 URL 也不恢复）后旧 `ref` 一律报错，不会命中其他元素。
- 页面进入往返缓存（bfcache）时主动关闭 Port：Firefox 不会关闭冻结页面的 Port，否则 Engine 会继续调用旧文档直到超时。页面恢复后，下一次 attach 会重新连接，同一文档的 ref 不变。
- 页面工具的输出有固定上限（`src/page/limits.ts`）：快照元素数、`page_inspect` 的元素数与 HTML 长度、属性值、表格行列和列表项。密码框的 `value`（含 `<template>` 内）会被替换为 `[redacted]`。
- 页面工具规格只在 `src/tools/page-tools.ts` 定义：只读的标 `safe`，会改动页面的标 `unsafe`。
- Code Mode 在 Worker 的 QuickJS WASM 中运行，只能通过工具访问当前对话的文件，没有 shell。
- 普通构建只为内置模型 API 域名声明静态权限；自定义服务按 Base URL 的 origin 请求按需权限，不默认扩大为 `<all_urls>`。其他站点需要用户授权；开发构建额外声明 `<all_urls>`，供自动测试使用。
- API key 只会进入 Engine 的 `CredentialStore`。Panel 状态只包含是否已配置；发现错误不携带响应体、请求头或 Key。Panel 从不插入原始 HTML：Markdown 先解析再构建 DOM，链接只允许 `http(s):` 和 `mailto:`。
