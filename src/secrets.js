import { SECRET } from './constants.js';

export const NO_WEBHOOK_KEY = '__NO_WEBHOOK_KEY__';

export function normalizeWebhookKey(value) {
  if (!value || value === NO_WEBHOOK_KEY) return '';
  return value;
}

export function createSecretReader({ projectId, fetchImpl, getAccessToken, now = () => Date.now(), ttlMs = 600_000 }) {
  const cache = new Map();

  return async function readSecret(name, { optional = false } = {}) {
    const hit = cache.get(name);
    if (hit && hit.expiresAt > now()) return hit.value;

    const token = await getAccessToken();
    const url =
      `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
      `/secrets/${encodeURIComponent(name)}/versions/latest:access`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404 && optional) return '';
    if (!response.ok) {
      const error = new Error('secret_read_failed');
      error.code = response.status === 404 ? 'secret_not_found' : 'secret_read_failed';
      error.status = response.status;
      throw error;
    }
    const json = await response.json();
    const encoded = json?.payload?.data;
    if (typeof encoded !== 'string') {
      const error = new Error('secret_empty');
      error.code = 'secret_empty';
      throw error;
    }
    const value = Buffer.from(encoded, 'base64').toString('utf8');
    cache.set(name, { value, expiresAt: now() + ttlMs });
    return value;
  };
}

export async function loadSecretConfig(baseConfig, readSecret) {
  const [clientId, clientSecret, refreshToken, webhookKey] = await Promise.all([
    readSecret(SECRET.clientId),
    readSecret(SECRET.clientSecret),
    readSecret(SECRET.refreshToken),
    readSecret(SECRET.webhookKey, { optional: true }),
  ]);
  return {
    ...baseConfig,
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
    oauthRefreshToken: refreshToken,
    webhookKey: normalizeWebhookKey(webhookKey),
  };
}
