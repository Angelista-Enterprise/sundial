// W5 step 8 (scorecard row 9): the chat route predictor (`route-ask`, one noul per data source,
// judged on every owner message) against the tools the turn then called — `ask:route-actual`
// rows before W1, the `tools` on `chat:said` since. Pure over the rows; the caller reads them.
//
// Brier per (turn, source) against climatology: each source's own share of the joined turns.
// Skill = 1 − Brier / Brier(climatology): ≤ 0 is no better than always saying the base rate.
// Safe routing: the tools the turn called were all among the sources predicted at ≥ 0.5, the
// share a router could have used without missing one.

export interface RoutePrediction {
  turnId: string;
  predicted: Record<string, number | null>;
}
export interface RouteActual {
  turnId: string;
  tools: string[];
}

export function scoreRoutePredictor(predictions: RoutePrediction[], actuals: RouteActual[]): { n: number; pairs: number; brier: number | null; climatology: number | null; skill: number | null; safe: number | null } {
  const byTurn = new Map(actuals.map((a) => [a.turnId, new Set(a.tools)]));
  const joined = predictions.filter((p) => byTurn.has(p.turnId));
  const sources = [...new Set(joined.flatMap((p) => Object.keys(p.predicted)))];
  const share = new Map(sources.map((s) => [s, joined.filter((p) => byTurn.get(p.turnId)!.has(s)).length / Math.max(1, joined.length)]));
  let pairs = 0;
  let sum = 0;
  let base = 0;
  let safe = 0;
  for (const p of joined) {
    const used = byTurn.get(p.turnId)!;
    for (const s of sources) {
      const q = p.predicted[s];
      if (typeof q !== 'number') continue;
      const y = used.has(s) ? 1 : 0;
      pairs += 1;
      sum += (q - y) ** 2;
      base += (share.get(s)! - y) ** 2;
    }
    if ([...used].filter((t) => sources.includes(t)).every((t) => (p.predicted[t] ?? 0) >= 0.5)) safe += 1;
  }
  const brier = pairs > 0 ? sum / pairs : null;
  const climatology = pairs > 0 ? base / pairs : null;
  return { n: joined.length, pairs, brier, climatology, skill: brier !== null && climatology ? 1 - brier / climatology : null, safe: joined.length > 0 ? safe / joined.length : null };
}
