import mongoose from "mongoose";

const schema = new mongoose.Schema({
  videoId: { type: mongoose.Schema.Types.ObjectId, ref: "Video", required: true },
  youtubeVideoId: String,
  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  averageViewDurationSec: { type: Number, default: 0 },
  retentionPct: { type: Number, default: 0 },
  capturedAt: { type: Date, default: Date.now }
}, { timestamps: true });

export default mongoose.model("AnalyticsSnapshot", schema);
