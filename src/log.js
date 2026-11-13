const ALLOWED_KEYS = ['severity', 'message', 'status', 'count', 'code'];

export function safeLog(entry) {
  const out = {};
  for (const key of ALLOWED_KEYS) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  console.log(JSON.stringify(out));
}
