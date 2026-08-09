import type { AppErrorCode, ErrorPresentation } from './types';

const ERROR_PRESENTATIONS: Record<AppErrorCode, ErrorPresentation> = {
  invalid_request: { message: '翻译请求无效，请重新选择文本。', retryable: false },
  too_long: { message: '内容过长，请将选区缩短到 5,000 个字符以内。', retryable: false },
  missing_key: { message: '尚未配置 DeepSeek API Key。', retryable: false, showSettings: true },
  authentication: { message: 'API Key 无效，请前往设置检查。', retryable: false, showSettings: true },
  rate_limit: { message: '请求过于频繁，请稍后再试。', retryable: true },
  quota: { message: 'DeepSeek 账户余额或额度不足，请检查账户。', retryable: false, showSettings: true },
  server: { message: '翻译服务暂时不可用，请稍后重试。', retryable: true },
  network: { message: '网络连接失败，请检查网络后重试。', retryable: true },
  empty_response: { message: '翻译服务没有返回有效内容，请重试。', retryable: true },
  invalid_stream: { message: '翻译响应格式无效，请重试。', retryable: true },
  timeout_first: { message: '等待翻译结果超时，请重试。', retryable: true },
  timeout_idle: { message: '翻译响应中断，请重试。', retryable: true },
  timeout_total: { message: '本次翻译用时过长，请缩短内容后重试。', retryable: true },
};

export function getErrorPresentation(code: AppErrorCode): ErrorPresentation {
  return ERROR_PRESENTATIONS[code];
}
