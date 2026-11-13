const OBJECT_NAME = 'state.json';

function emptyState(generation) {
  return { historyId: null, sentIds: [], generation };
}

/**
 * One JSON object in Cloud Storage holds the cursor.
 * Secret Manager is a poor fit: the free tier allows six active versions and
 * the cursor changes on every notification. Firestore would add a database
 * for a single document. A bucket object supports ifGenerationMatch, so two
 * overlapping notifications cannot silently overwrite each other.
 */
export function createGcsStateStore({ bucket, fetchImpl, getAccessToken }) {
  const mediaUrl =
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}` +
    `/o/${encodeURIComponent(OBJECT_NAME)}?alt=media`;

  return {
    async read() {
      const token = await getAccessToken();
      const response = await fetchImpl(mediaUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 404) return emptyState('0');
      if (!response.ok) {
        const error = new Error('state_read_failed');
        error.code = 'state_read_failed';
        error.status = response.status;
        throw error;
      }
      const generation = response.headers.get('x-goog-generation') || '0';
      const json = await response.json();
      return {
        historyId: json?.historyId ? String(json.historyId) : null,
        sentIds: Array.isArray(json?.sentIds) ? json.sentIds.filter((id) => typeof id === 'string') : [],
        generation,
      };
    },

    async write(state, generation) {
      const token = await getAccessToken();
      const upload =
        `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}` +
        `/o?uploadType=media&name=${encodeURIComponent(OBJECT_NAME)}` +
        `&ifGenerationMatch=${encodeURIComponent(generation)}`;
      const response = await fetchImpl(upload, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          historyId: state.historyId,
          sentIds: state.sentIds,
        }),
      });
      if (response.status === 412 || response.status === 409) {
        const error = new Error('state_conflict');
        error.code = 'state_conflict';
        error.status = response.status;
        throw error;
      }
      if (!response.ok) {
        const error = new Error('state_write_failed');
        error.code = 'state_write_failed';
        error.status = response.status;
        throw error;
      }
      await response.body?.cancel?.();
    },
  };
}
