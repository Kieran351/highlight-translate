# 划词翻译产品对混合语言选区的处理调研

调研日期：2026-08-01

## 1. 调研问题

本次调研聚焦以下行为：

1. 选中非中文内容时，产品如何确定源语言和目标语言。
2. 选中纯中文内容、目标语言又是中文时，产品会原样显示、反向翻译，还是不处理。
3. 选中中英混合内容时，产品会整段翻译，还是仅翻译其中的外语片段。

证据按以下等级区分：

- **官方明确**：官方帮助、官方产品页或官方 API 文档直接说明。
- **源码可确认**：官方或产品作者公开源码能直接证明请求结构或路由逻辑。
- **推断**：可以从请求结构或相邻能力合理推导，但产品没有公开承诺最终 UI 行为。
- **无法验证**：官方资料和公开源码均未说明，本次不把它写成已确认事实。

## 2. 核心结论

市面主流产品并没有统一的“混合文本规则”，但交互和请求模型高度相似：

1. **通常把完整选区作为一个翻译单元**，而不是先在浏览器端按中英文字符切片。
2. **通常为整个选区检测一个源语言，再翻到一个目标语言**。Google 与 Microsoft 的公开请求结构都是这种模式。
3. **传统翻译模型对单句中英混合并不稳定**。Microsoft 官方明确说明，混合语言句子可能被错误或不完整地翻译，并建议拆成单语片段。
4. **纯目标语言文本的行为并不统一**：Easydict、TransOver 一类工具提供反向翻译；其他产品可能仍提交翻译、原样返回或不触发，但多数产品没有公开承诺。
5. **没有发现代表性产品在官方资料中承诺“自动只翻译选区里的外语片段，同时逐字保留已有中文”**。这更适合由大模型通过明确提示词实现，而不是依赖传统的单一源语言检测。

因此，本项目可以沿用主流产品的“整段选区作为一次请求”，但利用大模型提供更清晰的混合文本语义：**保留选区中的现有中文，将需要理解的非中文内容翻译为简体中文，并保持整句自然连贯**。

## 3. 产品逐项调研

### 3.1 Google Chrome 选区翻译

**已确认行为**

