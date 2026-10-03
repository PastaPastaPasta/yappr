/** The safety strings (UX_SPEC §5.9, PRD SAFE-01 – SAFE-07). Marked "(web)" there: verbatim from web. */

export const SUPPORT_EMAIL = 'support@yap.pr';

export type ReportNoun = 'post' | 'reply';

export const copy = {
  block: {
    title: (handle: string) => `Block ${handle}?`,
    /**
     * SR-20: only what a block enforces, per Messages backend. Nothing stops
     * them sending: legacy (testnet) DMs follow the account's blocks, which
     * stop counting their messages as unread and close the composer; DM v5
     * (devnet) keeps its own private block list, set from the conversation.
     */
    body: (dm: 'v5' | 'legacy' | null) =>
      dm === 'legacy'
        ? "You won't see their posts or replies. They can still message you, but their messages won't show as unread, and you can't message them until you unblock them. Blocks are public on Dash Platform."
        : dm === 'v5'
          ? "You won't see their posts or replies. This doesn't stop their messages: to do that, block them from your conversation in Messages. Blocks are public on Dash Platform."
          : "You won't see their posts or replies. Blocks are public on Dash Platform.",
    note: 'Add a note (optional)',
    noteHint: 'Visible to anyone on Dash Platform',
    confirm: 'Block',
    blockedTitle: (handle: string) => `You blocked ${handle}`,
    blockedBody: "You won't see their posts in your feeds. Unblocking shows them again.",
    unblock: 'Unblock',
    self: 'You cannot block yourself',
    signIn: 'Sign in to block accounts',
    loadFailed: "Couldn't load this account. Try again in a moment.",
  },
  toast: {
    blocked: 'User blocked',
    unblocked: 'User unblocked',
    stillBlocked: 'Your block was removed, but a block list you follow still blocks this user',
    blockFailed: 'Failed to update block status',
    reportSent: 'Report sent',
    reportUnconfirmed:
      'Report sent. The network has not confirmed it yet; it reaches the moderators once it does.',
    reportCopied: 'Report address copied. Send it from any email app.',
    reportWithdrawn: 'Report withdrawn',
    reportGone: 'This report is already gone: the moderators dismissed it, or it was withdrawn elsewhere.',
    withdrawFailed: 'Failed to withdraw the report. Please try again.',
  },
  blocked: {
    title: 'Blocked accounts',
    empty: "You haven't blocked anyone",
    emptyDescription: 'Accounts you block show up here.',
    listsNote: 'Block lists you follow are managed on yap.pr.',
    listsLink: 'Open yap.pr',
    signIn: 'Sign in to see the accounts you blocked',
  },
  report: {
    title: (noun: ReportNoun) => `Report ${noun}`,
    disclosure: (noun: ReportNoun, resolved: boolean) =>
      `Your report goes to this community's moderators. Reports are public on Dash Platform: anyone, including the ${noun}'s author, can see that you reported it, the reason you pick and anything you write in the details.${
        resolved ? ' You can come back here to see how the moderators resolved it.' : ''
      } A report expires after 90 days.`,
    question: 'What is wrong with it?',
    details: (required: boolean) => (required ? 'Details (required)' : 'Details (optional)'),
    placeholder: 'Anything the moderators should know',
    submit: (noun: ReportNoun) => `Report ${noun}`,
    busy: 'Reporting…',
    checking: 'Checking whether you already reported it…',
    checkFailed: (noun: ReportNoun) => `Could not check whether you already reported this ${noun}. Try again in a moment.`,
    existingTitle: (noun: ReportNoun) => `You reported this ${noun}`,
    existing: (date: string, reason: string) => `On ${date} you reported it for ${reason}.`,
    pending: (noun: ReportNoun) =>
      `The moderators haven't resolved it yet; they'll mark it handled here once they review the ${noun}.`,
    pendingUnresolved: (noun: ReportNoun) =>
      `The moderators review it and may remove the ${noun} or dismiss the report.`,
    resolved: (status: string, date: string | null) =>
      `Resolved by the moderators: ${status}${date ? ` on ${date}` : ''}.`,
    notSeated: 'This opens once the community elects its moderation team. Nothing was posted.',
    sentTitle: 'Report sent',
    sentBody: 'Thanks. The moderators will review it.',
    alsoBlock: (handle: string) => `Also block ${handle}?`,
    withdraw: 'Withdraw report',
    withdrawing: 'Withdrawing…',
    withdrawTitle: 'Withdraw your report?',
    withdrawBody: 'The moderators will no longer see it.',
    withdrawConfirm: 'Withdraw',
    withdrawUnconfirmedTitle: 'Withdrawal not confirmed yet',
    withdrawUnconfirmedBody:
      'The network has not confirmed that your report is withdrawn. Check again in a moment; until it confirms, the moderators may still see it.',
    checkAgain: 'Check again',
    checkingAgain: 'Checking…',
    done: 'Done',
    own: (noun: ReportNoun) => `You cannot report your own ${noun}`,
    gone: (noun: ReportNoun) => `This ${noun} is gone, so there is nothing to report.`,
    signIn: 'Sign in to report posts',
    email: 'Email the Yappr team',
    emailTitle: 'Report by email',
    emailBody: (noun: ReportNoun) =>
      `Reports on this network go to the Yappr team by email. Your email app opens with a link to the ${noun}; add what is wrong with it and send.`,
    emailSubject: (id: string) => `Report: post ${id}`,
  },
  cancel: 'Cancel',
  signIn: 'Sign in',
} as const;
