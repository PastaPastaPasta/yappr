import type { ConversationDTO, MessageDTO } from '@engine/api';

/** Jest fixtures for the Messages tests. */

export const FLAGS: ConversationDTO['flags'] = {
  hidden: false,
  unreadable: false,
  removed: false,
  ended: false,
  blocked: false,
  unsaved: false,
  draft: false,
};

export const BOB_ID = 'BobId1111111111111111111111111111111111111';

export function conversation(overrides: Partial<ConversationDTO> = {}): ConversationDTO {
  return {
    key: 'd:alice-bob',
    backend: 'v5',
    kind: 'direct',
    peer: { id: BOB_ID, username: 'bob', displayName: 'Bob Builder', avatar: { uri: null, dicebear: null }, resolved: true },
    ownerId: null,
    name: null,
    members: [],
    isOwner: false,
    lastMessage: { text: 'see you there', at: new Date('2026-09-30T10:00:00Z'), own: false },
    lastActivity: new Date('2026-09-30T10:00:00Z'),
    unread: 0,
    flags: FLAGS,
    peerReadAt: null,
    ...overrides,
  };
}

export function dmMessage(id: string, overrides: Partial<MessageDTO> = {}): MessageDTO {
  return { id, sender: BOB_ID, text: id, at: new Date('2026-09-30T10:00:00Z'), own: false, pending: false, ...overrides };
}
