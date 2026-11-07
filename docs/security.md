# 安全

本篇是扩展的安全边界。身份在连接层如何标记、校验与各对象的授权规则见 [契约与连接](contracts.md)。

- API key 从面板经 `setApiKey` 写入，此后只在 Engine 文档里使用，面板只能看到“是否已配置”。key 以明文保存在扩展自己的 IndexedDB 中。
- 面板不会把模型或网页返回的 HTML 插进界面：普通文本用文本节点，Markdown 由解析树逐个生成元素，链接只允许 `http(s):` 和 `mailto:`，并以 `noopener noreferrer` 在新标签页打开。
- 文件只在扩展的私有存储里，不能访问宿主机文件。不同对话的文件互相隔离；面板读取和删除拒绝规范化后位于 `/workspace/` 外的路径。下载使用 octet-stream Blob，不在扩展内渲染文件内容。
- fetch 在请求前检查 host 权限，不跟随重定向，不隐式携带浏览器 cookie 或登录态。网络目标包括模型 API 与用户已授权的 URL，见 [文件与 fetch](files.md)。
- 内容脚本运行在隔离世界（isolated world），只在 Engine 需要时注入，不在清单里声明任何站点。
- 页面工具的元素引用（`ref`）只存在内容脚本内存里的 `WeakRef` 表中，页面脚本读不到也伪造不了（见 [工具](tools.md#页面工具)）。
- 权限：`tabs`、`scripting`、`activeTab`、`alarms`，Chromium 另加 `offscreen`、`sidePanel`。host 权限只包括五个模型 API 的域名；`<all_urls>` 只出现在 `optional_host_permissions` 中，由用户在面板里按站点授权。开发构建为方便自动测试会直接带上 `<all_urls>`。
