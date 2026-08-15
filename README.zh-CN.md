# Highlight Translate

[English](README.md) | [简体中文](README.zh-CN.md)

不用离开当前网页，就能把选中的外语文本翻译为简体中文。Highlight Translate 是一个供个人使用的 Chrome 划词翻译扩展：中文选区在本地处理，其他选区使用你自己的 DeepSeek API Key 获取流式译文。

- 选中文字后，点击选区旁的小按钮即可翻译。
- 在紧凑的页面内卡片中阅读流式结果，并保留段落、换行和列表结构。
- 翻译完成、部分完成、本地完成或报错后，可拖动标题栏把卡片移到不遮挡正文的位置。
- API Key 不进入网页脚本：它只保存在受信任的 Chrome 扩展存储中，并由 Service Worker 使用。
- 只发送你选中的完整文本，不发送页面 URL、标题、DOM、前后文或富文本标记。
- 避免无意义的模型请求：中文选区会在本地检测并原样展示。

Highlight Translate 是一个需要自备 API Key、从 GitHub 本地安装的个人项目。它未发布到 Chrome 应用商店，不包含 API 额度，也不运行项目方维护的后端服务。

## 安装

你需要当前版本的桌面端 Google Chrome、带 npm 的 Node.js，以及一个用于翻译非中文文本的 DeepSeek Platform 账号。

```bash
git clone https://github.com/Kieran351/highlight-translate.git
cd highlight-translate
npm install
npm run build
```

然后在 Chrome 中加载构建产物：

1. 打开 `chrome://extensions`。
2. 启用右上角的**开发者模式**。
3. 点击**加载已解压的扩展程序**。
4. 选择项目中的 `dist/` 目录，而不是仓库根目录。
5. 请保持项目目录位置不变。移动或删除目录后，需要从新位置重新加载扩展。

拉取更新或修改源码后，重新运行 `npm run build`，在扩展卡片上点击**重新加载**，再刷新需要使用扩展的网页。

## 配置 DeepSeek API Key

