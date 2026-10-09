import { MessageSettingsScreen } from '~/features/messages/MessageSettingsScreen';

// Shared across the tabs (UX_SPEC §3.2): Settings pushes it on Profile, the
// inbox gear on Messages, so Back returns to where the user was. As a
// Messages-only route, Settings' push switched tabs, and when the Messages
// stack had not been opened yet it became that stack's only screen.
export default MessageSettingsScreen;
