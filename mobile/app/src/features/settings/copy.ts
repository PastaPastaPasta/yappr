import type { SettingsDTO } from '@engine/api';

import type { ThemePreference } from '~/state/appearance';

type NsfwMode = SettingsDTO['sensitiveContentMode'];
type NotificationType = 'likes' | 'reposts' | 'replies' | 'follows' | 'mentions';

/** Settings copy (UX_SPEC §5.10; PRD SET-01 – SET-09, AUTH-10, AUTH-11). */
export const copy = {
  title: 'Settings',
  sections: {
    account: 'Account',
    notifications: 'Notifications',
    privacy: 'Privacy & Safety',
    messages: 'Messages',
    appearance: 'Appearance',
    about: 'About',
    diagnostics: 'Engine diagnostics',
  },
  signedOut: {
    title: 'Sign in',
    description: 'Post, follow and message with your Dash identity.',
  },

  account: {
    id: 'Identity ID',
    copyId: 'Copy identity ID',
    idCopied: 'Identity ID copied',
    usernames: 'Usernames',
    noUsername: 'No username yet',
    register: 'Register a username on yap.pr',
    created: 'Account created',
    balance: 'Balance',
    refresh: 'Refresh balance',
    refreshFailed: "Couldn't refresh the balance. Please try again.",
    credits: (credits: string) => `${credits} credits`,
    accounts: 'Accounts',
    current: 'Current account',
    addAccount: 'Add account',
    appLock: 'App lock',
    signOut: 'Sign out',
    signOutOf: (name: string) => `Sign out of ${name}`,
    switchTo: (name: string) => `Switch to ${name}`,
    signOutTitle: (name: string) => `Sign out of ${name}?`,
    signOutMessage: 'Your keys for this account are removed from this phone. Your posts and data stay on Dash Platform.',
    signedOutDone: 'Signed out',
    signOutFailed: "Couldn't sign out. Please try again.",
    switching: (name: string) => `Switching to ${name}…`,
    switched: (name: string) => `Switched to ${name}`,
    switchFailed: "Couldn't switch accounts. Please try again.",
    adding: 'Getting ready to add an account…',
    addFailed: "Couldn't start adding an account. Please try again.",
    signingOut: 'Signing out…',
    signInFirst: 'Sign in to see your account.',
  },

  notifications: {
    header: 'In-app notifications',
    note: 'Yappr checks for new activity while the app is open.',
    types: [
      { key: 'likes', label: 'Likes', description: 'When someone likes your posts' },
      { key: 'reposts', label: 'Reposts', description: 'When someone reposts your content' },
      { key: 'replies', label: 'Replies', description: 'When someone replies to you' },
      { key: 'follows', label: 'Follows', description: 'When someone follows you' },
      { key: 'mentions', label: 'Mentions', description: 'When someone mentions you' },
    ] as const satisfies readonly { key: NotificationType; label: string; description: string }[],
  },

  privacy: {
    linkPreviews: 'Link previews',
    linkPreviewsDescription: 'Show previews with titles, descriptions, and images for links',
    linkPreviewsNote: 'Previews are fetched from the linked website, which can see that your device requested it.',
    mediaGate: "Blur media from people you don't follow",
    mediaGateDescription:
      "Images and link previews from accounts you don't follow stay hidden behind a blurred placeholder until you tap to reveal them",
    nsfw: 'NSFW content',
    nsfwModes: [
      { value: 'blur', title: 'Warn first', description: 'Cover NSFW posts until you choose to show them' },
      { value: 'show', title: 'Always show', description: 'Show NSFW posts without a warning' },
      { value: 'hide', title: 'Hide', description: 'Remove NSFW posts from your feeds' },
    ] as const satisfies readonly { value: NsfwMode; title: string; description: string }[],
    blocked: 'Blocked accounts',
    readReceipts: 'Read receipts',
    readReceiptsDescription: "Let others see when you've read their messages",
  },

  appearance: {
    theme: 'Theme',
    themes: [
      { value: 'system', title: 'System', description: 'Match your device' },
      { value: 'light', title: 'Light' },
      { value: 'dark', title: 'Dark' },
    ] as const satisfies readonly { value: ThemePreference; title: string; description?: string }[],
  },

  about: {
    name: 'Yappr',
    tagline: 'Decentralized social media on Dash Platform',
    version: 'Version',
    network: 'Network',
    engine: 'Engine',
    terms: 'Terms of Use',
    privacy: 'Privacy Policy',
    rules: 'Community rules',
    support: 'Support',
    licenses: 'Open-source licenses',
    web: 'Yappr on the web',
    poweredBy: 'Powered by Dash Platform',
    supportCopied: 'Support address copied. Send it from any email app.',
    rulesIntro: 'Yappr is a public network. By using it you agree to:',
    // UX_SPEC §5.1 terms.rule1–4: the same summary the terms gate shows.
    rulesSummary: [
      'No harassment, hate, threats or illegal content. There is zero tolerance for abuse.',
      "Reported content can be removed by the community's moderators, and abusive accounts can be banned.",
      'You can block anyone, and report posts that break these rules.',
      'What you post is public and permanent on Dash Platform.',
    ],
  },

  saveFailed: "Couldn't save that setting. Please try again.",
  loadFailed: "Couldn't load your settings.",
} as const;

export const THEME_LABEL: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };
