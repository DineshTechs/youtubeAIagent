// Recovery for jobs orphaned by a backend crash or restart.
//
// A running job sends a heartbeat (lastHeartbeatAt) at least every
// HEARTBEAT_INTERVAL_MS while its process is alive. A RUNNING job is only
// treated as interrupted when its heartbeat is older than STALE_AFTER_MS.
// This means a second backend process (or a fast restart) can never mark a
// job that another live process is still working on. Interrupted jobs are
// marked FAILED (not deleted); saved scenes and narration stay on disk, so the
// user can resume with Continue.
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const STALE_AFTER_MS = 120_000;
export const INTERRUPTED_MESSAGE = 'Interrupted by a backend restart or crash (no worker heartbeat for 2 minutes). Saved scenes and narration are kept; use Continue to resume.';

export function staleRunningFilter(now, staleAfterMs = STALE_AFTER_MS) {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  return {
    status: 'RUNNING',
    $or: [{ lastHeartbeatAt: { $lt: cutoff } }, { lastHeartbeatAt: { $exists: false } }, { lastHeartbeatAt: null }]
  };
}

export async function recoverInterruptedJobs({ GenerationJob, setVideoStatus, now = () => new Date(), staleAfterMs = STALE_AFTER_MS, excludeJobId = null, log = console }) {
  const at = now();
  const filter = staleRunningFilter(at, staleAfterMs);
  const candidates = await GenerationJob.find(filter).select('_id videoId retryCount cancelRequested').lean();
  const recovered = [];
  for (const item of candidates) {
    if (excludeJobId && String(item._id) === String(excludeJobId)) continue;
    const cancelled = Boolean(item.cancelRequested);
    const status = cancelled ? 'CANCELLED' : 'FAILED';
    const set = cancelled
      ? { status, step: 'CANCELLED', cancelledAt: at, completedAt: at }
      : { status, step: 'INTERRUPTED', error: INTERRUPTED_MESSAGE, failedAt: at };
    const message = cancelled ? 'Recovered a pending cancellation request after the worker stopped.' : INTERRUPTED_MESSAGE;
    // Re-check staleness atomically: if the owning process sent a heartbeat in
    // the meantime, the job is alive and is left untouched.
    const updated = await GenerationJob.findOneAndUpdate(
      { _id: item._id, ...filter },
      { $set: set, $push: { logs: { at, message, level: 'warning' } } },
      { returnDocument: 'after' }
    );
    if (!updated) continue;
    if (item.videoId) {
      await setVideoStatus(item.videoId, status,
        cancelled ? 'Generation cancelled while the backend was stopped. Saved assets can be resumed.' : INTERRUPTED_MESSAGE,
        cancelled ? 'keep' : 'set', Number(item.retryCount || 0));
    }
    recovered.push({ jobId: String(item._id), status });
  }
  if (recovered.length) log.warn?.(`Worker recovery: ${recovered.length} interrupted job(s) recovered.`);
  return recovered;
}
