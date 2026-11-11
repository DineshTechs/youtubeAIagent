import mongoose from 'mongoose';
const sceneSchema=new mongoose.Schema({sceneNumber:Number,durationSec:Number,visualPrompt:String,narration:String,onScreenText:String},{_id:false});
const schema=new mongoose.Schema({
 title:String, seriesId:{type:mongoose.Schema.Types.ObjectId,ref:'Series'}, episodeNumber:Number, topic:String, hook:String,
 script:mongoose.Schema.Types.Mixed, scenes:[sceneSchema], qa:{pass:Boolean,score:Number,notes:[String]}, youtubeOptimization:mongoose.Schema.Types.Mixed, pipelineData:mongoose.Schema.Types.Mixed
},{timestamps:true});
export default mongoose.model('Story',schema);
