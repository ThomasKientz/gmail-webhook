import assert from 'node:assert/strict';
import test from 'node:test';

test('the functions entrypoints load', async () => {
  const module = await import('../index.js');
  assert.equal(typeof module.onGmailPush, 'function');
  assert.equal(typeof module.renewWatch, 'function');
});
