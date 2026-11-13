import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareHistoryIds,
  dedupeMessages,
  mergeState,
  messageMatchesLabelFilter,
  messagesToDeliver,
  parseCloudEvent,
  parsePushData,
  reduceHistoryPages,
} from '../src/history.js';

test('compareHistoryIds uses big integers', () => {
  assert.equal(compareHistoryIds('10', '2'), 1);
  assert.equal(compareHistoryIds('2', '10'), -1);
  assert.equal(compareHistoryIds('9007199254740993', '9007199254740992'), 1);
  assert.equal(compareHistoryIds('', '5'), -1);
  assert.throws(() => compareHistoryIds('nope', '1'), { code: 'history_id_invalid' });
});

test('reduceHistoryPages collects added messages and advances the cursor', () => {
  const reduced = reduceHistoryPages(
    [
      {
        historyId: '50',
        history: [
          {
            id: '21',
            messagesAdded: [
              { message: { id: 'a', threadId: 't1', labelIds: ['INBOX'] } },
              { message: { id: 'a', threadId: 't1', labelIds: ['INBOX'] } },
            ],
          },
          {
            id: '22',
            messagesAdded: [{ message: { id: 'b', threadId: 't2', labelIds: ['SENT'] } }],
          },
        ],
      },
      { historyId: '60', history: [], nextPageToken: undefined },
    ],
    { cap: 100 },
  );
  assert.deepEqual(
    reduced.messages.map((message) => message.id),
    ['a', 'b'],
  );
  assert.equal(reduced.historyId, '60');
  assert.equal(reduced.truncated, false);
});

test('reduceHistoryPages stops at the cap without skipping unread pages', () => {
  const reduced = reduceHistoryPages(
    [
      {
        historyId: '999',
        history: [
          { id: '3', messagesAdded: [{ message: { id: 'a', labelIds: ['INBOX'] } }] },
          { id: '4', messagesAdded: [{ message: { id: 'b', labelIds: ['INBOX'] } }] },
          { id: '5', messagesAdded: [{ message: { id: 'c', labelIds: ['INBOX'] } }] },
        ],
      },
    ],
    { cap: 2 },
  );
  assert.deepEqual(
    reduced.messages.map((message) => message.id),
    ['a', 'b'],
  );
  assert.equal(reduced.historyId, '4');
  assert.equal(reduced.truncated, true);
});

test('reduceHistoryPages does not split a history record', () => {
  const reduced = reduceHistoryPages(
    [
      {
        historyId: '999',
        history: [
          {
            id: '3',
            messagesAdded: [
              { message: { id: 'a' } },
              { message: { id: 'b' } },
            ],
          },
          { id: '4', messagesAdded: [{ message: { id: 'c' } }] },
        ],
      },
    ],
    { cap: 1 },
  );
  assert.deepEqual(
    reduced.messages.map((message) => message.id),
    ['a', 'b'],
  );
  assert.equal(reduced.historyId, '3');
  assert.equal(reduced.truncated, true);
});

test('reduceHistoryPages keeps the last record when more pages remain', () => {
  const reduced = reduceHistoryPages(
    [{ historyId: '80', history: [{ id: '7', messagesAdded: [{ message: { id: 'a' } }] }] }],
    { cap: 100, morePages: true },
  );
  assert.equal(reduced.historyId, '7');
  assert.equal(reduced.truncated, true);
});

test('label filter include is OR and exclude rejects any listed label', () => {
  const inbox = { labelIds: ['INBOX', 'UNREAD'] };
  const sent = { labelIds: ['SENT'] };
  assert.equal(messageMatchesLabelFilter(inbox, ['INBOX', 'Label_1'], 'include'), true);
  assert.equal(messageMatchesLabelFilter(sent, ['INBOX', 'Label_1'], 'include'), false);
  assert.equal(messageMatchesLabelFilter(inbox, ['SPAM'], 'exclude'), true);
  assert.equal(messageMatchesLabelFilter(inbox, ['UNREAD'], 'exclude'), false);
  assert.equal(messageMatchesLabelFilter(inbox, [], 'include'), true);
  assert.throws(() => messageMatchesLabelFilter(inbox, ['INBOX'], 'nope'), { code: 'label_filter_invalid' });
});

test('messagesToDeliver skips sent ids and non-matching labels', () => {
  const selected = messagesToDeliver(
    [
      { id: '1', labelIds: ['INBOX'] },
      { id: '1', labelIds: ['INBOX'] },
      { id: '2', labelIds: ['INBOX'] },
      { id: '3', labelIds: ['SPAM'] },
      { id: '4', threadId: 't' },
    ],
    { labelIds: ['INBOX'], labelFilterBehavior: 'include', sentIds: ['2'] },
  );
  assert.deepEqual(
    selected.map((message) => message.id),
    ['1', '4'],
  );
});

test('mergeState keeps the highest history id and a bounded sent list', () => {
  const merged = mergeState(
    { historyId: '10', sentIds: ['a', 'b'] },
    { historyId: '4', sentIds: ['b', 'c'] },
    3,
  );
  assert.equal(merged.historyId, '10');
  assert.deepEqual(merged.sentIds, ['a', 'b', 'c']);

  const trimmed = mergeState({ historyId: null, sentIds: ['a', 'b'] }, { historyId: '8', sentIds: ['c', 'd'] }, 2);
  assert.equal(trimmed.historyId, '8');
  assert.deepEqual(trimmed.sentIds, ['c', 'd']);
});

test('parseCloudEvent reads the base64 Pub/Sub envelope and ignores the mailbox address', () => {
  const data = Buffer.from(
    JSON.stringify({ emailAddress: 'person@example.com', historyId: '12345' }),
  ).toString('base64');
  assert.deepEqual(parseCloudEvent({ data: { message: { data } } }), { historyId: '12345' });
  assert.deepEqual(parsePushData({ historyId: 99 }), { historyId: '99' });
  assert.throws(() => parsePushData(''), { code: 'empty_notification' });
  assert.throws(() => parsePushData(Buffer.from('{}').toString('base64')), { code: 'missing_history_id' });
});

test('dedupeMessages keeps the first copy', () => {
  assert.deepEqual(
    dedupeMessages([{ id: 'a', labelIds: ['INBOX'] }, { id: 'a', labelIds: [] }, { id: '' }]).map((m) => m.labelIds),
    [['INBOX']],
  );
});
