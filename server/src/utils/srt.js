function ts(sec){
  const safe=Math.max(0,Number(sec)||0);
  const totalMs=Math.round(safe*1000);
  const h=Math.floor(totalMs/3600000);
  const m=Math.floor((totalMs%3600000)/60000);
  const s=Math.floor((totalMs%60000)/1000);
  const ms=totalMs%1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

// Keep each caption to at most two short lines. This prevents long scene
// narration from being rendered as a giant multi-line block over the image.
function wrapWords(value,maxChars=32){
  const words=String(value||'').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
  const lines=[];
  let line='';
  for(const word of words){
    const candidate=line?`${line} ${word}`:word;
    if(line && Array.from(candidate).length>maxChars){
      lines.push(line);
      line=word;
    }else line=candidate;
  }
  if(line) lines.push(line);
  return lines;
}

function makeCaptionGroups(text){
  const lines=wrapWords(text,24);
  const groups=[];
  for(let i=0;i<lines.length;i+=2) groups.push(lines.slice(i,i+2).join('\n'));
  return groups;
}

export function makeSrt(scenes=[],sceneDurations=[]){
  let cursor=0;
  let cue=1;
  const blocks=[];
  const sceneList=Array.isArray(scenes)?scenes:[];
  for(let sceneIndex=0;sceneIndex<sceneList.length;sceneIndex++){
    const scene=sceneList[sceneIndex];
    const measuredDuration=Number(Array.isArray(sceneDurations)?sceneDurations[sceneIndex]:NaN);
    const duration=Math.max(0.5,Number.isFinite(measuredDuration)&&measuredDuration>0?measuredDuration:(Number(scene?.durationSec)||7));
    // Subtitles must reflect spoken narration, not separate on-screen titles.
    const narration=String(scene?.narration||scene?.onScreenText||'').trim();
    const captions=makeCaptionGroups(narration);
    if(captions.length){
      const weights=captions.map(text=>Math.max(1,Array.from(text.replace('\n',' ')).length));
      const totalWeight=weights.reduce((a,b)=>a+b,0);
      let local=cursor;
      captions.forEach((caption,index)=>{
        const cueDuration=index===captions.length-1
          ? Math.max(0.15,cursor+duration-local)
          : duration*(weights[index]/totalWeight);
        const end=Math.min(cursor+duration,local+cueDuration);
        blocks.push(`${cue++}\n${ts(local)} --> ${ts(end)}\n${caption}\n`);
        local=end;
      });
    }
    cursor+=duration;
  }
  return blocks.join('\n');
}
