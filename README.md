# Highlight Translate

[English](README.md) | [简体中文](README.zh-CN.md)

Translate selected foreign-language text into Simplified Chinese without leaving the page. Highlight Translate is a personal Chrome extension that keeps Chinese selections local and streams other selections through the official provider and model you choose, using your own API key.

- Select text and translate it from a small button beside the selection.
- Read streamed results in a compact card that preserves paragraphs, line breaks, and lists.
- Move a completed, partial, local, or errored card out of the way by dragging its header.
- Resize a stopped card from its lower-right handle; long results scroll inside the result area.
- Keep credentials out of page scripts: the API key stays in trusted Chrome extension storage and is used only by the Service Worker.
- Send only the complete text you selected—never the page URL, title, DOM, surrounding context, or rich-text markup.
- Avoid unnecessary model calls: Chinese selections are detected and shown locally.
- Keep one configuration per provider and choose models from the provider's API catalog.

Highlight Translate is a bring-your-own-key project installed locally from GitHub. It is not distributed through the Chrome Web Store, does not include API credits, and does not run a project-operated backend.

## Install

You need a current desktop version of Google Chrome, Node.js with npm, and an official API key for one of the providers below to translate non-Chinese text.

```bash
git clone https://github.com/Kieran351/highlight-translate.git
cd highlight-translate
npm install
npm run build
```

Then load the build in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this project's `dist/` directory—not the repository root.
5. Keep the project folder in place. Moving or deleting it breaks the unpacked extension until you load it again from the new location.

After pulling an update or changing the source, run `npm run build`, click **Reload** on the extension card, and refresh any open pages where you want to use it.

## Choose a provider and model

1. Obtain an API key from your provider's official platform. MiniMax and Kimi use their China platforms.
2. Open Highlight Translate's settings page. It opens automatically on first installation; later, click the extension's toolbar icon or open **Details → Extension options** at `chrome://extensions`.
3. Select the provider and paste the key into the masked **API Key** field. The extension fetches its model catalog automatically.
4. Choose a model from the dropdown and click **Save and enable**. Testing is optional and does not gate saving.
5. Use **Refresh model list** when you want an updated catalog. A failed refresh preserves your last successful list and selection.

Never paste an API key into an AI chat, source file, screenshot, issue, or public message. Enter it yourself only in the extension settings page.

