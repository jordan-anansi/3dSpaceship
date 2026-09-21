import { Client, SendableChannels, TextBasedChannel } from 'discord.js';
import { Decision, DECISION_EMOJI, decisionFor } from './decisions';

/**
 * The only Discord the worker knows about. Keeps discord.js out of the
 * pipeline, and gives the resume path somewhere sane to live.
 */
export class DiscordSurface {
  constructor(
    private readonly client: Client,
    /** Empty means anyone who isn't a bot may decide. */
    private readonly allowedUserIds: Set<string>
  ) {}

  /** Post an approval prompt and pre-load the reactions. Returns its id. */
  async postPrompt(channelId: string, content: string): Promise<string | null> {
    const channel = await this.textChannel(channelId);
    if (!channel) return null;

    const message = await channel.send({ content: truncate(content), allowedMentions: { parse: [] } });
    for (const emoji of Object.keys(DECISION_EMOJI)) {
      await message.react(emoji).catch((err: unknown) => console.error('[worker] could not add reaction', err));
    }
    return message.id;
  }

  async say(channelId: string, content: string): Promise<void> {
    const channel = await this.textChannel(channelId);
    await channel?.send({ content: truncate(content), allowedMentions: { parse: [] } }).catch((err: unknown) => {
      console.error('[worker] send failed', err);
    });
  }

  /**
   * A decision already sitting on a prompt message.
   *
   * Reactions added while the process was down never fire an event, so the
   * only way to catch them is to go and look on startup.
   */
  async existingDecision(channelId: string, messageId: string): Promise<Decision | null> {
    const channel = await this.textChannel(channelId);
    if (!channel) return null;

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return null;

    for (const reaction of message.reactions.cache.values()) {
      const decision = decisionFor(reaction.emoji.name ?? '');
      if (!decision) continue;
      const users = await reaction.users.fetch().catch(() => null);
      if (!users) continue;
      for (const user of users.values()) {
        if (this.mayDecide(user.id, user.bot)) return decision;
      }
    }
    return null;
  }

  mayDecide(userId: string, isBot: boolean): boolean {
    if (isBot) return false;
    return this.allowedUserIds.size === 0 || this.allowedUserIds.has(userId);
  }

  /** Text channels we can both read history from and post into. */
  private async textChannel(channelId: string): Promise<(TextBasedChannel & SendableChannels) | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !channel.isSendable()) return null;
    return channel;
  }
}

/** Discord rejects anything over 2000 characters outright. */
function truncate(content: string, limit = 1990): string {
  return content.length <= limit ? content : `${content.slice(0, limit - 1)}…`;
}
