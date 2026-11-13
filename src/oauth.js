export function createAccessTokenProvider({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl,
  now = () => Date.now(),
}) {
  let cached = null;

  return async function getAccessToken() {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.access_token) {
      const invalid = json.error === 'invalid_grant';
      const error = new Error(invalid ? 'invalid_grant' : 'oauth_failed');
      error.code = invalid ? 'invalid_grant' : 'oauth_failed';
      error.status = response.status;
      throw error;
    }
    cached = {
      token: json.access_token,
      expiresAt: now() + (json.expires_in || 3600) * 1000,
    };
    return cached.token;
  };
}