| Provider | Official platform | API host |
| --- | --- | --- |
| DeepSeek | [DeepSeek](https://platform.deepseek.com/) | `api.deepseek.com` |
| MiniMax | [China platform](https://platform.minimax.cn/) | `api.minimax.cn` |
| Kimi / Moonshot | [China platform](https://platform.kimi.com/) | `api.moonshot.cn` |
| OpenAI | [OpenAI](https://platform.openai.com/) | `api.openai.com` |
| Anthropic | [Claude Console](https://platform.claude.com/) | `api.anthropic.com` |

GLM / BigModel is deferred for this release and is not offered in the provider selector.

Each provider retains its own key and selected model. Saving a configuration changes subsequent requests; a running translation keeps its original configuration. If a successful complete refresh removes the selected model, the extension preserves that choice and asks you to select another before starting new remote translations. Existing DeepSeek keys are retained during upgrade, but the old fixed model must be selected from a freshly fetched catalog. The translation target remains Simplified Chinese.

The key is stored in `chrome.storage.local` with access restricted to trusted extension contexts. This is appropriate for a personal, local BYOK extension, but Chrome local storage is not an operating-system keychain.

## Use Highlight Translate

1. On a normal HTTP or HTTPS page, select natural-language text with a mouse or trackpad.
2. Click the circular **译** button beside the end of the selection.
3. If Chinese is the detected primary language, the card shows the original selection locally. Non-Chinese or unknown-language selections are sent to your active provider and streamed back in Simplified Chinese.
4. Copy a complete result, retry a retryable failure, or close the card with **×**, `Esc`, or a click on the page outside the card.
5. Once the request has stopped, drag the card by its header if it covers the content you are reading.
6. Once the request has stopped, drag the lower-right handle to adjust width and height. The card keeps that size until it is closed or a new selection is made.

Only the header moves the card, and only the lower-right handle resizes it; the close button, result area, and action buttons keep their normal behavior. A movement of about 4 px is required before either gesture begins, and the card stays approximately 8 px inside the viewport. After its first valid position drag, the card stays fixed to the viewport while the page scrolls. A resized card can exceed the automatic 60vh height limit, with overflow scrolling inside the result area. Its size and free position survive a retry, but both reset when the card closes or a new selection is made. Moving and resizing are disabled while an initial request or retry is actively streaming.

## What works today

- Desktop Chrome as a locally loaded Manifest V3 extension.
- Top-level HTTP and HTTPS pages, including local development servers.
- Mouse and trackpad selections in ordinary page content.
- Local detection of one primary language for the complete selection, using `chrome.i18n.detectLanguage` with a Unicode fallback.
- Local display for Chinese selections; streaming through the selected official provider for non-Chinese and unknown selections.
- Selection admission rules, a 5,000-character limit, cancellation, stale-result isolation, timeouts, normalized errors, partial results, retry, copy, dark mode, and responsive card placement.
- Draggable stopped-state cards with viewport bounds, retry position retention, and anchored/free-position scrolling behavior.
- Resizable stopped-state cards with viewport bounds, retry size retention, automatic temporary fitting during viewport changes, and result-area scrolling.
- A Simplified Chinese interface and Simplified Chinese translation target.

## Current limitations

- Chrome internal pages, the Chrome Web Store, `file://` pages, built-in PDF pages, and iframes are not supported.
- Keyboard-made selections, keyboard shortcuts, context-menu translation, and toolbar popups are not supported.
- Selections inside `input`, `textarea`, or `contenteditable` elements are ignored. Pure URLs, email addresses, numbers, punctuation, whitespace, and emoji do not show the trigger.
- Touchscreen, stylus, and multi-touch dragging are not specifically supported or validated.
- Only the official platforms above are implemented. Custom endpoints, subscription login, manual model IDs, automatic provider fallback, and multiple keys for one provider are not supported. The target language and UI language remain fixed.
- A model appearing in the catalog does not guarantee that it supports the extension's translation request; use the optional test to check it. Models with insufficient capability information remain selectable.
- There is no translation history, cache, cloud sync, account system, site blacklist, or in-extension pause switch.
- The card position is not persisted across closing the card, making a new selection, refreshing, or navigating.
- The card size is not persisted across closing the card, making a new selection, refreshing, or navigating; there is no control to restore automatic sizing during the same card lifetime.
- Only one translation card and one complete-selection language route are handled at a time; mixed-language selections are not split into separate translations.

## Privacy and data flow

Highlight Translate processes each selection as follows:

1. The Content Script captures the complete selected text and displays the page UI inside a closed Shadow DOM.
2. The Service Worker validates the request and detects its primary language locally.
3. Chinese selections are returned directly without a provider request or dependence on a valid configuration.
4. For non-Chinese or unknown selections, the Service Worker uses the request's fixed provider, key, and model, and sends the complete selected text plus the extension's translation instruction to that provider's fixed official HTTPS endpoint.
5. The Service Worker streams plain-text result events back to the card. Model output is treated as untrusted text and is never executed as HTML.

The extension does not send the page URL, title, DOM, HTML/CSS, nearby text, selection context, or rich-text styles. It does not save selections, translations, history, or translation cache entries. Model catalogs and provider configurations are stored locally. Model-list requests carry no selection, and optional tests use fixed non-sensitive text. Your selected provider receives remote requests under its own terms and privacy policy.

## Troubleshooting

### The **译** button does not appear

- Confirm the extension is enabled at `chrome://extensions`, then click **Reload** and refresh the page.
- Use a normal top-level HTTP or HTTPS page and finish the selection with a mouse or trackpad.
- Check that the selection is outside editable fields and contains at least one natural-language letter.
- Pure URLs, email addresses, numbers, symbols, whitespace, and emoji are intentionally ignored.

### The extension says the content is too long

Shorten the selection to 5,000 characters or fewer. Long selections still show the trigger, but they are rejected locally and are not sent to a provider.

### The extension asks for an API key

Click **Open settings** in the card or click the toolbar icon, fetch the catalog with your provider's key, select a model, save, and retry. After an upgrade, fetch the DeepSeek catalog and choose a model even if the old key is already present. Chinese selections do not need a key because they are handled locally.

### Connection testing or translation fails

- Recheck the selected provider, platform region, key, and model, and confirm your API account has access and sufficient balance or quota.
- Check network, proxy, firewall, and the selected provider's service availability.
- A `401`/`403`-style failure is shown as an invalid-key message; rate limits, quota, server, timeout, malformed-stream, and network failures are converted to concise Chinese messages without exposing raw provider responses.
- Automated tests use controlled provider responses. Live authenticated catalog and translation results need separate verification for each provider.

### The card will not move

Wait until the current translation or retry stops, then drag the header with the primary mouse/trackpad pointer. Dragging is intentionally frozen while the card is streaming, and the result area and buttons are not drag handles.

### The card will not resize

Wait until the current translation or retry stops, then drag the lower-right handle with the primary mouse/trackpad pointer. Resizing is intentionally frozen while the card is streaming. The card stays within the viewport, and an undersized viewport temporarily constrains the rendered size without replacing the size chosen for the current card.

### A rebuilt version does not appear in Chrome

Run `npm run build`, reload Highlight Translate at `chrome://extensions`, and refresh the target page. Chrome does not automatically reload an unpacked extension after local files change.

## Development and checks

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:dist
```

`npm run dev` watches source files and rebuilds `dist/`. `npm run build` creates the loadable extension and automatically checks the Manifest entry points, permission scope, the five fixed official hosts, unexpected local files, likely API keys, and console logging. `npm run verify:dist` repeats the distribution checks against an existing build.

After UI changes, also reload `dist/` in Chrome and test the real selection, translation-card, scrolling, resizing, copying, closing, retry, and dragging flows. Automated checks cannot prove that a live provider request or browser interaction works end to end.

## License

MIT. See [LICENSE](LICENSE).
