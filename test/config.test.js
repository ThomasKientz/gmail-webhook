import assert from 'node:assert/strict';
import test from 'node:test';
import { assertConfig, loadConfig } from '../src/config.js';
import { safeLog } from '../src/log.js';

test('loadConfig applies the documented defaults', () => {
  const config = loadConfig({});
  assert.deepEqual(config.payloadFields, ['id', 'threadId', 'from', 'to', 'subject', 'date', 'snippet', 'labelIds']);
  assert.deepEqual(config.labelIds, ['INBOX']);
  assert.equal(config.labelFilterBehavior, 'include');
  assert.equal(config.includeBody, false);
  assert.equal(config.webhookAuthScheme, 'Bearer');
  assert.equal(config.topic, 'gmail-notifications');
});

test('loadConfig accepts an empty label list and a raw authorization scheme', () => {
  const config = loadConfig({
    GMAIL_LABEL_IDS: '',
    GMAIL_LABEL_FILTER_BEHAVIOR: 'EXCLUDE',
    WEBHOOK_AUTH_SCHEME: 'none',
    PAYLOAD_FIELDS: ' id, subject ',
    INCLUDE_BODY: 'true',
    HISTORY_EXPIRED_MAX_MESSAGES: '3',
  });
  assert.deepEqual(config.labelIds, []);
  assert.equal(config.labelFilterBehavior, 'exclude');
  assert.equal(config.webhookAuthScheme, '');
  assert.deepEqual(config.payloadFields, ['id', 'subject']);
  assert.equal(config.includeBody, true);
  assert.equal(config.historyExpiredMaxMessages, 3);
});

test('assertConfig rejects an incomplete runtime and a non-https webhook', () => {
  const config = loadConfig({
    GCP_PROJECT: 'demo',
    STATE_BUCKET: 'demo-gmail-webhook',
    GMAIL_OAUTH_CLIENT_ID: 'id',
    GMAIL_OAUTH_CLIENT_SECRET: 'secret',
    GMAIL_OAUTH_REFRESH_TOKEN: 'refresh',
    WEBHOOK_URL: 'http://example.com/hook',
  });
  assert.throws(() => assertConfig(config, { requireWebhook: true }), { code: 'webhook_url_invalid' });
  assert.doesNotThrow(() => assertConfig({ ...config, webhookUrl: '' }, { requireWebhook: false }));
  assert.throws(() => assertConfig(loadConfig({}), { requireWebhook: false }), { code: 'config_incomplete' });
});

test('safeLog never prints message contents or secrets', () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    safeLog({
      severity: 'INFO',
      message: 'ok',
      status: 'ok',
      snippet: 'bonjour',
      subject: 'privé',
      webhookKey: 'secret',
      refreshToken: 'token',
    });
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '{"severity":"INFO","message":"ok","status":"ok"}');
});
