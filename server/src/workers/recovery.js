// Startup recovery for jobs orphaned by a backend crash or restart.
//
// This app runs exactly one in-process MongoDB worker. When the backend starts,
// no job can legitimately be RUNNING yet, so any RUNNING job was interrupted.
// Leaving it RUNNING blocks "Continue" forever ("already has an active job").
// Interrupted jobs are marked FAILED (not deleted); saved scenes and narration
// stay on disk, so the user can resume with Continue.
export const INTERRUPTED_MESSAGE = 'Interrupted by a backend restart or crash. Saved scenes and narration are kept; use Continue to resume.';

export async function recoverInterruptedJobs({ GenerationJob, setVideoStatus, now = () => new Date(), log = console }) {
  const running = await GenerationJob.find({ status: 'RUNNING' }).select('_id videoId retryCount cancelRequested').lean();
  const recovered = [];
  for (const item of running) {
    const cancelled = Boolean(item.cancelRequested);
    const status = cancelled ? 'CANCELLED' : 'FAILED';
    const at = now();
    const set = cancelled
      ? { status, step: 'CANCELLED', cancelledAt: at, completedAt: at }
      : { status, step: 'INTERRUPTED', error: INTERRUPTED_MESSAGE, failedAt: at };
    const message = cancelled ? 'Recovered a pending cancellation request during backend startup.' : INTERRUPTED_MESSAGE;
    // Only update if still RUNNING, so a job changed elsewhere is never overwritten.
    const updated = await GenerationJob.findOneAndUpdate(
      { _id: item._id, status: 'RUNNING' },
      { $set: set, $push: { logs: { at, message, level: 'warning' } } },
      { returnDocument: 'after' }
    );
    if (!updated) continue;
    if (item.videoId) {
      await setVideoStatus(item.videoId, status,
        cancelled ? 'Generation cancelled during backend restart. Saved assets can be resumed.' : INTERRUPTED_MESSAGE,
        cancelled ? 'keep' : 'set', Number(item.retryCount || 0));
    }
    recovered.push({ jobId: String(item._id), status });
  }
  if (recovered.length) log.warn?.(`Worker startup recovery: ${recovered.length} interrupted job(s) recovered.`);
  return recovered;
}
