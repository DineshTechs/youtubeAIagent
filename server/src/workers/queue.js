import GenerationJob from '../models/GenerationJob.js';
export async function enqueueGeneration(data){
  const now=new Date();
  return GenerationJob.create({
    type:'GENERATE_DAILY_SHORT',
    status:'QUEUED',
    payload:data,
    logs:[{at:now,message:'Job queued',level:'info'}]
  });
}
