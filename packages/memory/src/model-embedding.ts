import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

/**
 * PE (docs/design/07) — a real on-device sentence-transformer, replacing the
 * hashing-trick vector as the primary embedding. Runs fully in-process via
 * `@xenova/transformers` (ONNX runtime), so — unlike the optional
 * OpenAI-compatible `/embeddings` server path — it needs no server: the model
 * downloads once on first use to the library's cache, then every embedding is
 * a local inference. Stays within the local-first / sanitized-text-only stance
 * (docs/design/00 decision #5): no network at inference, no third-party API.
 *
 * `all-MiniLM-L6-v2` — 384-dim, ~90MB, the standard small sentence-transformer;
 * good enough that "debugging the payment flow" and "fixing the billing bug"
 * land close, which the 256-dim bag-of-words hash never could.
 */
const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Version tag persisted into `memory_embeddings.model` — bump if the model or pooling changes so old vectors aren't cosine-compared against a different space. */
export const LOCAL_MODEL_EMBEDDING_MODEL = 'local-minilm-384-v1';

function modelName(): string {
  return process.env.SUNDIAL_LOCAL_EMBEDDING_MODEL ?? DEFAULT_MODEL;
}

// Cached as a promise (not the resolved pipeline) so concurrent first-callers
// share one model load instead of each kicking off their own download.
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * PE — surface the one-time model download to whoever is watching (the
 * harness log, `$SUNDIAL_HOME/logs/sundial.log`). `@xenova` emits
 * `initiate`/`progress`/`done` per file; we log a single "downloading" heads-up
 * the first time a download starts and a "ready" line when it finishes, on
 * stderr so it never pollutes command stdout. Silent on subsequent runs (the
 * model is cached, so no `initiate`/`download` events fire).
 */
let announcedDownload = false;
function onProgress(event: { status?: string; file?: string; progress?: number }): void {
  if ((event.status === 'initiate' || event.status === 'download') && !announcedDownload) {
    announcedDownload = true;
    console.error(`[memory] downloading the local embedding model (~90MB, one-time) — retrieval uses a fast hashing fallback until it's ready…`);
  }
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = pipeline('feature-extraction', modelName(), { progress_callback: onProgress })
      .then((extractor) => {
        // Fire the "ready" line when the pipeline actually finishes loading,
        // not off a specific per-file `done`+`.onnx` event (that missed models
        // whose weight artifact has another suffix or arrives non-last, leaving
        // the "downloading" heads-up with no matching "ready"). Only when a
        // download was announced, so cached runs stay silent.
        if (announcedDownload) console.error('[memory] embedding model ready.');
        return extractor;
      })
      .catch((error) => {
        // Reset so a transient failure (offline first-run, disk) can be retried
        // on the next call rather than being cached as a permanent rejection.
        pipelinePromise = null;
        throw error;
      });
  }
  return pipelinePromise;
}

/**
 * Mean-pooled, L2-normalized sentence embedding as a plain `number[]` (cosine
 * = dot product, matching `cosineSimilarity`). Throws if the model can't load
 * or infer — `computeEmbedding` catches that and falls back to the hashing
 * trick, so a first-run with no network degrades retrieval rather than breaking
 * ingestion.
 */
/**
 * How long one embedding waits for the model to load. The executor is serial,
 * so a first-run download on a slow or blocked network would hold every event
 * behind it; past this, the call throws (the hashing fallback answers) and the
 * load goes on in the background for the next call.
 */
export const MODEL_LOAD_WAIT_MS = 10_000;

export async function computeModelEmbedding(text: string): Promise<number[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the local embedding model is still loading')), MODEL_LOAD_WAIT_MS);
  });
  const extractor = await Promise.race([getExtractor(), late]).finally(() => clearTimeout(timer));
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}
