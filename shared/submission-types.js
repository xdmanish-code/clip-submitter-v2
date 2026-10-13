export const SubmissionType = {
  DUAL: "dual",
  KICK: "kick",
  CLIPSTER: "clipster"
};

export const SubmissionTypeMetadata = {
  [SubmissionType.DUAL]: {
    id: "dual",
    name: "Dual Submission",
    subtitle: "Cleanframe → Discord (/submit)",
    description: "Scan Cleanframe pending queue, submit to Discord bot (/submit), verify bot response, and sync status back to Cleanframe.",
    status: "available",
    badge: "Active",
    badgeClass: "badge-success"
  },
  [SubmissionType.KICK]: {
    id: "kick",
    name: "Kick Submission",
    subtitle: "Kick Discord Channel (/<creator> links)",
    description: "Submit selected reels directly to the Kick Discord channel using dynamic /<creator> slash commands and links argument.",
    status: "available",
    badge: "Active",
    badgeClass: "badge-success"
  },
  [SubmissionType.CLIPSTER]: {
    id: "clipster",
    name: "Clipster Submission",
    subtitle: "Coming soon",
    description: "Clipster submission automation is not configured yet.",
    status: "coming_soon",
    badge: "Coming Soon",
    badgeClass: "badge-disabled"
  }
};
