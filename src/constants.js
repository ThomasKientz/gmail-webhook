export const SECRET = {
  clientId: 'gmail-oauth-client-id',
  clientSecret: 'gmail-oauth-client-secret',
  refreshToken: 'gmail-oauth-refresh-token',
  webhookKey: 'gmail-webhook-key',
};

export const DEFAULT_PAYLOAD_FIELDS = [
  'id',
  'threadId',
  'from',
  'to',
  'subject',
  'date',
  'snippet',
  'labelIds',
];

export const SENT_ID_LIMIT = 500;
export const DEFAULT_HISTORY_CAP = 500;
export const DEFAULT_EXPIRED_MAX = 10;
export const GMAIL_PUSH_PUBLISHER = 'gmail-api-push@system.gserviceaccount.com';
export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
