import fs from 'node:fs';
import { getSundialHome } from '@sundial/helpers/config.js';
import path from 'node:path';
import { readScreenOcrSnapshot } from '../screen-ocr/screen-ocr-capture.js';
import { isPrivateCapture } from '../screen-ocr/index.js';
import { classifyLlmError, type LlmErrorClass } from '@sundial/helpers/llm-error-class.js';

/**
 * J3.3 — screen understanding. The OCR helper writes a downscaled frame
 * (`screen-frame.jpg`) beside its text when `ocr.vision.enabled`; this sensor
 * hands the frame to a LOCAL vision model in Ollama and emits at most three
 * short facts about what is on screen. The frame never leaves the machine;
 * the facts are sanitized at ingest like any title. One call at a time, on
 * the sensor's own interval, skipped for sensitive and hidden apps.
 */
export interface ScreenFactEvent {
  type: 'screen:fact';
  payload: { timestamp: string; processName: string | null; model: string; facts: string[]; latencyMs: number };
}

export interface ScreenVisionConfig {
  enabled: boolean;
  model: string;
  intervalMs: number;
  framePath?: string;
  ollamaUrl?: string;
  fetchImpl?: typeof fetch;
  /** W3: the one `llm_audit` writer (`openLlmAudit`), injected by the sensor runtime so this package needs no model package. */
  /** W5: the one budget gate (`reserveLlmCall('vision')`), injected likewise: the call id, or null when refused. */
  reserve?: (purpose: 'vision') => Promise<string | null>;
  openAudit?: (row: { id?: string; momentId: null; purpose: string; model: string; prompt: string; route: string }) => Promise<{ settle(patch: { respondedAt: string; latencyMs: number; success: boolean; statusCode?: number; responseContent?: string; error?: string; errorClass?: LlmErrorClass }): Promise<void> }>;
}

const PROMPT =
  'This is a screenshot of one application window on a work computer. Reply with JSON only: {"facts": ["…"]} — at most three short factual statements (under 120 characters each) about the WORK visible: which document, page, code, task or content is shown and what state it is in. Never include people\'s names, email addresses, phone numbers, message contents, passwords or numbers that look like identifiers. If the screen shows nothing readable, reply {"facts": []}.';

export class ScreenVisionSensor {
  private lastAt = 0;
  private lastMtimeMs = 0;
  private inFlight = false;
  private buffered: ScreenFactEvent[] = [];
  private readonly framePath: string;
  private readonly ollamaUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ScreenVisionConfig) {
    this.framePath = config.framePath ?? path.join(getSundialHome(), '.daemon', 'screen-frame.jpg');
    this.ollamaUrl = config.ollamaUrl ?? 'http://127.0.0.1:11434/api/generate';
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Emits what the last call produced; kicks the next call when due. Never blocks the poll. */
  poll(now = Date.now()): ScreenFactEvent[] {
    const out = this.buffered;
    this.buffered = [];
    if (!this.config.enabled || process.platform !== 'darwin' || this.inFlight || now - this.lastAt < this.config.intervalMs) return out;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.framePath);
    } catch {
      return out;
    }
    // A frame older than two intervals is a helper that stopped writing, not a screen worth describing twice.
    if (stat.mtimeMs === this.lastMtimeMs || now - stat.mtimeMs > 2 * this.config.intervalMs) return out;
    const ocr = readScreenOcrSnapshot();
    const processName = ocr?.processName ?? null;
    if (ocr && isPrivateCapture(ocr)) return out;
    this.lastAt = now;
    this.lastMtimeMs = stat.mtimeMs;
    this.inFlight = true;
    void this.describe(processName)
      .then((event) => {
        if (event) this.buffered.push(event);
      })
      .catch((error) => console.warn('[screen-vision] describe failed:', error instanceof Error ? error.message : error))
      .finally(() => {
        this.inFlight = false;
      });
    return out;
  }

  private async describe(processName: string | null): Promise<ScreenFactEvent | null> {
    // W5: reserved before the model is contacted, like every other call; a refusal (cap, breaker) skips this frame.
    const callId = this.config.reserve ? await this.config.reserve('vision') : undefined;
    if (callId === null) return null;
    const image = fs.readFileSync(this.framePath).toString('base64');
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    // A local model is still a model call: one ledger row, filed as `vision`, under the reservation's id.
    const audit = await this.config.openAudit?.({ ...(callId ? { id: callId } : {}), momentId: null, purpose: 'vision', model: this.config.model, prompt: `${PROMPT}\n\n[image]`, route: 'ollama' }).catch(() => undefined);
    try {
      const response = await this.fetchImpl(this.ollamaUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, prompt: PROMPT, images: [image], stream: false, format: 'json', options: { temperature: 0 } }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ollama ${response.status}`);
      const parsed = (await response.json()) as { response?: string };
      await audit?.settle({ respondedAt: new Date().toISOString(), latencyMs: Date.now() - started, statusCode: response.status, success: true, responseContent: parsed.response ?? '' }).catch(() => undefined);
      const facts = parseFacts(parsed.response ?? '');
      if (facts.length === 0) return null;
      return { type: 'screen:fact', payload: { timestamp: new Date().toISOString(), processName, model: this.config.model, facts, latencyMs: Date.now() - started } };
    } catch (error) {
      await audit?.settle({ respondedAt: new Date().toISOString(), latencyMs: Date.now() - started, success: false, error: error instanceof Error ? error.message : String(error), errorClass: classifyLlmError(error) }).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The model's JSON, defensively: a `facts` array of short strings, at most three. */
export function parseFacts(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as { facts?: unknown };
    if (!Array.isArray(parsed.facts)) return [];
    return parsed.facts.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim().slice(0, 160)).slice(0, 3);
  } catch {
    return [];
  }
}
