export type Decision = 'land' | 'park' | 'discard';

/** The reactions we put on an approval prompt, in the order they're added. */
export const DECISION_EMOJI: Record<string, Decision> = {
  '🚀': 'land',
  '📦': 'park',
  '🗑️': 'discard',
};

export const DECISION_HELP = [
  '🚀 land it — commit, push, and restart the server (tunnel URL is unchanged)',
  '📦 park it — set the change aside to apply later, working tree goes back to how it was',
  '🗑️ bin it — undo the change entirely',
].join('\n');

export function decisionFor(emoji: string): Decision | undefined {
  return DECISION_EMOJI[emoji];
}
