# Dashboard redesign + profile-driven generation (2026-11-16)

## Generation follows the saved channel profile
- `POST /api/agent/generate` now takes only `seriesId` (default = the default/active
  profile) and an optional `topic`. Language, format, length, hook style, tone,
  audience, visual style, aspect ratio and voice all come from the **saved** profile.
  Unsaved edits in the profile editor are never used.
- Each profile now stores `content.durationSec` (20–180 s, default 55) and
  `content.hookStyle`. Older profiles default to 55 s / Curiosity.
- Saving a profile merges into the existing saved profile, so channel-research fields
  (interests, pillars, source) are no longer dropped.
- The generate response returns the profile values used; the job payload stores the
  same snapshot. Old jobs keep resuming with their original values.

## New / fixed settings (all wired end-to-end)
- Subtitles: font, size (px), position (bottom / middle / top) and distance from edge
  (%) are now used by the renderer (previously ignored; Arial was hard-coded).
  Defaults reproduce the previous placement. "Burn subtitles" off now really disables
  burning (previously ignored). Note: FFmpeg's force_style on SRT uses legacy SSA
  alignment codes (2 bottom, 6 top, 10 middle).
- OCR text-check retries: 0–3 (default 2) under Settings → Image quality & OCR.
- Default profile = the existing "active" profile ("Set as default").
- Schema additions are optional fields (`video.subtitlePosition`,
  `video.subtitleOffsetPct`, `quality.ocrMaxRetries`); no migration needed.

## Dashboard (client/src/App.jsx, styles.css)
- 5 areas: Create, Videos, Channel Profiles, Analytics, Settings.
- Create: pick a saved profile (shows exactly what will be used), optional topic and
  research topic ideas, Generate, live job progress, stats, recent videos.
- Video details drawer with tabs: Overview (inline player, lifecycle, attempts),
  QA & review (QA report + audio details + human visual review), Scenes (regenerate
  image, re-render), Logs & export (Copy & Export Center, unchanged), Pipeline
  inspector (unchanged).
- Settings grouped: Providers · Video output · Image quality & OCR · Storage · Advanced
  (model names/temperature/tokens, media mode, legacy "Create starter profile" —
  formerly "Initialize Universe").
- `App` remains the default export and is mounted by `main.jsx`.

## Rollback
`git checkout -- client/src/App.jsx client/src/styles.css server/src` then delete
`server/test/profileAndSettings.test.js` and this file.

## Follow-up (2026-11-16 05:00)
- Fixed: Settings stuck on "Loading settings…" (and profiles empty) when the page opened
  while the backend was restarting — they loaded once only. They now retry every 3 s
  until loaded, reload when the backend reconnects, and Settings shows a Retry button.
  Load-error banners clear themselves after a successful retry.
- New: Delete profile (`DELETE /api/series/:id`). No videos yet → deleted with its
  characters. Has videos → archived (hidden, cannot generate; old videos can still be
  continued / re-rendered / scene-regenerated, which load the profile via story.seriesId).
  Refused while a video is generating with it. Deleting the default promotes the newest
  remaining profile. `Series.archived/archivedAt` are optional fields.
- New: Duplicate profile; unsaved-changes guard when switching profiles; Save is disabled
  when nothing changed; Hindi profile + English-only narration (Groq) warning in the editor.

## Fix (2026-11-16 05:30): backend crash during scene OCR
- Cause: tesseract.js re-throws every failed OCR job as an uncaught exception in the main
  process unless `createWorker` gets an `errorHandler`. One OCR failure therefore killed the
  whole backend (job then showed "Interrupted … no worker heartbeat"). Reproduced with the
  project's tesseract.js 6.0.1: a bad image → process exit 1 despite try/catch.
- Fix (`server/src/services/media/imageTextQa.js`): errorHandler; failed engine is discarded
  and recreated; 120 s OCR timeout; errors surface as "OCR failed: …" and the scene fails
  closed (never treated as clean). Verified with the real engine: process stays alive and
  later checks work. Regression test: `server/test/ocrResilience.test.js` (real engine).
- New: fatal errors are appended to `server/storage/logs/backend-crash.log` (git-ignored)
  with the active job id (`uncaughtExceptionMonitor`; normal crash behaviour unchanged).

## Fix (2026-11-16 05:45): images must match the narration
Found in real jobs: for Hindi profiles the story's visual prompts AND the Visual Director
plan were in Hindi, which FLUX cannot read (generic/unrelated images); prompts carried
video-editing directions ("camera zooms… then cuts to a bold text overlay", style "quick
zooms on speaker's face") that a still image cannot show (generic face close-ups, lettering).
- Visual Director plan v2 (`server/src/utils/visualPlan.js`): all fields in English, one still
  frame per scene that literally illustrates the narration, plus `narrationMeaning` (English).
  Non-English answers are retried once with stricter wording; old v1/Hindi plans are re-planned.
- Story generation (Gemini/OpenAI/OpenAI-compatible) now asks for English, single-frame
  visualPrompts without on-screen text.
- Image prompt builder: prefers English descriptions, adds "illustrates: <narration meaning>",
  strips zooms/cuts/transitions/text-overlay directions, uses an English still-image style,
  and drops non-English words for FLUX.
- Dashboard → Video details → Scenes: shows "Image should show: …" and the exact prompt sent.
- Existing videos: use "Regenerate image" on a scene (re-plans in English first).
