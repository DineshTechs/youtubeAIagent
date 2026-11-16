import mongoose from "mongoose";

const schema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  premise: { type: String, required: true },
  niche: { type: String, default: "" },
  targetAge: { type: String, default: "General audience" },
  language: { type: String, default: "English" },
  visualStyle: { type: String, default: "Cinematic, high-quality visuals" },
  channelProfile: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  rules: { type: [String], default: [] },
  active: { type: Boolean, default: true },
  channelResearch: { type: mongoose.Schema.Types.Mixed, default: null },
  contentStrategy: { type: mongoose.Schema.Types.Mixed, default: null },
  topicIdeas: { type: [String], default: [] },
  topicCursor: { type: Number, default: 0 },
  // Deleted profiles that still have videos are archived (hidden), so older
  // videos can still be continued, re-rendered and regenerated.
  archived: { type: Boolean, default: false },
  archivedAt: { type: Date, default: null }
}, { timestamps: true });

export default mongoose.model("Series", schema);
