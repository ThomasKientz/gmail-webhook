import { reduceHistoryPages } from './history.js';

const METADATA_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'Message-ID', 'Reply-To'];
const PAGE_LIMIT = 20;

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function createGmailClient({ fetchImpl, getAccessToken }) {
  async function gmailFetch(url, { method = 'GET', body } = {}) {
    const token = await getAccessToken();
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await readJson(response);
    return { response, json };
  }

  function fail(response, fallback) {
    const error = new Error(fallback);
    error.code = fallback;
    error.status = response.status;
    return error;
  }

  return {
    async listAddedSince(startHistoryId, config) {
      const pages = [];
      let pageToken = '';
      const labelId =
        config.labelIds.length === 1 && config.labelFilterBehavior === 'include' ? config.labelIds[0] : '';

      do {
        const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
        url.searchParams.set('startHistoryId', String(startHistoryId));
        url.searchParams.append('historyTypes', 'messageAdded');
        url.searchParams.set('maxResults', '100');
        if (labelId) url.searchParams.set('labelId', labelId);
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const { response, json } = await gmailFetch(url);
        if (response.status === 404) {
          const error = new Error('history_expired');
          error.code = 'history_expired';
          error.status = 404;
          throw error;
        }
        if (!response.ok) throw fail(response, 'gmail_history_failed');
        pages.push(json);
        pageToken = json.nextPageToken || '';
      } while (pageToken && pages.length < PAGE_LIMIT);

      return reduceHistoryPages(pages, {
        cap: config.maxHistoryMessages,
        morePages: Boolean(pageToken),
      });
    },

    async listRecentMessages(config) {
      const labels =
        config.labelFilterBehavior === 'include' && config.labelIds.length ? config.labelIds : [null];
      const seen = new Set();
      const messages = [];

      for (const label of labels) {
        const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
        url.searchParams.set('maxResults', String(config.historyExpiredMaxMessages));
        if (label) url.searchParams.append('labelIds', label);
        const { response, json } = await gmailFetch(url);
        if (!response.ok) throw fail(response, 'gmail_list_failed');
        for (const message of json.messages || []) {
          if (!message?.id || seen.has(message.id)) continue;
          seen.add(message.id);
          messages.push({ id: message.id, threadId: message.threadId });
        }
      }

      return messages.slice(0, config.historyExpiredMaxMessages);
    },

    async getMessage(id, config) {
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
      url.searchParams.set('format', config.includeBody ? 'full' : 'metadata');
      if (!config.includeBody) {
        for (const header of METADATA_HEADERS) url.searchParams.append('metadataHeaders', header);
      }
      const { response, json } = await gmailFetch(url);
      if (!response.ok) throw fail(response, 'gmail_message_failed');
      return json;
    },

    async watch(config) {
      const body = {
        topicName: `projects/${config.projectId}/topics/${config.topic}`,
      };
      if (config.labelIds.length) {
        body.labelIds = config.labelIds;
        body.labelFilterBehavior = config.labelFilterBehavior;
      }
      const { response, json } = await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
        method: 'POST',
        body,
      });
      if (!response.ok || !json.historyId) throw fail(response, 'gmail_watch_failed');
      return { historyId: String(json.historyId), expiration: json.expiration ? String(json.expiration) : '' };
    },
  };
}
