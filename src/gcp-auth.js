const METADATA_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export function createMetadataTokenProvider({ fetchImpl, now = () => Date.now() }) {
  let cached = null;

  return async function getMetadataAccessToken() {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const response = await fetchImpl(METADATA_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!response.ok) {
      const error = new Error('metadata_token_failed');
      error.code = 'metadata_token_failed';
      error.status = response.status;
      throw error;
    }
    const json = await response.json();
    if (!json.access_token) {
      const error = new Error('metadata_token_failed');
      error.code = 'metadata_token_failed';
      throw error;
    }
    cached = {
      token: json.access_token,
      expiresAt: now() + (json.expires_in || 3600) * 1000,
    };
    return cached.token;
  };
}
