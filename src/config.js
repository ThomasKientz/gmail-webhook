import { DEFAULT_EXPIRED_MAX, DEFAULT_HISTORY_CAP, DEFAULT_PAYLOAD_FIELDS } from './constants.js';

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeLabelBehavior(value) {
  const behavior = String(value || 'include').trim().toLowerCase();
  if (behavior !== 'include' && behavior !== 'exclude') {
    const error = new Error('label_filter_invalid');
    error.code = 'label_filter_invalid';
    throw error;
  }
  return behavior;
}

export function normalizeAuthScheme(value) {
  if (value === undefined || value === null || value === '') return 'Bearer';
  if (value === 'none' || value === 'raw') return '';
  return value;
}

export function loadConfig(env = process.env) {
  const payloadFields = splitList(env.PAYLOAD_FIELDS);
  return {
    projectId: env.GCP_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || '',
    topic: env.PUBSUB_TOPIC || 'gmail-notifications',
    stateBucket: env.STATE_BUCKET || '',
    webhookUrl: env.WEBHOOK_URL || '',
    webhookKey: env.WEBHOOK_KEY || '',
    webhookAuthHeaderName: env.WEBHOOK_AUTH_HEADER_NAME || 'Authorization',
    webhookAuthScheme: normalizeAuthScheme(env.WEBHOOK_AUTH_SCHEME),
    payloadFields: payloadFields.length ? payloadFields : [...DEFAULT_PAYLOAD_FIELDS],
    includeBody: env.INCLUDE_BODY === 'true',
    labelIds: env.GMAIL_LABEL_IDS === undefined ? ['INBOX'] : splitList(env.GMAIL_LABEL_IDS),
    labelFilterBehavior: normalizeLabelBehavior(env.GMAIL_LABEL_FILTER_BEHAVIOR),
    historyExpiredMaxMessages: clampInt(env.HISTORY_EXPIRED_MAX_MESSAGES, 1, 50, DEFAULT_EXPIRED_MAX),
    maxHistoryMessages: clampInt(env.MAX_HISTORY_MESSAGES, 1, 2000, DEFAULT_HISTORY_CAP),
    oauthClientId: env.GMAIL_OAUTH_CLIENT_ID || '',
    oauthClientSecret: env.GMAIL_OAUTH_CLIENT_SECRET || '',
    oauthRefreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN || '',
  };
}

export function assertConfig(config, { requireWebhook }) {
  const missing = [];
  if (!config.projectId) missing.push('GCP_PROJECT');
  if (!config.stateBucket) missing.push('STATE_BUCKET');
  if (!config.oauthClientId) missing.push('GMAIL_OAUTH_CLIENT_ID');
  if (!config.oauthClientSecret) missing.push('GMAIL_OAUTH_CLIENT_SECRET');
  if (!config.oauthRefreshToken) missing.push('GMAIL_OAUTH_REFRESH_TOKEN');
  if (requireWebhook && !config.webhookUrl) missing.push('WEBHOOK_URL');
  if (missing.length) {
    const error = new Error(`config_incomplete:${missing.join(',')}`);
    error.code = 'config_incomplete';
    throw error;
  }
  if (requireWebhook && !config.webhookUrl.startsWith('https://')) {
    const error = new Error('webhook_url_invalid');
    error.code = 'webhook_url_invalid';
    throw error;
  }
}
