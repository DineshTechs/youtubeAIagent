import mongoose from 'mongoose';
// One automatic video per profile per time slot (unique), so restarts never create duplicates.
const schema=new mongoose.Schema({
  seriesId:{type:mongoose.Schema.Types.ObjectId,ref:'Series',required:true},
  slotAt:{type:Date,required:true},
  status:{type:String,enum:['WAITING','GENERATING','APPROVED','SCHEDULED','PUBLISHED','NEEDS_ATTENTION','FAILED','SKIPPED'],default:'GENERATING'},
  manual:{type:Boolean,default:false},
  jobId:{type:mongoose.Schema.Types.ObjectId,ref:'GenerationJob'},
  videoId:{type:mongoose.Schema.Types.ObjectId,ref:'Video'},
  // WAITING: the earlier, not yet published video this slot is waiting for.
  waitingForVideoId:{type:mongoose.Schema.Types.ObjectId,ref:'Video',default:null},
  attempts:{type:Number,default:1},
  uploadAttempts:{type:Number,default:0},
  nextActionAt:{type:Date,default:null},
  youtubeVideoId:String,
  error:String,
  log:[{at:{type:Date,default:Date.now},message:String,_id:false}]
},{timestamps:true});
schema.index({seriesId:1,slotAt:1},{unique:true});
schema.index({status:1,nextActionAt:1});
export default mongoose.model('AutopilotRun',schema);
