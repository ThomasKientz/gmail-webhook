import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuthorizationHeader, buildPayload, decodeBase64Url, extractPlainBody } from '../src/payload.js';

const message = {
  id: 'msg-1',
  threadId: 'thread-1',
  historyId: '40',
  internalDate: '1700000000000',
  snippet: 'Bonjour',
  labelIds: ['INBOX', 'UNREAD'],
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'Ada <ada@example.com>' },
      { name: 'To', value: 'one@example.com' },
      { name: 'To', value: 'two@example.com' },
      { name: 'Subject', value: 'Sujet' },
      { name: 'Date', value: 'Tue, 14 Nov 2023 10:00:00 +0000' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: Buffer.from('corps secret').toString('base64url') } },
      { mimeType: 'text/html', body: { data: Buffer.from('<p>corps secret</p>').toString('base64url') } },
    ],
  },
};

test('buildPayload keeps only requested fields and joins repeated headers', () => {
  const payload = buildPayload(message, {
    fields: ['id', 'from', 'to', 'subject', 'date', 'snippet', 'labelIds', 'unknown'],
    includeBody: false,
  });
  assert.deepEqual(payload, {
    id: 'msg-1',
    from: 'Ada <ada@example.com>',
    to: 'one@example.com, two@example.com',
    subject: 'Sujet',
    date: 'Tue, 14 Nov 2023 10:00:00 +0000',
    snippet: 'Bonjour',
    labelIds: ['INBOX', 'UNREAD'],
  });
  assert.equal('body' in payload, false);
  assert.equal(JSON.stringify(payload).includes('corps secret'), false);
});

test('buildPayload omits the body unless explicitly enabled', () => {
  const listed = buildPayload(message, { fields: ['id', 'body'], includeBody: false });
  assert.deepEqual(listed, { id: 'msg-1' });

  const included = buildPayload(message, { fields: ['body'], includeBody: true });
  assert.equal(included.body, 'corps secret');
});

test('extractPlainBody prefers text/plain and decodes base64url', () => {
  assert.equal(decodeBase64Url('YQ'), 'a');
  assert.equal(extractPlainBody(message.payload), 'corps secret');
  assert.equal(extractPlainBody({ mimeType: 'text/html', body: { data: 'PGk+' } }), '');
});

test('authorization header is configurable and omitted without a key', () => {
  assert.deepEqual(buildAuthorizationHeader({ headerName: 'Authorization', scheme: 'Bearer', key: 'secret' }), {
    name: 'Authorization',
    value: 'Bearer secret',
  });
  assert.deepEqual(buildAuthorizationHeader({ headerName: 'X-Api-Key', scheme: '', key: 'abc' }), {
    name: 'X-Api-Key',
    value: 'abc',
  });
  assert.equal(buildAuthorizationHeader({ headerName: 'Authorization', scheme: 'Bearer', key: '' }), null);
});
