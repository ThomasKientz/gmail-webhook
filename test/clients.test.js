import assert from 'node:assert/strict';
import test from 'node:test';
import { createGmailClient } from '../src/gmail.js';
import { createAccessTokenProvider } from '../src/oauth.js';
import { createSecretReader, loadSecretConfig, normalizeWebhookKey } from '../src/secrets.js';
import { createGcsStateStore } from '../src/state.js';
import { createWebhookClient } from '../src/webhook.js';

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
    body: { async cancel() {} },
  };
}

test('access token provider caches a token and surfaces invalid_grant', async () => {
  let calls = 0;
  let now = 1_000_000;
  const provider = createAccessTokenProvider({
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    now: () => now,
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.equal(options.body.get('refresh_token'), 'refresh');
      return jsonResponse(200, { access_token: `token-${calls}`, expires_in: 3600 });
    },
  });
  assert.equal(await provider(), 'token-1');
  now += 1000;
  assert.equal(await provider(), 'token-1');
  assert.equal(calls, 1);

  const failing = createAccessTokenProvider({
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant' }),
  });
  await assert.rejects(failing(), { code: 'invalid_grant' });
});

test('gmail client pages history, requests metadata only, and watches with lowercase filters', async () => {
  const calls = [];
  const client = createGmailClient({
    getAccessToken: async () => 'access',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const href = String(url);
      if (href.includes('/history')) {
        if (href.includes('pageToken=next')) {
          return jsonResponse(200, { historyId: '30', history: [{ id: '12', messagesAdded: [{ message: { id: 'm2', labelIds: ['INBOX'] } }] }] });
        }
        return jsonResponse(200, {
          historyId: '20',
          nextPageToken: 'next',
          history: [{ id: '11', messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] }],
        });
      }
      if (href.endsWith('/watch')) {
        return jsonResponse(200, { historyId: '31', expiration: '123' });
      }
      return jsonResponse(200, { id: 'm1', snippet: 'hidden' });
    },
  });

  const page = await client.listAddedSince('10', {
    labelIds: ['INBOX'],
    labelFilterBehavior: 'include',
    maxHistoryMessages: 100,
  });
  assert.deepEqual(page.messages.map((message) => message.id), ['m1', 'm2']);
  assert.equal(page.historyId, '30');
  assert.match(calls[0].url, /historyTypes=messageAdded/);
  assert.match(calls[0].url, /labelId=INBOX/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer access');

  await client.getMessage('m1', { includeBody: false });
  const metadataUrl = calls.at(-1).url;
  assert.match(metadataUrl, /format=metadata/);
  assert.doesNotMatch(metadataUrl, /format=full/);
  assert.match(metadataUrl, /metadataHeaders=Subject/);

  const watch = await client.watch({
    projectId: 'demo',
    topic: 'gmail-notifications',
    labelIds: ['INBOX'],
    labelFilterBehavior: 'include',
  });
  assert.equal(watch.historyId, '31');
  const watchBody = JSON.parse(calls.at(-1).options.body);
  assert.equal(watchBody.labelFilterBehavior, 'include');
  assert.equal(watchBody.topicName, 'projects/demo/topics/gmail-notifications');
});

test('gmail history 404 becomes history_expired and recent listing queries each include label', async () => {
  const urls = [];
  const client = createGmailClient({
    getAccessToken: async () => 'access',
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes('/history')) return jsonResponse(404, { error: { code: 404 } });
      return jsonResponse(200, { messages: [{ id: 'a' }, { id: 'b' }] });
    },
  });
  await assert.rejects(
    client.listAddedSince('1', { labelIds: ['INBOX'], labelFilterBehavior: 'include', maxHistoryMessages: 10 }),
    { code: 'history_expired' },
  );
  const recent = await client.listRecentMessages({
    labelIds: ['INBOX', 'Label_1'],
    labelFilterBehavior: 'include',
    historyExpiredMaxMessages: 2,
  });
  assert.deepEqual(recent.map((message) => message.id), ['a', 'b']);
  assert.equal(urls.filter((url) => url.includes('labelIds=INBOX')).length, 1);
  assert.equal(urls.filter((url) => url.includes('labelIds=Label_1')).length, 1);
});

test('state store uses generation preconditions and treats a missing object as empty', async () => {
  const writes = [];
  const store = createGcsStateStore({
    bucket: 'demo-gmail-webhook',
    getAccessToken: async () => 'meta',
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST') {
        writes.push({ url: String(url), body: JSON.parse(options.body) });
        return jsonResponse(200, {});
      }
      return jsonResponse(404, {});
    },
  });
  const empty = await store.read();
  assert.deepEqual(empty, { historyId: null, sentIds: [], generation: '0' });
  await store.write({ historyId: '8', sentIds: ['a'] }, '0');
  assert.match(writes[0].url, /ifGenerationMatch=0/);
  assert.deepEqual(writes[0].body, { historyId: '8', sentIds: ['a'] });
});

test('an empty webhook key sentinel does not become an authorization header', async () => {
  assert.equal(normalizeWebhookKey('__NO_WEBHOOK_KEY__'), '');
  assert.equal(normalizeWebhookKey(''), '');
  assert.equal(normalizeWebhookKey('real'), 'real');
  const config = await loadSecretConfig({ webhookKey: '' }, async (name) => {
    if (name.endsWith('key')) return '__NO_WEBHOOK_KEY__';
    return 'value';
  });
  assert.equal(config.webhookKey, '');
  assert.equal(config.oauthRefreshToken, 'value');
});

test('secret reader decodes the payload and caches it', async () => {
  let reads = 0;
  let now = 0;
  const readSecret = createSecretReader({
    projectId: 'demo',
    now: () => now,
    ttlMs: 1000,
    getAccessToken: async () => 'meta',
    fetchImpl: async (url) => {
      reads += 1;
      assert.match(url, /projects\/demo\/secrets\/gmail-oauth-refresh-token/);
      return jsonResponse(200, { payload: { data: Buffer.from('refresh-value').toString('base64') } });
    },
  });
  assert.equal(await readSecret('gmail-oauth-refresh-token'), 'refresh-value');
  now = 500;
  assert.equal(await readSecret('gmail-oauth-refresh-token'), 'refresh-value');
  assert.equal(reads, 1);
});

test('webhook client posts json with the authorization header and rejects redirects', async () => {
  const requests = [];
  const client = createWebhookClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(302, {});
    },
  });
  await assert.rejects(
    client.send({ id: '1' }, {
      webhookUrl: 'https://example.com/hook',
      webhookKey: 'secret',
      webhookAuthHeaderName: 'Authorization',
      webhookAuthScheme: 'Bearer',
    }),
    { code: 'webhook_http', status: 302 },
  );
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(requests[0].options.body, '{"id":"1"}');
  assert.equal(JSON.stringify(requests).includes('snippet'), false);
});
