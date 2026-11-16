// Delete a channel profile safely.
// - Refused while a video is being generated with it.
// - No stories/videos yet: deleted completely (with its characters).
// - Has stories/videos: archived instead. Existing videos load their profile
//   through story.seriesId for Continue / Re-render / Regenerate scene, so the
//   document must stay. Archived profiles are hidden and cannot generate.
// - If the default (active) profile is removed, the newest remaining profile
//   becomes the default.
export class ProfileRemovalError extends Error { constructor(message, status) { super(message); this.status = status; } }

export async function removeSeries({ Series, Story, Character, GenerationJob }, id, { now = () => new Date() } = {}) {
  const series = await Series.findById(id);
  if (!series || series.archived) throw new ProfileRemovalError('Channel profile not found.', 404);
  const busy = await GenerationJob.exists({ status: { $in: ['QUEUED', 'RUNNING'] }, 'payload.seriesId': series._id });
  if (busy) throw new ProfileRemovalError('A video is being generated with this profile. Wait for it to finish or cancel it, then delete the profile.', 409);
  const wasActive = Boolean(series.active);
  const storyCount = await Story.countDocuments({ seriesId: series._id });
  let mode;
  if (storyCount === 0) {
    await Character.deleteMany({ seriesId: series._id });
    await Series.deleteOne({ _id: series._id });
    mode = 'deleted';
  } else {
    const at = now();
    // Free the unique name so a new profile can reuse it.
    series.name = `${series.name} (deleted ${at.toISOString().slice(0, 10)} ${String(series._id).slice(-4)})`;
    series.archived = true;
    series.archivedAt = at;
    series.active = false;
    await series.save();
    mode = 'archived';
  }
  let newDefault = null;
  if (wasActive) {
    const next = await Series.findOne({ archived: { $ne: true } }).sort({ createdAt: -1 });
    if (next) { await Series.updateMany({ _id: { $ne: next._id } }, { $set: { active: false } }); next.active = true; await next.save(); newDefault = { _id: next._id, name: next.name }; }
  }
  return { mode, storyCount, newDefault };
}
