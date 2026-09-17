/**
 * Suggestions for a routine's website field.
 *
 * An installed program can be discovered by scanning the computer; a website
 * cannot, so the list is two things the app already knows: the sites people
 * most often open at the start of a work session, and the addresses the user
 * has already put in their own routines. The second list comes first — a site
 * the user chose once is a better guess than a site most people use.
 */

import { normaliseAppName } from "@/lib/installed-app-utils";

export interface WebsiteSuggestion {
  name: string;
  url: string;
  /** Other names people type for it: `yt`, `mail`, `gpt`. */
  aliases?: string[];
  /** True for an address taken from the user's own routines. */
  fromRoutines?: boolean;
}

export const POPULAR_WEBSITES: WebsiteSuggestion[] = [
  { name: "Google", url: "https://www.google.com", aliases: ["search"] },
  { name: "Gmail", url: "https://mail.google.com", aliases: ["mail", "google mail", "email"] },
  { name: "Google Calendar", url: "https://calendar.google.com", aliases: ["calendar", "gcal"] },
  { name: "Google Drive", url: "https://drive.google.com", aliases: ["drive", "gdrive"] },
  { name: "Google Docs", url: "https://docs.google.com/document", aliases: ["docs", "gdocs"] },
  { name: "Google Sheets", url: "https://docs.google.com/spreadsheets", aliases: ["sheets"] },
  { name: "Google Slides", url: "https://docs.google.com/presentation", aliases: ["slides"] },
  { name: "Google Meet", url: "https://meet.google.com", aliases: ["meet"] },
  { name: "YouTube", url: "https://www.youtube.com", aliases: ["yt"] },
  { name: "YouTube Music", url: "https://music.youtube.com", aliases: ["ytmusic", "yt music"] },
  { name: "Claude", url: "https://claude.ai", aliases: ["claude ai", "anthropic"] },
  { name: "ChatGPT", url: "https://chatgpt.com", aliases: ["gpt", "openai", "chat gpt"] },
  { name: "Gemini", url: "https://gemini.google.com", aliases: ["bard", "google gemini"] },
  { name: "Perplexity", url: "https://www.perplexity.ai" },
  { name: "GitHub", url: "https://github.com", aliases: ["gh", "git"] },
  { name: "GitLab", url: "https://gitlab.com" },
  { name: "Stack Overflow", url: "https://stackoverflow.com", aliases: ["so"] },
  { name: "Vercel", url: "https://vercel.com/dashboard" },
  { name: "Supabase", url: "https://supabase.com/dashboard" },
  { name: "Outlook", url: "https://outlook.office.com/mail", aliases: ["outlook mail", "hotmail"] },
  { name: "Microsoft Teams", url: "https://teams.microsoft.com", aliases: ["teams", "ms teams"] },
  { name: "Microsoft 365", url: "https://www.office.com", aliases: ["office", "m365", "office 365"] },
  { name: "OneDrive", url: "https://onedrive.live.com" },
  { name: "Notion", url: "https://www.notion.so" },
  { name: "Figma", url: "https://www.figma.com" },
  { name: "Canva", url: "https://www.canva.com" },
  { name: "Trello", url: "https://trello.com" },
  { name: "Asana", url: "https://app.asana.com" },
  { name: "Jira", url: "https://home.atlassian.com", aliases: ["atlassian", "confluence"] },
  { name: "Linear", url: "https://linear.app" },
  { name: "ClickUp", url: "https://app.clickup.com" },
  { name: "Todoist", url: "https://app.todoist.com" },
  { name: "Slack", url: "https://app.slack.com/client" },
  { name: "Discord", url: "https://discord.com/app" },
  { name: "WhatsApp Web", url: "https://web.whatsapp.com", aliases: ["whatsapp", "wa"] },
  { name: "Telegram Web", url: "https://web.telegram.org", aliases: ["telegram"] },
  { name: "Zoom", url: "https://app.zoom.us" },
  { name: "LinkedIn", url: "https://www.linkedin.com" },
  { name: "X", url: "https://x.com", aliases: ["twitter"] },
  { name: "Reddit", url: "https://www.reddit.com" },
  { name: "Instagram", url: "https://www.instagram.com", aliases: ["ig", "insta"] },
  { name: "Facebook", url: "https://www.facebook.com", aliases: ["fb"] },
  { name: "Spotify", url: "https://open.spotify.com" },
  { name: "Netflix", url: "https://www.netflix.com" },
  { name: "Amazon", url: "https://www.amazon.com" },
  { name: "Wikipedia", url: "https://www.wikipedia.org", aliases: ["wiki"] },
  { name: "Google Translate", url: "https://translate.google.com", aliases: ["translate"] },
  { name: "Duolingo", url: "https://www.duolingo.com" },
  { name: "Coursera", url: "https://www.coursera.org" },
  { name: "LeetCode", url: "https://leetcode.com" },
  { name: "Medium", url: "https://medium.com" },
];

/** `https://www.github.com/user` becomes `github.com/user`, for matching and display. */
export function displayUrl(url: string): string {
  return url
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
}

/**
 * The popular sites plus every website already used in the user's routines,
 * with the user's own first and no address twice.
 */
export function websiteSuggestions(usedUrls: string[]): WebsiteSuggestion[] {
  const seen = new Set<string>();
  const suggestions: WebsiteSuggestion[] = [];

  const add = (suggestion: WebsiteSuggestion) => {
    const key = displayUrl(suggestion.url).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    suggestions.push(suggestion);
  };

  for (const url of usedUrls) {
    const popular = POPULAR_WEBSITES.find(
      (site) => displayUrl(site.url).toLowerCase() === displayUrl(url).toLowerCase(),
    );
    add({
      name: popular?.name ?? displayUrl(url),
      url: url.trim(),
      aliases: popular?.aliases,
      fromRoutines: true,
    });
  }
  POPULAR_WEBSITES.forEach(add);

  return suggestions;
}

/**
 * The suggestions matching what the user has typed, best first — ranked the
 * way the application picker ranks programs: an exact name or nickname, then
 * a name or address that starts with the text, then one that merely contains
 * it. An empty field lists everything.
 */
export function matchWebsites(
  suggestions: WebsiteSuggestion[],
  query: string,
  limit = 50,
): WebsiteSuggestion[] {
  const wanted = normaliseAppName(displayUrl(query));
  if (!wanted) return suggestions.slice(0, limit);

  const ranked: { tier: number; index: number; suggestion: WebsiteSuggestion }[] = [];

  suggestions.forEach((suggestion, index) => {
    const names = [suggestion.name, ...(suggestion.aliases ?? [])].map(normaliseAppName);
    const address = normaliseAppName(displayUrl(suggestion.url));

    const tier = names.includes(wanted)
      ? 0
      : names.some((name) => name.startsWith(wanted)) || address.startsWith(wanted)
        ? 1
        : names.some((name) => name.includes(wanted)) || address.includes(wanted)
          ? 2
          : -1;

    if (tier >= 0) ranked.push({ tier, index, suggestion });
  });

  ranked.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return ranked.slice(0, limit).map((entry) => entry.suggestion);
}
