export class MockAIProvider {
 async generateJson(_instruction, input = {}, label = 'skill'){
  if(label.includes('yt-script')) return {hooks:[{hook:`What happens when ${input.idea||'this idea'} changes the way you think?`},{hook:`You are probably missing this about ${input.idea||'this topic'}.`},{hook:`Here is the exact thing to know about ${input.idea||'this idea'}.`},{hook:`Why does ${input.idea||'this'} matter more than it seems?`},{hook:`I tested a simple idea about ${input.idea||'this topic'}.` }],script:`[ON SCREEN: ${input.idea||'Topic'}]\nHere is a development-mode script. Switch to a real provider for production content.`,runtimeEstimateSec:20};
  if(label.includes('yt-package')) return {pairs:[{title:`${input.topic||'This Idea'} Explained`,thumbnailText:'WATCH THIS'},{title:`The Simple Truth About ${input.topic||'This Idea'}`,thumbnailText:'THE TRUTH'},{title:`How ${input.topic||'This Idea'} Works`,thumbnailText:'HOW IT WORKS'}]};
  if(label.includes('yt-seo')) return {description:`Development description for ${input.title||input.topic||'video'}.`,tags:[],queries:[]};
  if(label.includes('yt-shorts')) return {shorts:[]};
  if(label.includes('yt-comment')) return {reply:[],heart:[],ignore:[],escalate:[],pin:null};
  if(label.includes('yt-plan')) return {days:[],rationale:'Development plan.'};
  if(label.includes('yt-audit')) return {findings:[],oneFix:'Collect real channel metrics before auditing.'};
  if(label.includes('channel research')) return {niche:'development-mode niche',audience:'general viewers',contentPillars:['Educational explainers','Practical tips','Curiosity-driven stories'],topicIdeas:['A fresh beginner-friendly topic','A surprising fact explained simply','A practical tip viewers can use','Common mistakes and how to avoid them','A simple myth vs fact'],titlePatterns:['How X Works','The Simple Truth About X'],hookPatterns:['You probably did not know this about X.'],formatPatterns:['Hook → explanation → example → takeaway'],visualStyle:'clean, engaging educational visuals',tone:'clear, helpful and energetic',avoidRepeating:[],strategySummary:'Development-mode strategy. Use a real AI provider for channel-specific research.'};
  throw new Error(`Mock provider has no ${label} implementation.`);
 }
 async qualityCheck({story,series,channelProfile={}}){
  const scenes=Array.isArray(story?.scenes)?story.scenes:[];
  const pass=Boolean(String(story?.title||'').trim()&&scenes.length>=3&&scenes.every(s=>String(s.narration||'').trim()&&String(s.visualPrompt||'').trim()));
  return {pass,score:pass?85:40,notes:pass?[]:['Mock QA: title, narration or scene visual prompt is missing.'],channelFit:{niche:channelProfile.niche||series?.niche||'General',audience:channelProfile.audience?.description||'General audience'},mode:'mock'};
 }

 async generateStory({series,channelProfile={},characters=[],episodeNumber,topic,language=channelProfile.language||series?.language||'English'}){
  const subject=topic||series.niche||'a useful idea';
  const title=`${subject}: A Clear Explanation`;
  const hi=String(language).toLowerCase().startsWith('hi');
  const scenes=[
   {sceneNumber:1,durationSec:8,visualPrompt:`A compelling opening visual that clearly represents ${subject}, cinematic composition, channel style ${channelProfile.visual?.style||series.visualStyle||'clean professional visuals'}.`,narration:hi?`${subject} के बारे में एक ऐसी बात है जिसे समझना ज़रूरी है।`:`There is something important about ${subject} that is worth understanding.`,onScreenText:''},
   {sceneNumber:2,durationSec:12,visualPrompt:`A clear visual explanation of the central idea behind ${subject}, with concrete objects and an informative composition.`,narration:hi?`आइए इसे एक आसान उदाहरण से समझते हैं।`:`Let's understand the main idea through a clear example.`,onScreenText:''},
   {sceneNumber:3,durationSec:15,visualPrompt:`A practical real-world example or demonstration related to ${subject}, realistic details and coherent action.`,narration:hi?`जब हम इसे वास्तविक जीवन में देखते हैं, तो इसका महत्व और स्पष्ट हो जाता है।`:`A practical example makes the idea easier to see in the real world.`,onScreenText:''},
   {sceneNumber:4,durationSec:12,visualPrompt:`A concise visual summary of ${subject}, a strong final composition that reinforces the key takeaway.`,narration:hi?`यही इसका मुख्य निष्कर्ष है।`:`That is the key takeaway to remember.`,onScreenText:''}
  ];
  return {title,topic:subject,hook:scenes[0].narration,script:scenes.map(x=>x.narration).join(' '),scenes};
 }
}
