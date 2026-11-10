# 已知限制

## 尚未验证

- 第三方公网模型服务的兼容性；自动端到端测试使用本地 OpenAI 兼容服务，Anthropic Messages 与 OpenAI Responses 的发现路径有单元覆盖。
- 账号登录对真实提供商的端到端流程：自动测试用模拟流程覆盖 Engine 会话、Panel 界面、刷新与轮换，但没有用真实账号验证各家的 token 端点是否接受扩展来源的请求（`Origin: chrome-extension://…`，以及浏览器不允许改写的 `User-Agent`）。
- 站点和自定义模型授权弹窗的完整人工流程（允许、拒绝、撤销授权）；自动测试覆盖权限请求及拒绝后的状态保护。
- Firefox 关闭侧边栏后的长时间任务、事件页被回收后的文件操作，以及 chord 心跳对 Chromium Service Worker 休眠的影响。

## 当前限制

- 账号登录只支持不需要本地回调的方式；新版 OpenAI「Sign in with ChatGPT」、OpenRouter 与 Radius 的 OAuth 不可用（API Key 仍可用），GitHub Copilot 只支持 github.com，不支持 Enterprise 域名。
- 进行中的登录保存在 Engine 内存里：Engine 被回收或浏览器重启后需要重新开始，已完成的登录不受影响。
- Panel 只显示 Durable view 窗口内的记录，不能加载更早的历史。
- fetch 不带登录态，也不跟随重定向。
- 页面工具只处理标签页的顶层文档，不进入 iframe 和 shadow DOM；也不读取页面脚本的变量、Console 或网络请求。
- 移除对话后，Durable 中的原始对话记录仍会保留（pi-durable 1.5 没有删除接口）。
- 不会定期清理临时文件。
- Chromium 的 offscreen 文档空闲时不会自动关闭。
