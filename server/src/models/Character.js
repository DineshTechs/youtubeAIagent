import mongoose from "mongoose";

const schema = new mongoose.Schema({
  name: { type: String, required: true },
  seriesId: { type: mongoose.Schema.Types.ObjectId, ref: "Series", required: true },
  personality: String,
  appearance: String,
  voiceProfile: String,
  active: { type: Boolean, default: true }
}, { timestamps: true });

export default mongoose.model("Character", schema);
