import { createMetadataTokenProvider } from './gcp-auth.js';
import { createGmailClient } from './gmail.js';
import { assertConfig, loadConfig } from './config.js';
import { safeLog } from './log.js';
import { createAccessTokenProvider } from './oauth.js';
import { parseCloudEvent } from './history.js';
import { processNotification, renewWatch } from './process.js';
import { createSecretReader, loadSecretConfig } from './secrets.js';
import { createGcsStateStore } from './state.js';
import { createWebhookClient } from './webhook.js';

const NON_RETRYABLE = new Set([
  'invalid_grant',
  'config_incomplete',
  'webhook_url_invalid',
  'secret_not_found',
  'label_filter_invalid',
  'empty_notification',
  'notification_unreadable',
  'missing_history_id',
]);

async function runtimeConfig(requireWebhook) {
  const base = loadConfig();
  const metadataToken = createMetadataTokenProvider({ fetchImpl: fetch });
  const readSecret = createSecretReader({
    projectId: base.projectId,
    fetchImpl: fetch,
    getAccessToken: metadataToken,
  });
  const config = await loadSecretConfig(base, readSecret);
  assertConfig(config, { requireWebhook });
  const userToken = createAccessTokenProvider({
    clientId: config.oauthClientId,
    clientSecret: config.oauthClientSecret,
    refreshToken: config.oauthRefreshToken,
    fetchImpl: fetch,
  });
  return {
    config,
    gmail: createGmailClient({ fetchImpl: fetch, getAccessToken: userToken }),
    state: createGcsStateStore({
      bucket: config.stateBucket,
      fetchImpl: fetch,
      getAccessToken: metadataToken,
    }),
    webhook: createWebhookClient({ fetchImpl: fetch }),
  };
}

export async function handlePush(cloudEvent) {
  try {
    const notification = parseCloudEvent(cloudEvent);
    const deps = await runtimeConfig(true);
    const result = await processNotification({
      notificationHistoryId: notification.historyId,
      ...deps,
      log: safeLog,
    });
    safeLog({
      severity: 'INFO',
      message: 'notification traitée',
      status: result.status,
      count: result.sent,
    });
  } catch (error) {
    safeLog({
      severity: 'ERROR',
      message: 'échec du traitement',
      status: error.code || 'error',
      code: error.status || 0,
    });
    if (!NON_RETRYABLE.has(error.code)) throw error;
  }
}

export async function handleRenew(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  try {
    const deps = await runtimeConfig(false);
    const result = await renewWatch(deps);
    safeLog({ severity: 'INFO', message: 'surveillance renouvelée', status: 'renewed' });
    res.status(200).json({ ok: true, expiration: result.expiration });
  } catch (error) {
    safeLog({
      severity: 'ERROR',
      message: 'échec du renouvellement',
      status: error.code || 'error',
      code: error.status || 0,
    });
    const status = NON_RETRYABLE.has(error.code) ? 400 : 500;
    res.status(status).json({ ok: false });
  }
}