- Chrome 官方帮助说明，用户选中网页中的一段内容后，可以使用“Translate selection to [Language]”翻译整个选区，并在弹层中修改目标语言。证据：[Chrome 帮助](https://support.google.com/chrome/answer/173424?hl=en-u)。
- Chromium 源码把完整的 `selection_text` 直接传给一次 partial translate 调用；其请求结构只有一段选区文本、一个可选源语言和一个目标语言。证据：[右键菜单实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/renderer_context_menu/render_view_context_menu.cc)、[PartialTranslateManager 请求结构](https://chromium.googlesource.com/chromium/src/+/HEAD/components/translate/content/browser/partial_translate_manager.h)。
- Google Cloud Translation 的语言检测对一次请求只返回一个最可能语言，反映了传统翻译 API 的“整段文本对应一个主语言”模型。该 API 不等同于 Chrome 内部服务，只用作相邻官方技术证据。证据：[DetectLanguageResponse](https://docs.cloud.google.com/translate/docs/reference/rest/v3/DetectLanguageResponse)。

**对混合文本的结论**

- **源码可确认**：Chrome 客户端不会先把中英混合选区按语种切片后分别请求，而是提交完整选区。
- **无法验证**：Google 没有公开承诺服务端会只翻译外语片段、保留中文片段，最终输出取决于其翻译服务。

**对纯中文文本的结论**

- **无法验证**：没有找到 Google 官方资料承诺目标语言为中文时一定原样显示、反向翻译或跳过请求。

### 3.2 Microsoft Edge / Microsoft Translator

**已确认行为**

- Edge 官方资料说明可以选择网页中的特定文本，通过右键菜单翻译选区。证据：[Edge Translate 功能页](https://www.microsoft.com/en-us/edge/features/translate)、[Edge TranslateEnabled 策略](https://learn.microsoft.com/zh-cn/deployedge/microsoft-edge-policies/translateenabled)。
- Microsoft Translator 在未提供 `from` 时会对每个输入自动检测一个源语言，响应中也为该输入返回一个 `detectedLanguage`。证据：[Translator Translate API](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate?tabs=url)。
- Microsoft 官方已知问题明确指出：Text Translation API 不支持单句混合语言输入，可能产生错误或不完整的翻译；官方建议指定源语言、移除混合句，或拆成单语片段。证据：[Azure Translator 已知问题](https://learn.microsoft.com/en-us/azure/ai-services/translator/reference/known-issues)。

**对混合文本的结论**

- **官方明确（Translator 服务）**：传统 Microsoft Translator 不能可靠处理单句混合语言。
- **推断（Edge 产品）**：Edge 选区翻译大概率也遵循整段输入和单一源语言检测，但微软没有公开确认 Edge 当前版本与上述 API 使用完全相同的处理链路。

**对纯中文文本的结论**

- Microsoft FAQ 说明，即使源语言与目标语言相同且内容未改变，提交字符仍会计费，证明服务端允许同语言请求。证据：[Translator FAQ](https://learn.microsoft.com/en-us/azure/ai-services/translator/faq)。
- **无法验证（Edge 产品）**：Edge 是否会跳过请求或怎样展示同语言结果，官方没有明确说明。

### 3.3 DeepL 浏览器扩展

**已确认行为**

- DeepL 官方帮助说明，用户选择文本并点击浮动图标后，翻译会出现在小窗口中；扩展会检测源语言，用户可在窗口中设定目标语言。证据：[DeepL 浏览器扩展帮助](https://support.deepl.com/hc/en-us/articles/4407580229522-Translate-with-the-browser-extensions)。
- DeepL 官方 API 允许将源语言留空以自动检测，并将完整字符串作为一个翻译输入。证据：[DeepL 官方 Node.js SDK](https://github.com/DeepLcom/deepl-node#translating-text)。

**对混合文本的结论**

- **官方明确**：选择的文本章节作为一个翻译对象，源语言可自动检测，目标语言单独设置。
- **无法验证**：DeepL 没有公开说明混合选区是只翻译外语部分，还是按检测出的主语言处理整段。

**对纯中文文本的结论**

- **无法验证**：官方帮助没有说明源语言与目标语言相同时的扩展 UI 行为。

### 3.4 沉浸式翻译

**已确认行为**

- 官方将段落视为最小翻译单位，悬停翻译会显示该段落的双语结果。这说明其核心思路是保留上下文后整段翻译，而不是默认按词或字符切片。证据：[产品介绍](https://immersivetranslate.com/en/docs/)、[鼠标悬停翻译](https://immersivetranslate.com/docs/features/hover/)。
- 自定义翻译接口一次接收 `text_list`、一个 `source_lang` 和一个 `target_lang`，并为每项返回检测到的源语言和译文。证据：[自定义接口文档](https://immersivetranslate.com/docs/services/custom/)。
- 输入框翻译专门提供 `//` 标记来实现“只翻译部分内容”，例如 `Hello //world` 变为 `Hello 世界`。这证明局部翻译是显式指令，而不是所有场景的默认自动行为。证据：[输入框翻译文档](https://immersivetranslate.com/docs/input/)。

**对混合文本的结论**

- **官方明确**：常规悬停翻译以段落为单位；输入框若要指定局部翻译，需要显式标记。
- **无法验证**：官方没有明确说明普通划词选区遇到中英混合内容时，是否会自动只翻译英文片段。

**对纯中文文本的结论**

- 官方 FAQ 在字幕场景明确指出，目标语言与字幕语言相同时不会触发翻译。证据：[沉浸式翻译 FAQ](https://immersivetranslate.com/docs/faq/)。
- **不可直接外推**：该规则只被官方明确用于字幕场景，不能据此确认普通划词的行为。

### 3.5 Easydict

Easydict 是开源的 macOS 划词翻译工具，虽不是 Chrome 扩展，但与本项目的“选区触发、自动识别、偏好语言路由”非常接近。

**已确认行为**

- 官方 README 说明会自动识别输入文本语言；默认优先语言为简体中文和英文。如果识别出的源语言等于第一偏好语言，会自动翻译到第二偏好语言。证据：[Easydict 官方仓库](https://github.com/tisfeng/Easydict)。
- 源码先为整段查询得到一个 `detectedLanguage`，再据此选择一个目标语言；OpenAI 翻译服务将完整 `text` 放入一次翻译提示词，没有客户端语言切片。证据：[QueryModel](https://github.com/tisfeng/Easydict/blob/main/Easydict/Swift/Model/QueryModel.swift)、[EZLanguageManager](https://github.com/tisfeng/Easydict/blob/main/Easydict/objc/Service/Language/EZLanguageManager.m)、[大模型翻译提示词](https://github.com/tisfeng/Easydict/blob/main/Easydict/Swift/Service/OpenAI/StreamService%2BPrompt.swift)。

**对混合文本的结论**

- **源码可确认**：整段选区只得到一个检测语言，并作为完整文本发送给翻译服务；没有客户端按语种拆片。
- **推断**：中英混合内容会被归入某个主语言，最终是否保留另一语言片段由具体翻译引擎决定。

**对纯中文文本的结论**

- **官方明确且源码可确认**：若中文是第一偏好语言，纯中文会自动翻译到第二偏好语言，默认通常是英文；它不是原样显示策略。

### 3.6 TransOver

**已确认行为**

- Chrome Web Store 的产品说明写明：可将任意语言的单词或文本选区翻译到用户选择的语言，并支持从用户自己的语言进行“反向翻译”。源语言可以自动检测。证据：[TransOver Chrome Web Store 页面](https://chromewebstore.google.com/detail/transover/aggiiclaiamajehmlfpkjmlbadmkledi)。

**对混合文本的结论**

- **无法验证**：公开说明没有描述中英混合选区是否会拆分或保留其中一部分。

**对纯中文文本的结论**

- **官方明确到功能层**：产品提供反向翻译，而不是把“自己的语言”一律原样返回。
- **无法验证到触发细节**：当前版本是否会自动对每个同语言选区启用反向翻译，取决于用户设置，官方页面没有给出完整条件。

## 4. 行业模式对比

| 产品 | 选区/段落是否整段处理 | 源语言策略 | 中英混合策略 | 纯目标语言策略 |
| --- | --- | --- | --- | --- |
| Chrome | 是，源码可确认 | 整个选区一个源语言 | 服务端行为未公开 | 未公开 |
| Edge / Translator | 产品支持选区；API 为整段输入 | 每个输入一个检测语言 | Translator 官方称不可靠 | API 接受同语言请求；Edge UI 未公开 |
| DeepL 扩展 | 是，按所选文本章节 | 自动检测，可手改 | 未公开 | 未公开 |
| 沉浸式翻译 | 悬停以段落为最小单位 | 一个源语言与目标语言 | 普通划词未公开；输入框可显式指定局部翻译 | 字幕同语言不触发；划词未公开 |
| Easydict | 是，源码可确认 | 整段检测一个语言 | 交给具体翻译引擎 | 自动切到第二偏好语言 |
| TransOver | 按选区处理 | 自动检测或配置 | 未公开 | 支持反向翻译 |

可以确认的共性是“整段送入、单一目标语言”；不能确认的，是“混合内容最终逐片如何变化”。因此不能把“只翻译英文片段”描述成传统产品的通用既有规则。

## 5. 对 Highlight Translate MVP V1 的建议

### 5.1 推荐产品规则

1. **非中文选区**：整段调用模型，翻译为简体中文。
2. **纯中文选区**：仍显示翻译按钮；用户点击后不调用模型，卡片原样显示中文。
3. **中英混合选区**：整段调用模型，但提示词要求：
   - 将自然语言中的非中文内容翻译为简体中文；
   - 保留已有中文的含义，不重复翻译或删除；
   - 保留代码、命令、URL、变量名、产品名和不应翻译的专有名词；
   - 可以为语序自然做最小调整，但不能改写事实或补充解释；
   - 输出一段自然、完整的简体中文结果。

例如：

```text
原文：这个 API supports streaming responses，延迟比较低。
结果：这个 API 支持流式响应，延迟比较低。
```

### 5.2 为什么不在客户端机械切分

将文本按中文字符、拉丁字母或空格切片会破坏短语和上下文。例如 `supports streaming responses` 应作为一个语义单元翻译，`API` 又通常应该保留。大模型能在完整上下文中判断哪些是自然语言、哪些是专有名词或代码，因此应让模型处理整段，而不是让 Content Script 自行拼接碎片。

### 5.3 与市面产品的关系

该方案保留了主流产品成熟的交互模型——**完整选区只触发一次翻译请求**；同时利用大模型解决传统翻译器没有稳定承诺的部分——**在同一段中保留中文并翻译外语，使结果成为自然中文**。

这不是对市场行为的照搬，而是基于调研后有意识的产品选择。

## 6. 本轮待确认项

建议将中英混合选区的规则确定为：

> 整段交给大模型；将其中的非中文自然语言翻译成简体中文，保留已有中文、代码、URL、变量名和无需翻译的专有名词，输出自然完整的中文。

该规则一旦确认，混合文本方向不再构成 MVP 的阻塞项。后续仍需单独确认“如何判断纯中文与混合文本”的工程边界，例如数字、标点、URL、品牌名和代码是否算作需要调用模型的非中文内容。
