import { Message } from 'discord.js';
import { BotConfig } from './config';
import { PatchRequest } from './types';

/**
 * What to do with an incoming message.
 *
 * `ignore` is silent — most traffic in a channel isn't for us and shouldn't get
 * a reply. `reject` means the message *was* addressed to us but we won't act on
 * it, which is worth saying out loud so nobody is left waiting.
 */
export type Interpretation =
  | { kind: 'ignore'; reason: string }
  | { kind: 'reject'; reason: string }
  | { kind: 'enqueue'; request: PatchRequest };

/**
 * Pure message -> intent, so the filtering rules can be exercised without a
 * gateway connection.
 */
export function interpret(message: Message, botId: string, config: BotConfig): Interpretation {
  if (message.author.bot) return { kind: 'ignore', reason: 'authored by a bot' };
  if (!config.channelIds.has(message.channelId)) return { kind: 'ignore', reason: 'channel not watched' };
  // users (not `mentions.has`) so @everyone and role pings don't count as being
  // addressed. Replying to one of our messages does count — Discord pings the
  // replied-to user, which is the behaviour we want here.
  if (!message.mentions.users.has(botId)) return { kind: 'ignore', reason: 'not addressed to the bot' };

  if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(message.author.id)) {
    return { kind: 'reject', reason: "You're not on the allow-list for this bot." };
  }

  const text = stripMentions(message.content, botId);
  if (!text) {
    // Also what you get if the Message Content intent is off: the event fires
    // but content arrives empty.
    return { kind: 'reject', reason: 'Mention me with a description of the change you want.' };
  }

  return {
    kind: 'enqueue',
    request: {
      source: 'discord',
      text,
      author: { id: message.author.id, username: message.author.username },
      origin: {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        url: message.url,
      },
      createdAt: new Date(message.createdTimestamp).toISOString(),
    },
  };
}

/** `<@123>` and the legacy nickname form `<@!123>`. */
function stripMentions(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
