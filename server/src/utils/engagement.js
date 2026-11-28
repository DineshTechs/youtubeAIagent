// Engagement / retention extras for rendered Shorts (all can be switched off in
// Settings → Output → Engagement):
//  • a short silent lead-in so the first word is never clipped by players
//  • slow "Ken Burns" motion on every scene image (alternating zoom / pan)
//  • the hook as big on-screen text for the first seconds
//  • a thin progress bar that fills during the video
//  • a "follow for more" call to action in the last seconds
// Pure helpers: no ffmpeg calls here, only the filters / ASS text the renderer uses.

export const LEAD_IN_SECONDS = 0.4;
export const ENGAGEMENT_DEFAULTS = {motion: true, hookTitle: true, progressBar: true, endCta: true, ctaText: ''};
export function engagementSettings(v = {}) {
  const e = v || {};
  return {
    motion: e.motion !== false, hookTitle: e.hookTitle !== false, progressBar: e.progressBar !== false, endCta: e.endCta !== false,
    ctaText: String(e.ctaText || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  };
}

// Scene i gets one of four gentle moves, so consecutive scenes never move the same way.
export const MOTION_ZOOM = 0.08;
export function motionFilter(index, {width, height, fps, duration}) {
  const N = Math.max(1, Math.round(duration * fps));
  const A = MOTION_ZOOM;
  const centreX = 'iw/2-(iw/zoom/2)', centreY = 'ih/2-(ih/zoom/2)';
  const moves = [
    {z: `1+${A}*on/${N}`, x: centreX, y: centreY},                    // slow zoom in
    {z: `${1 + A}`, x: `(iw-iw/zoom)*on/${N}`, y: centreY},            // pan left → right
    {z: `${1 + A}-${A}*on/${N}`, x: centreX, y: centreY},              // slow zoom out
    {z: `${1 + A}`, x: centreX, y: `(ih-ih/zoom)*(1-on/${N})`}         // pan bottom → top
  ];
  const m = moves[((index % moves.length) + moves.length) % moves.length];
  // Working at 2× size keeps the movement smooth (no 1-pixel jitter).
  return `scale=${width * 2}:${height * 2},zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=1:s=${width}x${height}:fps=${fps}`;
}

// What to show as on-screen hook text: the hook's first sentence if short, else the title.
const firstSentence = t => (String(t || '').replace(/\s+/g, ' ').trim().match(/^.+?[.!?।]["”’']?(?=\s|$)/u)?.[0] || String(t || '').replace(/\s+/g, ' ').trim());
export function onScreenHook({hook, title} = {}, max = 70) {
  const shorten = t => { const s = String(t || '').trim(); if (s.length <= max) return s; const cut = s.slice(0, max); return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 15)).trim()}…`; };
  const h = firstSentence(hook);
  if (h && h.length <= max) return h;
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (t && t.length <= max) return t;
  return shorten(h || t);
}
export function defaultCta(language = '') {
  return /hindi|हिंदी/i.test(String(language)) ? 'ऐसी और कहानियों के लिए फ़ॉलो करें' : 'Follow for more stories like this';
}

const assTime = s => { const t = Math.max(0, s); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60; return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`; };
const assText = t => String(t || '').replace(/[{}]/g, '').replace(/\\/g, '／').replace(/\r?\n/g, ' ').trim();

// ASS file with the hook text (start) and the call to action (end). It sits at the top,
// or in the middle when captions are at the top, so it never covers the captions.
export function overlayAss({width = 1080, height = 1920, fontName = 'Poppins Medium', hookText = '', hookEnd = 3, ctaText = '', total = 0, captionsAt = 'bottom'}) {
  const fs = Math.round(width * 0.062);           // ~67 px on 1080 wide
  const align = captionsAt === 'top' ? 5 : 8;     // 8 = top centre, 5 = middle centre
  const marginV = captionsAt === 'top' ? 0 : Math.round(height * 0.11);
  const side = Math.round(width * 0.08);
  const lines = [];
  if (hookText) lines.push(`Dialogue: 0,${assTime(0.1)},${assTime(Math.max(1.2, hookEnd))},Hook,,0,0,0,,{\\fad(150,300)}${assText(hookText)}`);
  if (ctaText && total >= 8) lines.push(`Dialogue: 0,${assTime(total - 3)},${assTime(total - 0.05)},Cta,,0,0,0,,{\\fad(250,0)}${assText(ctaText)}`);
  if (!lines.length) return '';
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,${fontName},${fs},&H00FFFFFF,&H00FFFFFF,&H003300E6,&H003300E6,1,0,0,0,100,100,0,0,3,${Math.round(fs * 0.28)},0,${align},${side},${side},${marginV},1
Style: Cta,${fontName},${Math.round(fs * 0.85)},&H00FFFFFF,&H00FFFFFF,&H00101010,&HB0101010,1,0,0,0,100,100,0,0,3,${Math.round(fs * 0.25)},0,${align},${side},${side},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;
}
