import { createQueue } from '.';
import { PatchRequest } from '../bot/types';

/** Read-only look at the queue, for checking the bot end works. `npm run queue:peek`. */
async function main(): Promise<void> {
  const queue = createQueue<PatchRequest>();
  const { pending, claimed } = await queue.depth();
  console.log(`pending: ${pending}  claimed: ${claimed}`);

  for (const job of await queue.peek(pending)) {
    console.log(`\n${job.id}  ${job.enqueuedAt}  attempts=${job.attempts}`);
    console.log(`  ${job.payload.author.username}: ${job.payload.text}`);
    console.log(`  ${job.payload.origin.url}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
