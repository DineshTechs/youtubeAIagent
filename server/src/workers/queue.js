import GenerationJob from '../models/GenerationJob.js';
export async function enqueueGeneration(data){
  const now=new Date();
  return GenerationJob.create({
    type:'GENERATE_CHANNEL_VIDEO',
    status:'QUEUED',
    payload:data,
    logs:[{at:now,message:'Channel video generation job queued',level:'info'}]
  });
}
