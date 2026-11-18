/**
 * `screen-frame`: what one picture of the window in front shows
 * (`ScreenFrameSensor`, `ocr.jev.frames`, off unless the owner turns it on).
 * The state names the image by its asset id and carries the app's family; the
 * image itself rides beside the state as an asset and is never logged. `focus`
 * is Jev's `box`: where on the frame the main content sits.
 */
import type { JudgementResultPayload, ScreenFrameReading } from '@sundial/kernel/types.js';
import { choice, noul, type QuestionSet, keyed } from './index.js';

export const FRAME_ASSET_ID = 'frame-1';

export interface ScreenFrameInput {
  appFamily: string;
}

export const FRAME_SHOWS = {
  code: 'Source code in an editor.',
  terminal: 'A terminal or console.',
  document: 'A text document, notes or a PDF.',
  web_page: 'A web page or web app.',
  chat: 'A chat or mail conversation.',
  video_call: 'A video call: faces or name tiles of people.',
  slides: 'A presentation slide.',
  spreadsheet: 'A spreadsheet or table.',
  design: 'A design or drawing tool.',
  dashboard: 'A dashboard, chart or monitoring view.',
  media: 'A video, music or images to look at.',
  other: 'Something else.',
};

// `box` is Jev's region primitive; the kernel's `JudgeQuestion` names it, the registry helpers do not.
export const SCREEN_FRAME_QUESTIONS = keyed('screen-frame', {
  shows: choice('What does the image `frame` show?', FRAME_SHOWS),
  meeting: noul('Is the image `frame` a video call or meeting with other people?'),
  error: noul('Does the image `frame` show an error message, a failure or a warning?'),
  focus: { type: 'box', instructions: 'Where in the image `frame` is the main content the owner is working on?' },
});

export const screenFrame: QuestionSet<[ScreenFrameInput]> = {
  id: 'screen-frame',
  build: (input) => ({ state: { frame: FRAME_ASSET_ID, app_family: input.appFamily }, questions: SCREEN_FRAME_QUESTIONS }),
  samples: () => [[{ appFamily: 'editor' }], [{ appFamily: 'generic' }]],
};

const p = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);
const unit = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);

/**
 * A `box` answer as `{ x, y, w, h }` in 0..1 of the frame, or null. Read
 * defensively, because the wire shape is not pinned by a recorded answer yet:
 * `{x,y,w,h}` / `{x,y,width,height}`, `[x1,y1,x2,y2]`, or `{x1,y1,x2,y2}`,
 * in pixels (scaled by the frame's size) or already in 0..1.
 */
export function boxOf(raw: unknown, size: { width: number; height: number }): ScreenFrameReading['focus'] {
  const r = (raw ?? null) as Record<string, unknown> | unknown[] | null;
  if (r === null || typeof r !== 'object') return null;
  let x1: number | null, y1: number | null, x2: number | null, y2: number | null;
  if (Array.isArray(r)) [x1, y1, x2, y2] = r.slice(0, 4).map(unit) as (number | null)[];
  else if ('x1' in r) [x1, y1, x2, y2] = [unit(r.x1), unit(r.y1), unit(r.x2), unit(r.y2)];
  else {
    const [x, y, w, h] = [unit(r.x), unit(r.y), unit(r.w ?? r.width), unit(r.h ?? r.height)];
    [x1, y1, x2, y2] = [x, y, x !== null && w !== null ? x + w : null, y !== null && h !== null ? y + h : null];
  }
  if (x1 === null || y1 === null || x2 === null || y2 === null || x2 <= x1 || y2 <= y1) return null;
  const pixels = Math.max(x2, y2) > 1;
  const [sx, sy] = pixels ? [size.width, size.height] : [1, 1];
  const clamp = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  const box = { x: clamp(x1 / sx), y: clamp(y1 / sy), w: clamp((x2 - x1) / sx), h: clamp((y2 - y1) / sy) };
  return box.w > 0 && box.h > 0 ? box : null;
}

/** Jev's answers about a frame, as the `screen:frame` payload's reading. */
export function screenFrameOf(answers: JudgementResultPayload['answers'] | undefined, size: { width: number; height: number }): Omit<ScreenFrameReading, 'at' | 'app'> {
  const shows = answers?.shows;
  const label = typeof shows?.choice === 'string' && shows.choice in FRAME_SHOWS ? shows.choice : null;
  const focus = answers?.focus as (Record<string, unknown> & { box?: unknown }) | undefined;
  return {
    shows: label,
    showsP: label === null ? null : p(shows?.probabilities?.[label] ?? shows?.confidence),
    meeting: p(answers?.meeting?.noul),
    error: p(answers?.error?.noul),
    focus: boxOf(focus?.box ?? focus?.bbox ?? focus, size),
  };
}
