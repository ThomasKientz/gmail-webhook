const HEADER_FIELDS = {
  from: 'from',
  to: 'to',
  cc: 'cc',
  bcc: 'bcc',
  subject: 'subject',
  date: 'date',
  messageId: 'message-id',
  replyTo: 'reply-to',
};

const DIRECT_FIELDS = new Set(['id', 'threadId', 'snippet', 'historyId', 'internalDate']);

export function decodeBase64Url(data) {
  if (!data) return '';
  const padding = data.length % 4 === 0 ? '' : '='.repeat(4 - (data.length % 4));
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/') + padding;
  return Buffer.from(normalized, 'base64').toString('utf8');
}

export function indexHeaders(headers = []) {
  const indexed = new Map();
  for (const header of headers) {
    if (!header?.name) continue;
    const key = header.name.toLowerCase();
    const value = header.value || '';
    indexed.set(key, indexed.has(key) ? `${indexed.get(key)}, ${value}` : value);
  }
  return indexed;
}

export function extractPlainBody(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts || []) {
    const found = extractPlainBody(child);
    if (found) return found;
  }
  return '';
}

export function buildPayload(message, { fields, includeBody }) {
  const headers = indexHeaders(message?.payload?.headers);
  const payload = {};
  for (const field of fields) {
    if (field === 'labelIds') {
      payload.labelIds = Array.isArray(message?.labelIds) ? [...message.labelIds] : [];
    } else if (DIRECT_FIELDS.has(field)) {
      payload[field] = message?.[field] ?? '';
    } else if (HEADER_FIELDS[field]) {
      payload[field] = headers.get(HEADER_FIELDS[field]) || '';
    } else if (field === 'body' && includeBody) {
      payload.body = extractPlainBody(message?.payload);
    }
  }
  return payload;
}

export function buildAuthorizationHeader({ headerName, scheme, key }) {
  if (!key) return null;
  return {
    name: headerName || 'Authorization',
    value: scheme ? `${scheme} ${key}` : key,
  };
}
