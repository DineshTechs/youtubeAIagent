// Links videos to the channel profile (Series) that made them. Newer videos carry
// Video.seriesId; older ones are resolved through Story.seriesId.
export async function resolveVideoProfiles(videos,{Story,Series}){
  const missing=videos.filter(v=>!v.seriesId&&v.storyId).map(v=>v.storyId?._id||v.storyId);
  const stories=missing.length?await Story.find({_id:{$in:missing}}).select('seriesId').lean():[];
  const storySeries=new Map(stories.map(s=>[String(s._id),s.seriesId?String(s.seriesId):null]));
  const idOf=v=>v.seriesId?String(v.seriesId):(v.storyId?.seriesId?String(v.storyId.seriesId):storySeries.get(String(v.storyId?._id||v.storyId))||null);
  const ids=[...new Set(videos.map(idOf).filter(Boolean))];
  const series=ids.length?await Series.find({_id:{$in:ids}}).select('name archived').lean():[];
  const byId=new Map(series.map(s=>[String(s._id),s]));
  return videos.map(v=>{const id=idOf(v);const s=id?byId.get(id):null;return {...v,profile:id?{id,name:s?.name||'Deleted profile',archived:!s||Boolean(s.archived)}:null};});
}
// Mongo filter for "videos made with this profile" (including legacy videos).
export async function profileVideoFilter(seriesId,{Story,isValidId}){
  if(!seriesId||seriesId==='ALL')return {};
  if(seriesId==='none')return {$and:[{$or:[{seriesId:null},{seriesId:{$exists:false}}]}]};
  if(!isValidId(seriesId))return {_id:null};
  const storyIds=await Story.find({seriesId}).distinct('_id');
  return {$or:[{seriesId},{$and:[{$or:[{seriesId:null},{seriesId:{$exists:false}}]},{storyId:{$in:storyIds}}]}]};
}
export function countByProfile(videos){
  const out={};
  for(const v of videos){const k=v.profile?.id||'none';const row=out[k]||(out[k]={total:0,name:v.profile?.name||'No profile',archived:Boolean(v.profile?.archived)});row[v.status]=(row[v.status]||0)+1;row.total++;}
  return out;
}
