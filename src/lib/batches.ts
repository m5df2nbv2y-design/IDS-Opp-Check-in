/**
 * Run `work` over every item, at most `size` at a time, in input order per batch.
 * Used where many independent database writes would otherwise run one by one.
 * shortcut: fixed batches rather than a sliding pool; fine at catalogue sizes.
 */
export async function inBatches<T>(items: readonly T[], size: number, work: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    // Settle the whole batch before failing, so no write is still landing after the refresh reports an error.
    const results = await Promise.allSettled(items.slice(i, i + size).map(work));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }
}
