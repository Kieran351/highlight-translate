# 仓库贡献指南

## 项目结构与模块组织

本仓库目前采用“规格先行”的方式推进。`docs/specs/001-mvp/spec.md` 是 MVP 的权威规格；`docs/` 下的其他文件属于早期设计或调研记录，发生冲突时以正式规格为准。

- `src/content/`：选区处理和 Shadow DOM 页面界面。
- `src/background/`：Service Worker、消息校验、语言路由和流式请求。
- `src/options/`：API Key 设置和连接测试。
- `src/shared/`：消息契约、类型、提示词、错误及中文文案。
- `tests/`：外部行为测试；`icons/`：扩展图标；`dist/`：构建产物。

## 构建、测试与开发命令

仓库尚未创建 `package.json`。首次搭建工程时必须提供以下脚本：

- `npm install`：安装锁定版本的依赖。
- `npm run dev`：开发期间监听并重新构建扩展。
- `npm run build`：生成可由 Chrome 加载的 `dist/`。
- `npm test`：运行自动化行为测试。
- `npm run typecheck`：执行 TypeScript 类型检查。
- `npm run lint`：执行静态检查。

命令实际存在并成功运行前，不得在文档中宣称其可用。

## 编码风格与命名规范

使用 TypeScript 和原生 DOM API；MVP 不引入 UI 框架。采用两个空格缩进、分号和单引号。变量及函数使用 `camelCase`，类型使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`，文件名使用短小明确的 kebab-case，例如 `language-router.ts`。DeepSeek 特有逻辑必须位于提供商适配器之后。模型输出只能作为不可信纯文本渲染，禁止作为 HTML 执行。

## 测试规范

通过 Content Script 与 Service Worker 的长连接消息协议测试外部行为。Chrome API、存储、时间和 DeepSeek 流必须可替换。重点覆盖语言路由、5,000 字符限制、SSE 分片、取消、过期请求、超时、重试、部分结果及错误脱敏。测试文件命名为 `*.test.ts`。当前尚未确定测试框架和覆盖率门槛，首次搭建工程时应明确配置。选区定位、滚动、主题、复制和 Chrome 安装流程采用手动验收。

## 提交与 Pull Request 规范

当前没有 Git 历史可供推断。提交信息使用 Conventional Commits，例如 `feat: add selection trigger`。每次提交只处理一个 ticket。Pull Request 必须关联 ticket 或规格，概述行为变化，列出已执行的验证命令；界面变更需附截图。权限、存储或 API 请求内容发生变化时必须显式说明。

## 安全与配置

禁止提交 API Key 或用户选中的文本。API Key 只能存入受信任扩展上下文可访问的 `chrome.storage.local`，Content Script 不得接收密钥。发送给固定 DeepSeek HTTPS 主机的页面数据只能是完整选区，不得包含页面 URL、标题、DOM 或选区上下文。
