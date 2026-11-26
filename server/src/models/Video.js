import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  storyId:{type:mongoose.Schema.Types.ObjectId,ref:'Story'}, seriesId:{type:mongoose.Schema.Types.ObjectId,ref:'Series',index:true}, title:String,
  status:{type:String,enum:['QUEUED','PLANNED','SCRIPT_GENERATED','SCRIPT_QA','ASSETS_GENERATING','VIDEO_RENDERING','VIDEO_QA','SCENE_REVIEW','AWAITING_APPROVAL','APPROVED','UPLOADING','SCHEDULED','PUBLISHED','FAILED','CANCELLED'],default:'PLANNED'},
  // Skipped by the user: Autopilot no longer waits for this video before making a new one.
  skippedAt:{type:Date,default:null},
  // Narration check (audio complete, one voice, says the scene text): see narrationCheck.js.
  narrationCheck:{type:mongoose.Schema.Types.Mixed,default:null},
  statusHistory:[{status:String,at:{type:Date,default:Date.now},message:String,attempt:{type:Number,default:0},source:{type:String,default:'VIDEO'}}],
  durationSec:Number, renderPath:String, thumbnailPath:String, youtubeVideoId:String, scheduledAt:Date, youtubeMetadata:mongoose.Schema.Types.Mixed, pendingSceneEdit:mongoose.Schema.Types.Mixed,
  // prompt/promptKey/generatedAt describe what the image was MADE from (kept when reused);
  // currentPrompt is what the scene asks for now.
  mediaAssetDetails:[{sceneNumber:Number,path:String,mode:String,sizeBytes:Number,valid:Boolean,generatedAt:Date,reused:Boolean,prompt:String,promptKey:String,imagePromptUsed:String,currentPrompt:String,stale:Boolean}],
  qa:mongoose.Schema.Types.Mixed, visualReview:{imagesMatch:Boolean,subtitlesReadable:Boolean,ageAppropriate:Boolean,reviewedAt:Date}, media:{scenes:[String],audio:String,subtitles:String}, error:String
},{timestamps:true});
export default mongoose.model('Video',schema);
