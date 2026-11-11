import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  type:{type:String,required:true}, status:{type:String,enum:['QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED'],default:'QUEUED'},
  progress:{type:Number,default:0}, videoId:{type:mongoose.Schema.Types.ObjectId,ref:'Video'}, step:String, error:String,
  payload:mongoose.Schema.Types.Mixed, retryCount:{type:Number,default:0}, cancelRequested:{type:Boolean,default:false},
  startedAt:Date, completedAt:Date, failedAt:Date, cancelledAt:Date, lastHeartbeatAt:Date,
  logs:[{at:{type:Date,default:Date.now},message:String,level:{type:String,default:'info'}}],
  pipelineTrace:[{stageId:String,stage:String,status:{type:String,enum:['RUNNING','COMPLETED','FAILED','CANCELLED','SKIPPED'],default:'RUNNING'},startedAt:Date,completedAt:Date,durationMs:Number,input:mongoose.Schema.Types.Mixed,output:mongoose.Schema.Types.Mixed,error:String,meta:mongoose.Schema.Types.Mixed}]
},{timestamps:true});
schema.index({status:1,createdAt:1});
schema.index({videoId:1,createdAt:-1});
export default mongoose.model('GenerationJob',schema);