1. 打开 DeepSeek 官方的 [API Keys 页面](https://platform.deepseek.com/api_keys)，登录并创建 Key。
2. 打开 Highlight Translate 设置页。首次安装时会自动打开；之后可点击浏览器工具栏中的扩展图标，或在 `chrome://extensions` 中进入**详情 → 扩展程序选项**。
3. 把 Key 粘贴到遮盖显示的 **API Key** 输入框，然后点击**保存**。
4. 可选：点击**测试连接**。保存与测试彼此独立，测试失败不会删除已保存的 Key。

不要把 API Key 粘贴到 AI 对话、源码、截图、Issue 或公开消息中。请只在扩展设置页中亲自输入。当前版本固定使用以下配置：

```text
接口：https://api.deepseek.com/chat/completions
模型：deepseek-v4-flash
目标语言：简体中文
```

Key 保存在 `chrome.storage.local`，并限制为受信任的扩展上下文访问。这适合个人、本机、自备 Key 的使用方式，但 Chrome 本地存储并不是操作系统级密钥保险箱。

## 使用方法

1. 在普通 HTTP 或 HTTPS 页面中，用鼠标或触控板选中自然语言文本。
2. 点击选区末端旁边的圆形**译**按钮。
3. 如果主要语言被识别为中文，卡片会在本地原样显示选区；非中文或未知语言选区会发送到 DeepSeek，并以流式方式返回简体中文译文。
4. 结果完成后可复制；可重试允许重试的错误；也可通过 **×**、`Esc` 或点击卡片外页面关闭卡片。
5. 请求停止后，如果卡片遮挡正文，可拖动标题栏移动卡片。

只有标题栏可以发起拖动；关闭按钮、结果区和操作按钮保留原本交互。指针需要移动约 4px 才会真正开始拖动，卡片会与视口四边保持约 8px 安全距离。首次有效拖动后，卡片相对视口固定，页面滚动时不再跟随原选区。自由位置可跨重试保留，但关闭卡片或产生新选区后会重置。首次请求或重试仍在流式进行时，拖动会被禁用。

## 当前支持

- 以本地解压方式安装的桌面端 Chrome Manifest V3 扩展。
- 顶层 HTTP/HTTPS 页面，包括本地开发服务器。
- 普通页面正文中的鼠标和触控板选区。
- 对完整选区只判断一种主要语言：使用 `chrome.i18n.detectLanguage`，并辅以 Unicode 兜底。
- 中文选区本地展示；非中文和未知语言选区使用 DeepSeek 流式翻译。
- 选区准入、5,000 字符上限、取消、过期结果隔离、超时、错误归一化、部分结果、重试、复制、深色模式和响应式卡片定位。
- 请求停止后的卡片拖动、视口边界限制、重试保位，以及锚定/自由位置两种滚动行为。
- 固定的简体中文界面和简体中文翻译目标。

## 当前不支持

- Chrome 内部页面、Chrome 应用商店、`file://` 页面、内置 PDF 页面和 iframe。
- 键盘选区、键盘快捷键、右键菜单翻译和工具栏弹窗。
- `input`、`textarea` 或 `contenteditable` 内的选区。纯 URL、邮箱、数字、标点、空白和 Emoji 也不会显示触发按钮。
- 触摸屏、触控笔和多指手势的专项支持与验收。
- DeepSeek 之外的提供商；接口地址、模型、目标语言和界面语言均不可配置。
- 翻译历史、缓存、云同步、账号系统、站点黑名单和扩展内暂停开关。
- 关闭卡片、产生新选区、刷新或导航后的卡片位置持久化。
- 同时展示多张翻译卡片，或把混合语言选区拆成多段分别翻译；一次只处理一个完整选区和一种主要语言路由。

## 隐私与数据流

Highlight Translate 按以下流程处理每次选区：

1. Content Script 捕获完整选中文本，并在封闭的 Shadow DOM 中展示页面界面。
2. Service Worker 校验请求，并在本地检测选区的主要语言。
3. 中文选区直接返回，不请求 DeepSeek。
4. 对非中文或未知语言选区，Service Worker 读取本地 Key，并把完整选中文本连同扩展内固定翻译指令发送到固定的 DeepSeek HTTPS 接口。
5. Service Worker 把纯文本流式事件返回给卡片。模型输出始终按不可信文本处理，绝不会作为 HTML 执行。

扩展不会发送页面 URL、标题、DOM、HTML/CSS、附近文本、选区上下文或富文本样式，也不会保存选区、译文、历史或缓存。远程翻译时，DeepSeek 仍会按照其自己的条款和隐私政策接收请求数据。

## 常见故障

### 没有出现“译”按钮

- 确认扩展已在 `chrome://extensions` 启用，然后点击**重新加载**并刷新网页。
- 确保当前是普通顶层 HTTP/HTTPS 页面，并使用鼠标或触控板完成选区。
- 确认选区不在可编辑区域内，并且至少包含一个自然语言字母。
- 纯 URL、邮箱、数字、符号、空白和 Emoji 会被主动忽略。

### 提示内容过长

把选区缩短到 5,000 个字符以内。过长选区仍会显示触发按钮，但会在本地被拒绝，不会发送给 DeepSeek。

### 提示需要 API Key

点击卡片中的**前往设置**，或点击工具栏图标，保存 DeepSeek API Key 后重试。中文选区在本地处理，不需要 Key。

### 连接测试或翻译失败

- 重新检查已保存的 Key，并确认 DeepSeek 账号具有访问权限和足够的余额或额度。
- 检查网络、代理、防火墙和 DeepSeek 服务状态。
- 类似 `401`/`403` 的响应会显示为 Key 无效；限流、额度、服务端、超时、流格式和网络故障都会转换成简短中文提示，不暴露提供商原始响应。
- 请注意：本仓库现有验收记录尚未证明真实 DeepSeek 成功；自动化测试使用的是受控 Provider 响应。

### 卡片无法拖动

等待当前翻译或重试停止，再使用鼠标/触控板主指针拖动标题栏。流式期间会主动冻结拖动，结果区和操作按钮也不是拖动热区。

### 重新构建后 Chrome 中没有变化

运行 `npm run build`，在 `chrome://extensions` 中重新加载 Highlight Translate，再刷新目标网页。本地文件变化后，Chrome 不会自动重新加载已解压扩展。

## 开发与验证

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:dist
```

`npm run dev` 会监听源码并重新构建 `dist/`。`npm run build` 会生成可加载扩展，并自动检查 Manifest 入口、权限范围、固定 DeepSeek 主机、意外本地文件、疑似 API Key 和控制台日志。`npm run verify:dist` 可对已有构建重复执行分发检查。

修改界面后，还应在 Chrome 中重新加载 `dist/`，实际验证选区、翻译卡片、滚动、窗口缩放、复制、关闭、重试和拖动流程。自动化检查不能证明真实提供商请求或浏览器交互已经端到端成功。

## 规格与验收

- [MVP 规格](docs/specs/001-mvp/spec.md)
- [可拖动翻译卡片规格](docs/specs/002-draggable-card/spec.md)
- [ADR 001：拖动后使用视口自由位置](docs/adr/001-draggable-card-position-mode.md)
- [项目术语表](docs/glossary.md)
- [MVP 验收记录](docs/validation/001-mvp.md)
- [拖动验收记录](docs/validation/002-draggable-card.md)

## 开源许可

MIT，详见 [LICENSE](LICENSE)。
