import { SENT_ID_LIMIT } from './constants.js';

export function compareHistoryIds(left, right) {
  if (left == null || left === '') return right == null || right === '' ? 0 : -1;
  if (right == null || right === '') return 1;
  let a;
  let b;
  try {
    a = BigInt(left);
    b = BigInt(right);
  } catch {
    const error = new Error('history_id_invalid');
    error.code = 'history_id_invalid';
    throw error;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function maxHistoryId(left, right) {
  if (!left) return right ? String(right) : null;
  if (!right) return String(left);
  return compareHistoryIds(left, right) >= 0 ? String(left) : String(right);
}

export function messageMatchesLabelFilter(message, labelIds, behavior) {
  if (!labelIds.length) return true;
  const present = new Set(message.labelIds || []);
  if (behavior === 'include') return labelIds.some((label) => present.has(label));
  if (behavior === 'exclude') return labelIds.every((label) => !present.has(label));
  const error = new Error('label_filter_invalid');
  error.code = 'label_filter_invalid';
  throw error;
}

export function dedupeMessages(messages) {
  const seen = new Set();
  const unique = [];
  for (const message of messages) {
    if (!message?.id || seen.has(message.id)) continue;
    seen.add(message.id);
    unique.push(message);
  }
  return unique;
}

export function reduceHistoryPages(pages, { cap, morePages = false } = {}) {
  const messages = [];
  let lastRecordId = null;
  let mailboxHistoryId = null;
  let hitCap = false;
  const limit = cap ?? Number.POSITIVE_INFINITY;

  for (const page of pages) {
    if (page?.historyId) mailboxHistoryId = String(page.historyId);
    for (const record of page?.history || []) {
      const recordMessages = [];
      for (const added of record?.messagesAdded || []) {
        if (added?.message?.id) recordMessages.push(added.message);
      }
      if (messages.length > 0 && messages.length + recordMessages.length > limit) {
        hitCap = true;
        break;
      }
      messages.push(...recordMessages);
      if (record?.id) lastRecordId = String(record.id);
      if (messages.length >= limit) {
        hitCap = true;
        break;
      }
    }
    if (hitCap) break;
  }

  const truncated = hitCap || morePages;
  return {
    messages: dedupeMessages(messages),
    historyId: truncated ? lastRecordId || mailboxHistoryId : mailboxHistoryId,
    truncated,
  };
}

export function messagesToDeliver(messages, { labelIds, labelFilterBehavior, sentIds }) {
  const alreadySent = new Set(sentIds || []);
  const seen = new Set();
  const selected = [];
  for (const message of messages) {
    if (!message?.id || seen.has(message.id) || alreadySent.has(message.id)) continue;
    if (message.labelIds && !messageMatchesLabelFilter(message, labelIds, labelFilterBehavior)) {
      continue;
    }
    seen.add(message.id);
    selected.push(message);
  }
  return selected;
}

export function mergeState(current, patch, sentIdLimit = SENT_ID_LIMIT) {
  const sentIds = [...(current?.sentIds || [])];
  const known = new Set(sentIds);
  for (const id of patch?.sentIds || []) {
    if (id && !known.has(id)) {
      known.add(id);
      sentIds.push(id);
    }
  }
  return {
    historyId: maxHistoryId(current?.historyId, patch?.historyId),
    sentIds: sentIds.slice(-sentIdLimit),
  };
}

export function parsePushData(data) {
  if (data && typeof data === 'object' && data.historyId) {
    return { historyId: String(data.historyId) };
  }
  if (typeof data !== 'string' || !data) {
    const error = new Error('empty_notification');
    error.code = 'empty_notification';
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    const error = new Error('notification_unreadable');
    error.code = 'notification_unreadable';
    throw error;
  }
  if (!parsed?.historyId) {
    const error = new Error('missing_history_id');
    error.code = 'missing_history_id';
    throw error;
  }
  return { historyId: String(parsed.historyId) };
}

export function parseCloudEvent(cloudEvent) {
  const data = cloudEvent?.data?.message?.data;
  return parsePushData(data);
}
