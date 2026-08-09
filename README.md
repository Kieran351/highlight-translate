# Highlight Translate

一个基于 Manifest V3 的个人 Chrome 划词翻译扩展。中文选区在本地原样展示，非中文或未知语言通过用户自己的 DeepSeek API Key 流式翻译为简体中文。

## 开发与验证

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

开发期间可运行 `npm run dev`，它会监听源码变化并重新生成 `dist/`。

## 安装

1. 运行 `npm run build`。
2. 打开 `chrome://extensions` 并启用“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本仓库的 `dist/` 目录。
4. 在自动打开的设置页保存 DeepSeek API Key，并单独测试连接。

之后在普通 HTTP/HTTPS 页面用鼠标选中文字，点击选区末端附近的圆形按钮即可。纯 URL、纯邮箱地址、纯数字或纯符号不会触发；超过 5,000 字符的选区会在卡片中显示本地错误。

## 安全边界

- API Key 只保存在 `chrome.storage.local`，Content Script 不会接收密钥。
- 仅非中文或语言未知的完整选区会发送到固定的 DeepSeek HTTPS 主机。
- 页面 URL、标题、DOM 和选区上下文不会随请求发送。
- 模型输出始终按不可信纯文本渲染，不作为 HTML 执行。

完整行为以 [MVP 规格](docs/specs/001-mvp/spec.md) 为准，发布前验证记录见 [MVP 验收记录](docs/validation/001-mvp.md)。
