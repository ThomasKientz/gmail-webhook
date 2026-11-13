import { compareHistoryIds, mergeState, messageMatchesLabelFilter, messagesToDeliver } from './history.js';
import { buildPayload } from './payload.js';

async function writeMerged(state, patch) {
  let lastError = new Error('state_conflict');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await state.read();
    const next = mergeState(current, patch);
    try {
      await state.write(next, current.generation);
      return next;
    } catch (error) {
      if (error.status !== 412 && error.status !== 409) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export async function processNotification({
  notificationHistoryId,
  config,
  gmail,
  state,
  webhook,
  log = () => {},
}) {
  const current = await state.read();
  if (current.historyId && compareHistoryIds(notificationHistoryId, current.historyId) <= 0) {
    log({ severity: 'INFO', message: 'notification déjà traitée', status: 'skipped' });
    return { status: 'skipped', sent: 0 };
  }

  if (!current.historyId) {
    await writeMerged(state, { historyId: String(notificationHistoryId), sentIds: [] });
    log({ severity: 'INFO', message: 'point de départ enregistré', status: 'baseline' });
    return { status: 'baseline', sent: 0 };
  }

  let collected;
  let expired = false;
  try {
    collected = await gmail.listAddedSince(current.historyId, config);
  } catch (error) {
    if (error.code !== 'history_expired') throw error;
    expired = true;
    const recent = await gmail.listRecentMessages(config);
    collected = {
      messages: recent,
      historyId: String(notificationHistoryId),
      truncated: false,
    };
    log({
      severity: 'WARNING',
      message: 'historyId expiré, reprise sur les messages récents',
      status: 'history_expired',
    });
  }

  const todo = messagesToDeliver(collected.messages, {
    labelIds: config.labelIds,
    labelFilterBehavior: config.labelFilterBehavior,
    sentIds: current.sentIds,
  });

  const sentIds = [];
  try {
    for (const ref of todo) {
      const message = await gmail.getMessage(ref.id, config);
      if (!messageMatchesLabelFilter(message, config.labelIds, config.labelFilterBehavior)) continue;
      const payload = buildPayload(message, {
        fields: config.payloadFields,
        includeBody: config.includeBody,
      });
      await webhook.send(payload, config);
      sentIds.push(ref.id);
    }
  } catch (error) {
    if (sentIds.length) {
      await writeMerged(state, { historyId: current.historyId, sentIds });
    }
    throw error;
  }

  const nextHistoryId = collected.historyId || notificationHistoryId;
  await writeMerged(state, { historyId: String(nextHistoryId), sentIds });
  return {
    status: expired ? 'history_expired' : 'ok',
    sent: sentIds.length,
    truncated: Boolean(collected.truncated),
  };
}

export async function renewWatch({ config, gmail, state }) {
  const watch = await gmail.watch(config);
  const current = await state.read();
  if (!current.historyId) {
    await writeMerged(state, { historyId: watch.historyId, sentIds: [] });
  }
  return { expiration: watch.expiration, historyId: watch.historyId };
}
