# Highlight Translate

[English](README.md) | [简体中文](README.zh-CN.md)

Translate selected foreign-language text into Simplified Chinese without leaving the page. Highlight Translate is a personal Chrome extension that keeps Chinese selections local and streams other selections through DeepSeek using your own API key.

- Select text and translate it from a small button beside the selection.
- Read streamed results in a compact card that preserves paragraphs, line breaks, and lists.
- Move a completed, partial, local, or errored card out of the way by dragging its header.
- Keep credentials out of page scripts: the API key stays in trusted Chrome extension storage and is used only by the Service Worker.
- Send only the complete text you selected—never the page URL, title, DOM, surrounding context, or rich-text markup.
- Avoid unnecessary model calls: Chinese selections are detected and shown locally.

Highlight Translate is a bring-your-own-key project installed locally from GitHub. It is not distributed through the Chrome Web Store, does not include API credits, and does not run a project-operated backend.

## Install

You need a current desktop version of Google Chrome, Node.js with npm, and a DeepSeek Platform account if you want to translate non-Chinese text.

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

## Set up your DeepSeek API key

1. Open the official [DeepSeek API Keys page](https://platform.deepseek.com/api_keys), sign in, and create a key.
2. Open Highlight Translate's settings page. It opens automatically on first installation; later, click the extension's toolbar icon or open **Details → Extension options** at `chrome://extensions`.
3. Paste the key into the masked **API Key** field and click **Save**.
4. Optionally click **Test connection**. Saving and testing are independent: a failed test does not remove the saved key.

Never paste an API key into an AI chat, source file, screenshot, issue, or public message. Enter it yourself only in the extension settings page. The current build uses one fixed provider configuration:

```text
Endpoint: https://api.deepseek.com/chat/completions
Model: deepseek-v4-flash
Target language: Simplified Chinese
```

The key is stored in `chrome.storage.local` with access restricted to trusted extension contexts. This is appropriate for a personal, local BYOK extension, but Chrome local storage is not an operating-system keychain.

## Use Highlight Translate

1. On a normal HTTP or HTTPS page, select natural-language text with a mouse or trackpad.
2. Click the circular **译** button beside the end of the selection.
3. If Chinese is the detected primary language, the card shows the original selection locally. Non-Chinese or unknown-language selections are sent to DeepSeek and streamed back in Simplified Chinese.
4. Copy a complete result, retry a retryable failure, or close the card with **×**, `Esc`, or a click on the page outside the card.
5. Once the request has stopped, drag the card by its header if it covers the content you are reading.

Only the header is a drag handle; the close button, result area, and action buttons keep their normal behavior. A movement of about 4 px is required before dragging begins, and the card stays approximately 8 px inside the viewport. After its first valid drag, the card stays fixed to the viewport while the page scrolls. Its free position survives a retry, but resets when the card closes or a new selection is made. Dragging is disabled while an initial request or retry is actively streaming.

## What works today

- Desktop Chrome as a locally loaded Manifest V3 extension.
- Top-level HTTP and HTTPS pages, including local development servers.
- Mouse and trackpad selections in ordinary page content.
- Local detection of one primary language for the complete selection, using `chrome.i18n.detectLanguage` with a Unicode fallback.
- Local display for Chinese selections; DeepSeek streaming for non-Chinese and unknown selections.
- Selection admission rules, a 5,000-character limit, cancellation, stale-result isolation, timeouts, normalized errors, partial results, retry, copy, dark mode, and responsive card placement.
- Draggable stopped-state cards with viewport bounds, retry position retention, and anchored/free-position scrolling behavior.
- A Simplified Chinese interface and Simplified Chinese translation target.

## Current limitations

- Chrome internal pages, the Chrome Web Store, `file://` pages, built-in PDF pages, and iframes are not supported.
- Keyboard-made selections, keyboard shortcuts, context-menu translation, and toolbar popups are not supported.
- Selections inside `input`, `textarea`, or `contenteditable` elements are ignored. Pure URLs, email addresses, numbers, punctuation, whitespace, and emoji do not show the trigger.
- Touchscreen, stylus, and multi-touch dragging are not specifically supported or validated.
- DeepSeek is the only provider; the endpoint, model, target language, and UI language are not configurable.
- There is no translation history, cache, cloud sync, account system, site blacklist, or in-extension pause switch.
- The card position is not persisted across closing the card, making a new selection, refreshing, or navigating.
- Only one translation card and one complete-selection language route are handled at a time; mixed-language selections are not split into separate translations.

## Privacy and data flow

Highlight Translate processes each selection as follows:

1. The Content Script captures the complete selected text and displays the page UI inside a closed Shadow DOM.
2. The Service Worker validates the request and detects its primary language locally.
3. Chinese selections are returned directly without a DeepSeek request.
4. For non-Chinese or unknown selections, the Service Worker reads the locally stored key and sends the complete selected text plus the extension's fixed translation instruction to the fixed DeepSeek HTTPS endpoint.
5. The Service Worker streams plain-text result events back to the card. Model output is treated as untrusted text and is never executed as HTML.

The extension does not send the page URL, title, DOM, HTML/CSS, nearby text, selection context, or rich-text styles. It does not save selections, translations, history, or cache entries. DeepSeek still receives remote translation requests under its own terms and privacy policy.

## Troubleshooting

### The **译** button does not appear

- Confirm the extension is enabled at `chrome://extensions`, then click **Reload** and refresh the page.
- Use a normal top-level HTTP or HTTPS page and finish the selection with a mouse or trackpad.
- Check that the selection is outside editable fields and contains at least one natural-language letter.
- Pure URLs, email addresses, numbers, symbols, whitespace, and emoji are intentionally ignored.

### The extension says the content is too long

Shorten the selection to 5,000 characters or fewer. Long selections still show the trigger, but they are rejected locally and are not sent to DeepSeek.

### The extension asks for an API key

Click **Open settings** in the card or click the toolbar icon, save a DeepSeek API key, and retry. Chinese selections do not need a key because they are handled locally.

### Connection testing or translation fails

- Recheck the saved key and confirm the DeepSeek account has access and sufficient balance or quota.
- Check network, proxy, firewall, and DeepSeek service availability.
- A `401`/`403`-style failure is shown as an invalid-key message; rate limits, quota, server, timeout, malformed-stream, and network failures are converted to concise Chinese messages without exposing raw provider responses.
- Remember that live DeepSeek success is not yet established by this repository's recorded acceptance; automated tests use controlled provider responses.

### The card will not move

Wait until the current translation or retry stops, then drag the header with the primary mouse/trackpad pointer. Dragging is intentionally frozen while the card is streaming, and the result area and buttons are not drag handles.

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

`npm run dev` watches source files and rebuilds `dist/`. `npm run build` creates the loadable extension and automatically checks the Manifest entry points, permission scope, fixed DeepSeek host, unexpected local files, likely API keys, and console logging. `npm run verify:dist` repeats the distribution checks against an existing build.

After UI changes, also reload `dist/` in Chrome and test the real selection, translation-card, scrolling, resizing, copying, closing, retry, and dragging flows. Automated checks cannot prove that a live provider request or browser interaction works end to end.

## Specifications and validation

- [MVP specification](docs/specs/001-mvp/spec.md)
- [Draggable translation-card specification](docs/specs/002-draggable-card/spec.md)
- [ADR 001: viewport-fixed free position after dragging](docs/adr/001-draggable-card-position-mode.md)
- [Project glossary](docs/glossary.md)
- [MVP validation record](docs/validation/001-mvp.md)
- [Draggable-card validation record](docs/validation/002-draggable-card.md)

## License

MIT. See [LICENSE](LICENSE).
