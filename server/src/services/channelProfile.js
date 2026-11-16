const asText=(value,fallback='')=>String(value??'').trim()||fallback;
export const HOOK_STYLES=['Curiosity','Question','Surprise','Emotional','Problem / Solution'];
export const DEFAULT_DURATION_SEC=55;
// Per-video defaults now live on the profile. Duration is clamped to Shorts-friendly bounds.
export function normalizeDuration(value,fallback=DEFAULT_DURATION_SEC){const n=Number(value);return Number.isFinite(n)&&n>0?Math.max(20,Math.min(180,Math.round(n))):fallback;}
export function normalizeHookStyle(value,fallback='Curiosity'){const v=String(value||'').trim();return HOOK_STYLES.find(h=>h.toLowerCase()===v.toLowerCase())||fallback;}
const asList=value=>Array.isArray(value)?value.map(x=>String(x||'').trim()).filter(Boolean):[];

export function buildChannelProfile(series={},overrides={}){
  const base=series?.channelProfile&&typeof series.channelProfile==='object'?series.channelProfile:{};
  const override=overrides.channelProfile&&typeof overrides.channelProfile==='object'?overrides.channelProfile:{};
  const saved={...base,...override,
    audience:{...(base.audience||{}),...(override.audience||{})},
    content:{...(base.content||{}),...(override.content||{})},
    visual:{...(base.visual||{}),...(override.visual||{})},
    narration:{...(base.narration||{}),...(override.narration||{})},
    editorial:{...(base.editorial||{}),...(override.editorial||{})}
  };
  const audienceSaved=saved.audience&&typeof saved.audience==='object'?saved.audience:{};
  const visualSaved=saved.visual&&typeof saved.visual==='object'?saved.visual:{};
  const narrationSaved=saved.narration&&typeof saved.narration==='object'?saved.narration:{};
  const contentSaved=saved.content&&typeof saved.content==='object'?saved.content:{};
  const niche=asText(overrides.niche,asText(series.niche,asText(saved.niche,'General')));
  const explicitAudience=asText(overrides.audience,asText(audienceSaved.description,asText(saved.targetAudience,'')));
  const kidsNiche=/\b(kids?|children|preschool|toddler|nursery|cartoon for children)\b/i.test(`${niche} ${explicitAudience}`);
  const audienceDescription=asText(overrides.audience,asText(audienceSaved.description,asText(saved.targetAudience,(kidsNiche?asText(series.targetAge,'Children'):(asText(series.targetAge,'General audience')==='4-8'?'General audience':asText(series.targetAge,'General audience'))))));
  const language=asText(overrides.language,asText(saved.language,asText(series.language,'English')));
  const visualStyle=asText(overrides.visualStyle,asText(visualSaved.style,asText(series.visualStyle,'Cinematic, high-quality visuals')));
  const format=asText(overrides.channelContentFormat,asText(contentSaved.primaryFormat,asText(saved.contentFormat,'Explainer')));
  const aspectRatio=asText(overrides.aspectRatio,asText(visualSaved.aspectRatio,asText(saved.aspectRatio,'9:16')));
  const safetyMode=asText(saved.safetyMode,kidsNiche?'kids-and-family':'standard');
  return {
    version:1,channelName:asText(saved.channelName,asText(series.name,'YouTube Channel')),
    niche,subNiche:asText(saved.subNiche,''),premise:asText(series.premise,'Create original, useful content for this channel.'),
    audience:{description:audienceDescription,ageRange:asText(overrides.ageRange,asText(audienceSaved.ageRange,'')),knowledgeLevel:asText(audienceSaved.knowledgeLevel,'general'),interests:asList(audienceSaved.interests)},
    language,
    content:{primaryFormat:format,formats:asList(contentSaved.formats).length?asList(contentSaved.formats):[format],tone:asText(overrides.tone,asText(contentSaved.tone,asText(saved.tone,'Engaging and audience-appropriate'))),storytellingApproach:asText(contentSaved.storytellingApproach,'Clear, coherent and niche-appropriate'),pacing:asText(contentSaved.pacing,'Dynamic but easy to follow'),hookStyle:normalizeHookStyle(asText(overrides.hookStyle,asText(contentSaved.hookStyle,'Curiosity'))),durationSec:normalizeDuration(overrides.durationSec??contentSaved.durationSec),callToAction:asText(contentSaved.callToAction,'Natural and relevant to the channel')},
    visual:{style:visualStyle,aspectRatio,colorPalette:asText(visualSaved.colorPalette,'Consistent with the channel identity'),realism:asText(visualSaved.realism,'Match the selected visual style'),subtitleSafeArea:visualSaved.subtitleSafeArea!==false,avoidTextInImages:visualSaved.avoidTextInImages!==false},
    narration:{voiceStyle:asText(overrides.voiceStyle,asText(narrationSaved.voiceStyle,'Natural, clear and engaging')),audience:audienceDescription,pace:asText(narrationSaved.pace,'Natural'),energy:asText(narrationSaved.energy,'Confident and engaging'),language},
    editorial:{safetyMode,factChecking:saved.editorial?.factChecking!==false,originalityRules:asList(saved.editorial?.originalityRules).length?asList(saved.editorial.originalityRules):['Create original scripts and visuals','Do not copy source-channel scripts, titles or distinctive creative work','Avoid unsupported factual claims']},
    source:saved.source||'user-configured-or-legacy-series'
  };
}
export function channelProfileSummary(profile){return {niche:profile.niche,audience:profile.audience.description,language:profile.language,format:profile.content.primaryFormat,tone:profile.content.tone,visualStyle:profile.visual.style,aspectRatio:profile.visual.aspectRatio,voiceStyle:profile.narration.voiceStyle,safetyMode:profile.editorial.safetyMode};}
