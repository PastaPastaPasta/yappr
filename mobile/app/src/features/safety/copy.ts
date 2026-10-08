/** The safety strings (UX_SPEC §5.9, PRD SAFE-01 – SAFE-07). */

export const SUPPORT_EMAIL = 'support@yap.pr';

export type ReportNoun = 'post' | 'reply';

export const copy = {
  block: {
    title: (handle: string) => `Block ${handle}?`,
    /**
     * Only what a block enforces, per Messages backend (SR-20). DM v5: the
     * Block also blocks them in Messages (`blockWrite`), so they can't
     * message you; while Messages are locked on this device the block in
     * Messages waits for them to unlock here, so the sheet passes null then.
     * Legacy (testnet) DMs follow the account's blocks, which only stop
     * counting their messages as unread: they can still send.
     */
    body: (dm: 'v5' | 'legacy' | null) =>
      dm === 'v5'
        ? "They won't be able to message you, and you won't see their posts or replies. Blocks are public on Dash Platform."
        : dm === 'legacy'
          ? "You won't see their posts or replies. They can still message you, but it won't show as unread. Blocks are public on Dash Platform."
          : "You won't see their posts or replies. Blocks are public on Dash Platform.",
    addNote: 'Add a note',
    note: 'Note',
    noteHint: 'Anyone can see this note.',
    confirm: 'Block',
    blockedTitle: (handle: string) => `You blocked ${handle}`,
    blockedBody: "You won't see their posts in your feeds. Unblocking shows them again.",
    unblock: 'Unblock',
    self: 'You cannot block yourself',
    signIn: 'Sign in to block accounts',
    loadFailed: "Couldn't load this account. Try again in a moment.",
  },
  toast: {
    blocked: (handle: string) => `Blocked ${handle}`,
    unblocked: (handle: string) => `Unblocked ${handle}`,
    stillBlocked: 'Unblocked, but a block list you follow still hides them.',
    blockFailed: (block: boolean, handle: string | null) =>
      `Couldn't ${block ? 'block' : 'unblock'} ${handle ?? 'this account'}. Try again.`,
    unblockFailed: (handle: string) => `Couldn't unblock ${handle}. Try again.`,
    reportSent: 'Report sent',
    reportFailed: "Couldn't send your report. Try again.",
    reportCopied: 'Report address copied. Send it from any email app.',
    reportWithdrawn: 'Report withdrawn',
    reportGone: 'This report was already closed.',
    reportResolved: "The moderators already resolved this report, so it can't be withdrawn.",
    withdrawFailed: "Couldn't withdraw your report. Try again.",
  },
  blocked: {
    title: 'Blocked accounts',
    empty: "You haven't blocked anyone",
    emptyDescription: 'Accounts you block show up here.',
    /** Only for someone who follows at least one block list (set up on web). */
    listsNote: (lists: number) => `Also hidden by ${lists} block ${lists === 1 ? 'list' : 'lists'} you follow`,
    listsLink: 'Manage on yap.pr',
    signIn: 'Sign in to see the accounts you blocked',
  },
  report: {
    title: (noun: ReportNoun) => `Report ${noun}`,
    /** The one required disclosure: a report is a public document, and its author sees who filed it. */
    disclosure: 'Reports are public. Anyone, including the author, can see that you reported this, your reason and any details.',
    /** v13: the moderators' action fee every report pays, scaled by the network's fee multiplier. */
    fee: (dash: string) => `Reporting pays a moderation fee of about ${dash} to the moderators, plus the network fee.`,
    question: 'What is wrong with it?',
    details: (required: boolean) => (required ? 'Details (required)' : 'Details (optional)'),
    placeholder: 'Anything the moderators should know',
    submit: (noun: ReportNoun) => `Report ${noun}`,
    busy: 'Reporting…',
    loadFailed: (noun: ReportNoun) => `Couldn't load this ${noun}. Try again.`,
    duplicate: 'You already reported this.',
    gone: (noun: ReportNoun) => `This ${noun} no longer exists.`,
    /** `status`: how the moderators resolved it, null while open. */
    existing: (date: string, reason: string, status: string | null) =>
      `You reported this on ${date} for ${reason} · ${status === null ? 'Under review' : `Resolved: ${status}`}`,
    expiry: 'Reports close after 90 days.',
    sentTitle: 'Report sent',
    sentBody: 'Thanks for letting us know.',
    alsoBlock: (handle: string) => `Also block ${handle}`,
    withdraw: 'Withdraw report',
    /** v14: the network keeps a report once the moderators resolved it. */
    resolvedKept: "A resolved report can't be withdrawn. It closes 90 days after you sent it.",
    withdrawing: 'Withdrawing…',
    withdrawTitle: 'Withdraw your report?',
    withdrawBody: 'The moderators will no longer see it.',
    withdrawConfirm: 'Withdraw',
    done: 'Done',
    own: (noun: ReportNoun) => `You cannot report your own ${noun}`,
    signIn: 'Sign in to report posts',
    email: 'Email the Yappr team',
    emailTitle: 'Report by email',
    emailBody:
      'Reports go to the Yappr team by email for now. Your email app opens with a link to the post and the reason you chose.',
    /** A report the network refused because no moderation team is seated yet: the sheet offers email instead. */
    notSeated: "Your report wasn't sent. Send it by email instead.",
    emailSubject: (id: string) => `Report: post ${id}`,
  },
  cancel: 'Cancel',
  signIn: 'Sign in',
} as const;
