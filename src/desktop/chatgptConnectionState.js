import { getConnections, updateConnection, entriesUsingConnection, updateEntry, resetEntryState } from '../Game/AI/providerConfig.js';

export function bindChatGPTProfile(connectionId, profileId) {
  const connection = getConnections().find(item => item.id === connectionId);
  if (!connection) return;
  const changed = connection.chatgptProfileId !== profileId;
  updateConnection(connectionId, { chatgptProfileId: profileId, ...(changed ? { suggestedModel: '' } : {}) });
  for (const entry of entriesUsingConnection(connectionId)) {
    if (changed) updateEntry(entry.id, { model: '' });
    resetEntryState(entry.id);
  }
}

export function selectedChatGPTModel(connection, entries) {
  if (!entries.length) return connection.suggestedModel || '';
  const models = new Set(entries.map(entry => entry.model || ''));
  return models.size === 1 ? entries[0].model || '' : '';
}
