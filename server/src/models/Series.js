import mongoose from "mongoose";

const schema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  premise: { type: String, required: true },
  niche: { type: String, default: "" },
  targetAge: { type: String, default: "4-8" },
  language: { type: String, default: "English" },
  visualStyle: { type: String, default: "bright 3D children's animation" },
  rules: { type: [String], default: [] },
  active: { type: Boolean, default: true },
  channelResearch: { type: mongoose.Schema.Types.Mixed, default: null },
  contentStrategy: { type: mongoose.Schema.Types.Mixed, default: null },
  topicIdeas: { type: [String], default: [] },
  topicCursor: { type: Number, default: 0 }
}, { timestamps: true });

export default mongoose.model("Series", schema);
