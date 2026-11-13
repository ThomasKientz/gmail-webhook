import { buildAuthorizationHeader } from './payload.js';

export function createWebhookClient({ fetchImpl }) {
  return {
    async send(payload, config) {
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'gmail-webhook',
      };
      const authorization = buildAuthorizationHeader({
        headerName: config.webhookAuthHeaderName,
        scheme: config.webhookAuthScheme,
        key: config.webhookKey,
      });
      if (authorization) headers[authorization.name] = authorization.value;

      const response = await fetchImpl(config.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel?.();
      if (response.status < 200 || response.status >= 300) {
        const error = new Error('webhook_http');
        error.code = 'webhook_http';
        error.status = response.status;
        throw error;
      }
    },
  };
}
