// Runs on every instance, on a timer. No coordination between instances is needed:
// the database lease in repo.reclaimStuckKey() guarantees only one instance re-drives a given key.

export function startRecoveryJob({ service, intervalMs }) {
  const timer = setInterval(async () => {
    try {
      const stuckKeys = await service.findStuckKeys();
      for (const key of stuckKeys) {
        try {
          await service.recover(key);
        } catch (err) {
          console.warn(`[recovery] ${key} failed, will retry next cycle: ${err.message}`);
        }
      }
      await service.expireSessions();
    } catch (err) {
      console.warn(`[recovery] cycle skipped (store unavailable?): ${err.message}`);
    }
  }, intervalMs);

  timer.unref(); // don't keep the process alive just for this timer
  return () => clearInterval(timer);
}