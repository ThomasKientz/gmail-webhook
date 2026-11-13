import assert from 'node:assert/strict';
import test from 'node:test';
import { processNotification, renewWatch } from '../src/process.js';

function baseConfig(overrides = {}) {
  return {
    projectId: 'demo',
    topic: 'gmail-notifications',
    labelIds: ['INBOX'],
    labelFilterBehavior: 'include',
    payloadFields: ['id', 'subject', 'snippet'],
    includeBody: false,
    webhookUrl: 'https://example.com/hook',
    webhookKey: 'key',
    webhookAuthHeaderName: 'Authorization',
    webhookAuthScheme: 'Bearer',
    maxHistoryMessages: 100,
    historyExpiredMaxMessages: 5,
    ...overrides,
  };
}

function memoryState(initial = {}) {
  const store = {
    generation: '0',
    historyId: null,
    sentIds: [],
    conflictsLeft: 0,
    ...initial,
  };
  return {
    store,
    async read() {
      return {
        historyId: store.historyId,
        sentIds: [...store.sentIds],
        generation: store.generation,
      };
    },
    async write(next, generation) {
      if (generation !== store.generation) {
        const error = new Error('conflict');
        error.status = 412;
        throw error;
      }
      if (store.conflictsLeft > 0) {
        store.conflictsLeft -= 1;
        const error = new Error('conflict');
        error.status = 412;
        throw error;
      }
      store.historyId = next.historyId;
      store.sentIds = [...next.sentIds];
      store.generation = String(Number(store.generation) + 1);
    },
  };
}

function message(id, subject) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX'],
    snippet: `snippet-${id}`,
    payload: { headers: [{ name: 'Subject', value: subject }] },
  };
}

test('a notification at or below the cursor is ignored', async () => {
  const state = memoryState({ historyId: '20', sentIds: [], generation: '4' });
  let listed = false;
  const result = await processNotification({
    notificationHistoryId: '20',
    config: baseConfig(),
    state,
    gmail: { listAddedSince: async () => { listed = true; return { messages: [], historyId: '20' }; } },
    webhook: { send: async () => { throw new Error('should not send'); } },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(listed, false);
  assert.equal(state.store.generation, '4');
});

test('the first notification only records a baseline', async () => {
  const state = memoryState();
  const result = await processNotification({
    notificationHistoryId: '15',
    config: baseConfig(),
    state,
    gmail: { listAddedSince: async () => { throw new Error('should not list'); } },
    webhook: { send: async () => { throw new Error('should not send'); } },
  });
  assert.equal(result.status, 'baseline');
  assert.equal(state.store.historyId, '15');
  assert.deepEqual(state.store.sentIds, []);
});

test('new messages are posted once and the cursor advances', async () => {
  const state = memoryState({ historyId: '10', sentIds: ['old'], conflictsLeft: 1 });
  const sent = [];
  const result = await processNotification({
    notificationHistoryId: '30',
    config: baseConfig(),
    state,
    gmail: {
      async listAddedSince(start) {
        assert.equal(start, '10');
        return {
          messages: [
            { id: 'old', labelIds: ['INBOX'] },
            { id: 'new', labelIds: ['INBOX'] },
            { id: 'other', labelIds: ['SENT'] },
          ],
          historyId: '40',
          truncated: false,
        };
      },
      async getMessage(id) {
        return message(id, `Sujet ${id}`);
      },
    },
    webhook: {
      async send(payload, config) {
        assert.equal(config.webhookKey, 'key');
        sent.push(payload);
      },
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.sent, 1);
  assert.deepEqual(sent, [{ id: 'new', subject: 'Sujet new', snippet: 'snippet-new' }]);
  assert.equal(state.store.historyId, '40');
  assert.deepEqual(state.store.sentIds, ['old', 'new']);
});

test('a failed webhook keeps the cursor and remembers the messages already sent', async () => {
  const state = memoryState({ historyId: '10', sentIds: [] });
  const result = processNotification({
    notificationHistoryId: '30',
    config: baseConfig(),
    state,
    gmail: {
      async listAddedSince() {
        return {
          messages: [
            { id: 'a', labelIds: ['INBOX'] },
            { id: 'b', labelIds: ['INBOX'] },
          ],
          historyId: '40',
        };
      },
      async getMessage(id) {
        return message(id, id);
      },
    },
    webhook: {
      async send(payload) {
        if (payload.id === 'b') {
          const error = new Error('webhook_http');
          error.code = 'webhook_http';
          error.status = 500;
          throw error;
        }
      },
    },
  });
  await assert.rejects(result, { code: 'webhook_http' });
  assert.equal(state.store.historyId, '10');
  assert.deepEqual(state.store.sentIds, ['a']);
});

test('an expired history id falls back to recent messages', async () => {
  const state = memoryState({ historyId: '1', sentIds: ['kept'] });
  const result = await processNotification({
    notificationHistoryId: '90',
    config: baseConfig(),
    state,
    gmail: {
      async listAddedSince() {
        const error = new Error('history_expired');
        error.code = 'history_expired';
        throw error;
      },
      async listRecentMessages() {
        return [{ id: 'kept' }, { id: 'fresh' }];
      },
      async getMessage(id) {
        return message(id, id);
      },
    },
    webhook: { send: async () => {} },
  });
  assert.equal(result.status, 'history_expired');
  assert.equal(result.sent, 1);
  assert.equal(state.store.historyId, '90');
  assert.deepEqual(state.store.sentIds, ['kept', 'fresh']);
});

test('renewWatch calls users.watch and does not move an existing cursor', async () => {
  const state = memoryState({ historyId: '12', sentIds: ['a'] });
  let watched = null;
  const result = await renewWatch({
    config: baseConfig(),
    state,
    gmail: {
      async watch(config) {
        watched = config.topic;
        return { historyId: '99', expiration: '1700000000000' };
      },
    },
  });
  assert.equal(watched, 'gmail-notifications');
  assert.equal(result.expiration, '1700000000000');
  assert.equal(state.store.historyId, '12');
});

test('renewWatch stores the watch history id when no cursor exists', async () => {
  const state = memoryState();
  await renewWatch({
    config: baseConfig({ labelIds: [] }),
    state,
    gmail: {
      async watch() {
        return { historyId: '5', expiration: '1' };
      },
    },
  });
  assert.equal(state.store.historyId, '5');
});
