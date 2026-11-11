import fs from 'node:fs/promises';
import path from 'node:path';
import Video from '../../models/Video.js';
import Story from '../../models/Story.js';
import GenerationJob from '../../models/GenerationJob.js';
import AISettings from '../../models/AISettings.js';

export async function deleteVideoAssets(videoId) {
  const dir = path.resolve('storage', 'videos', String(videoId));
  await fs.rm(dir, { recursive: true, force: true });
}

export async function permanentlyDeleteVideo(videoId) {
  const video = await Video.findById(videoId).lean();
  if (!video) return { deleted: false, reason: 'not_found' };

  await deleteVideoAssets(video._id);
  await GenerationJob.deleteMany({ videoId: video._id });
  await Video.deleteOne({ _id: video._id });

  if (video.storyId) {
    const stillReferenced = await Video.exists({ storyId: video.storyId });
    if (!stillReferenced) await Story.deleteOne({ _id: video.storyId });
  }

  return { deleted: true, videoId: String(video._id), title: video.title };
}

export async function cleanupExpiredVideos({ now = new Date(), dryRun = false } = {}) {
  const settings = await AISettings.findOne({ key: 'global' }).lean();
  const enabled = settings?.retention?.autoDeleteEnabled ?? true;
  const days = Math.max(1, Number(settings?.retention?.days || 30));
  if (!enabled) return { enabled: false, days, deleted: 0, candidates: 0 };

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  // Auto-clean generated/unpublished content only. Published/scheduled content is retained.
  const protectedStatuses = ['PUBLISHED', 'SCHEDULED', 'UPLOADING'];
  const candidates = await Video.find({
    createdAt: { $lt: cutoff },
    status: { $nin: protectedStatuses }
  }).select('_id title createdAt status').lean();

  if (dryRun) return { enabled: true, days, cutoff, deleted: 0, candidates: candidates.length, videos: candidates };

  let deleted = 0;
  for (const video of candidates) {
    try {
      const result = await permanentlyDeleteVideo(video._id);
      if (result.deleted) deleted += 1;
    } catch (error) {
      console.error(`Auto-delete failed for video ${video._id}:`, error.message);
    }
  }
  return { enabled: true, days, cutoff, deleted, candidates: candidates.length };
}
