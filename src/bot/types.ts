/**
 * One natural-language request to change the game, lifted off Discord.
 *
 * This is the queue payload. The worker batches several of these into a single
 * agent prompt, so each one has to stand on its own — enough context to act on,
 * and enough addressing to report back to whoever asked.
 */
export interface PatchRequest {
  source: 'discord';
  /** Message text with the bot's own mention stripped out. */
  text: string;
  author: { id: string; username: string };
  /** Where to post progress and results back to. */
  origin: {
    guildId: string | null;
    channelId: string;
    messageId: string;
    /** Deep link to the message, handy in commit messages and PR bodies. */
    url: string;
  };
  createdAt: string;
}
