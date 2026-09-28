import { deriveId } from '@sundial/helpers/derive-id.js';
import { CONDITIONERS, conditionerById } from '@sundial/kernel/conditioners.js';
import type { ChatMessage, KernelState, NoticeCandidate, ResearchGoal, Rule, UncertaintyGap } from '@sundial/kernel/types.js';
// The open/close thresholds live in the kernel so the Calibration surface can
// explain a cell's status with the SAME arithmetic the fold decides by.
import { LEARNED_LOSS_DROP, MIN_EXCESS_TO_OPEN, gapEligibility } from '@sundial/kernel/gap-eligibility.js';

/**
 * How many questions may be open at once.
 *
 * One. Not a resource limit — a claim about what a goal IS. A system holding six
 * open questions is not curious, it is scanning; the value of choosing is in what
 * gets left out, and a list long enough to contain everything interesting makes
 * no choice at all. It also keeps the eventual report answerable in a sentence.
 */
const MAX_OPEN = 1;

/** Settled goals kept behind the open one, so a report can be written after the fact. */
const MAX_CLOSED_KEPT = 5;





/**
 * A goal that has not moved in this long has answered a different question:
 * this is not learnable now.
 *
 * Three weeks, not one. A cell gains roughly ONE observation per day, so a
 * seven-day window asked the forecaster to re-learn an hour from seven new
 * data points and retired the question before the evidence could arrive.
 */
const STALE_AFTER_MS = 21 * 86_400_000;

/** Minimum gap between opening one goal and the next, so a quiet week cannot open seven. */
const REOPEN_COOLDOWN_MS = 12 * 3_600_000;

/**
 * Proposals per goal. Two, not more: the menu is small, each proposal costs a
 * model call and a backtest, and a question neither hypothesis explains is
 * better retired stale than fished at — with n≈13 samples, a third variable
 * that "works" is where multiple comparisons start winning.
 */
const MAX_PROPOSALS = 2;

/** Forecasters whose cells the conditioner menu does not apply to: their prior is not an hourly table. */
const UNCONDITIONABLE_FORECASTERS = new Set(['prev-hour-lag', 'project-rate']);

/** The conditioners this goal has not yet spent a proposal on. */
function menuFor(goal: ResearchGoal): typeof CONDITIONERS[number][] {
  // The conditioner menu, and the trial that installs a winner, exist only for
  // the day-ending forecaster's hourly cells. A goal on another forecaster's
  // cell is still worth holding — it watches the cell and closes as learned or
  // stale on the same excess-loss criterion — but there is nothing to propose.
  if (UNCONDITIONABLE_FORECASTERS.has(goal.forecaster)) return [];
  const tried = new Set(goal.tried ?? []);
  return CONDITIONERS.filter((conditioner) => !tried.has(conditioner.id));
}

/**
 * The proposal prompt — the ONLY open-ended step in the whole loop.
 *
 * The model is shown the question, the cell's evidence, and the menu, and asked
 * for exactly one variable. It has full creative range over WHICH and zero
 * authority over WHETHER: the answer is pre-registered, the backtest tests only
 * it, and the MDL arithmetic renders the verdict. A model that answers well
 * saves a proposal; a model that answers badly costs one — it can never write
 * a belief.
 */
function proposalMessages(goal: ResearchGoal, menu: typeof CONDITIONERS[number][]): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are the research half of Gnomon, a local daemon that forecasts its owner\'s day. You pick which ONE conditioning variable most plausibly explains a forecaster cell it predicts badly. Reply with STRICT JSON only, no prose: {"variable": "<id from the menu>", "because": "<one short sentence>"}',
    },
    {
      role: 'user',
      content: [
        `The question: ${goal.question}`,
        `The cell: ${goal.label} — ${goal.openedWith.n} observations, expected error ${goal.openedWith.expectedLoss.toFixed(2)} nats.`,
        '',
        'The menu (pick exactly one id):',
        ...menu.map((conditioner) => `- ${conditioner.id}: ${conditioner.hint}`),
      ].join('\n'),
    },
  ];
}

function goalId(gap: UncertaintyGap): string {
  return `${gap.forecaster}:${gap.cell}`;
}

/** The question in the owner's terms. Never states a cause — only what is not yet known. */
function questionFor(gap: UncertaintyGap): string {
  switch (gap.kind) {
    case 'hour-fragmented':
      return `Does ${gap.label} come apart? It is the kind of hour I predict worst.`;
    case 'project-touched':
      return `Will ${gap.label} get touched on a given day? It is the project I predict worst.`;
    default:
      return `What actually happens around ${gap.label}? It is the part of the day I predict worst.`;
  }
}

/**
 * Picks the gap worth pursuing, or null.
 *
 * `gaps` arrives already sorted worst-first by `uncertaintyMap`, so this is a scan
 * for the first ELIGIBLE one rather than a re-ranking — deliberately, because the
 * ordering is that rule's business and duplicating it here would let the two drift.
 *
 * Eligibility itself lives in `@sundial/kernel/gap-eligibility.js`, with the four
 * thresholds and the two re-study windows. It is shared rather than local because
 * the Calibration surface shows the owner why each cell is or is not being
 * studied, and a surface that re-derived this arithmetic would eventually
 * describe a rule that no longer works that way.
 */
function nextGap(state: KernelState, now: number): UncertaintyGap | null {
  return state.mind.gaps.find((gap) => gapEligibility(gap, state.mind.goals, now).eligible) ?? null;
}

/**
 * The first rule that chooses what to look at.
 *
 * Everything else in `RULE_MANIFEST` is reactive: an event arrives and a rule has
 * an opinion about it. This one runs on the tick, reads where the daemon's own
 * forecasting is worst (`mind.gaps`, ranked by expected log-loss), and commits to
 * ONE of them — then watches that single cell until the evidence either moves or
 * proves it will not.
 *
 * ## Why expected loss and not size
 *
 * The autotelic-agent literature's useful finding is that goals chosen by
 * *expected learning progress* beat goals chosen by importance, because an agent
 * optimising importance re-opens the same unlearnable question forever. The cell
 * with the highest `expectedLoss` is precisely the one the forecaster expects to
 * get most wrong, so a drop in it is learning that actually happened rather than a
 * target that happened to be large.
 *
 * ## Why it does not go and research anything
 *
 * There is no fetch, no search and no LLM call here. The goal is observational:
 * Gnomon already receives the evidence that settles these cells, so pursuing a
 * question means attending to it, not going to get it. That also keeps this rule
 * pure — the report it eventually produces is a `notice:candidate` like any other,
 * and `noticeGate` decides whether the owner ever hears it. A goal that closes is
 * NOT automatically something worth saying, and this rule deliberately does not
 * get to make that call.
 *
 * ## Ordering
 *
 * Must fold AFTER `uncertaintyMap`, which writes the `gaps` this reads on the same
 * tick. Reading a stale map would open goals against last hour's worst cell.
 */
export const researchGoals: Rule = (state, event) => {
  // ── The model's answer: a hypothesis, if it names a real menu entry ──────
  if (event.type === 'llm:result') {
    const payload = event.payload as { purpose?: string; text?: string; metadata?: { goalId?: string } };
    if (payload.purpose !== 'goal') return { state, effects: [] };

    const goal = state.mind.goals.find((entry) => entry.closedAt === null && entry.id === payload.metadata?.goalId);
    if (!goal || (goal.hypothesis ?? null) !== null) return { state, effects: [] };

    // Extract the first JSON object from the reply — models decorate.
    const raw = /\{[\s\S]*?\}/.exec(payload.text ?? '')?.[0];
    const parsed = ((): { variable?: unknown; because?: unknown } | null => {
      if (!raw) return null;
      try {
        return JSON.parse(raw) as { variable?: unknown; because?: unknown };
      } catch {
        return null;
      }
    })();
    const variable = typeof parsed?.variable === 'string' ? parsed.variable : null;

    // An unusable reply is NOT retried: `proposalRequestedAt` stays set, the
    // goal goes stale on schedule, and the budget spent is one call. A retry
    // loop against a model that cannot produce two JSON keys would spend the
    // whole cap saying so.
    if (variable === null || conditionerById(variable) === null || (goal.tried ?? []).includes(variable)) return { state, effects: [] };

    const hypothesis = { variable, because: typeof parsed?.because === 'string' ? parsed.because.slice(0, 200) : '', proposedAt: event.ts };
    return {
      state: {
        ...state,
        mind: { ...state.mind, goals: state.mind.goals.map((entry) => (entry.id === goal.id ? { ...entry, hypothesis } : entry)) },
      },
      // Pre-registration: the backtest tests THIS variable and no other.
      effects: [{ type: 'RunGoalTrial', goalId: goal.id, predictionKind: 'day-ending', forecaster: goal.forecaster === 'hourly-rate' ? 'hourly-rate' : goal.forecaster, cell: goal.cell, variable }],
    };
  }

  // ── The arithmetic's verdict ─────────────────────────────────────────────
  if (event.type === 'goal:trial-result') {
    const payload = event.payload as {
      goalId?: string;
      variable?: string;
      accepted?: boolean;
      gain?: number;
      arms?: { when: { n: number; hits: number }; otherwise: { n: number; hits: number } };
      unknown?: number;
    };
    const goal = state.mind.goals.find((entry) => entry.closedAt === null && entry.id === payload.goalId);
    // Verdicts for goals that already closed (or hypotheses that were replaced)
    // are dropped — this is what makes the trial effect safe at-least-once.
    if (!goal || goal.hypothesis?.variable !== payload.variable || typeof payload.variable !== 'string') return { state, effects: [] };

    if (payload.accepted !== true || !payload.arms) {
      // Rejected: the variable is spent, the hypothesis clears, and — while
      // proposals remain — the next tick may ask for one more.
      const goals = state.mind.goals.map((entry) =>
        entry.id === goal.id ? { ...entry, hypothesis: null, proposalRequestedAt: null, tried: [...(entry.tried ?? []), payload.variable as string] } : entry,
      );
      return { state: { ...state, mind: { ...state.mind, goals } }, effects: [] };
    }

    // Accepted: the goal closes LEARNED on the trial's own numbers. The
    // conditioned cell installs via `dayShapeForecast` reacting to this same
    // event — two rules, two slices, one fact.
    const conditioner = conditionerById(payload.variable);
    const arms = payload.arms;
    const totalN = arms.when.n + arms.otherwise.n;
    const gain = typeof payload.gain === 'number' ? payload.gain : 0;
    const rate = (arm: { n: number; hits: number }): string => `${arm.hits} of ${arm.n}`;

    const closed: ResearchGoal = {
      ...goal,
      closedAt: event.ts,
      outcome: 'learned',
      closedWith: { n: totalN, expectedLoss: goal.openedWith.expectedLoss },
      // K0.4 — the same shape the threshold path writes, so a surface reads one
      // thing. `newObservations` is what makes the word "learned" believable or
      // not, and DESIGN.md's rule is that it travels with the verdict.
      finding: { variable: payload.variable, gain, arms: { when: { ...arms.when }, otherwise: { ...arms.otherwise } }, newObservations: totalN },
    };

    const candidate: NoticeCandidate = {
      shape: 'self-report',
      kind: 'goal-learned',
      key: `goal:${goal.id}`,
      // Total description-length saved, in nats: gain per sample × samples.
      // This is the quantity the MDL acceptance bar is expressed in (≥
      // ln(n)/2 + 1), so an accepted finding always clears the tonic
      // threshold on its own evidence — per-sample gain alone would gate the
      // system's most interesting output silent at exactly n≈13.
      surprise: gain * totalN,
      precision: Math.min(1, totalN / 20),
      valueHalfLifeMs: null,
      observation: `I set out to understand ${goal.label} and found the pattern: on ${conditioner?.label ?? payload.variable} it ends the day ${rate(arms.when)} times, otherwise ${rate(arms.otherwise)} — worth ${gain.toFixed(2)} nats per observation. The forecaster now bets on it.`,
      evidence: [goal.question, goal.hypothesis?.because || `hypothesis: ${payload.variable}`, `n=${totalN}${payload.unknown ? ` (+${payload.unknown} days unknowable)` : ''}`],
      concerns: [],
    };

    const kept = [closed, ...state.mind.goals.filter((entry) => entry.id !== goal.id)];
    return {
      state: { ...state, mind: { ...state.mind, goals: kept } },
      effects: [
        {
          type: 'EmitEvent',
          event: {
            id: deriveId(event.ts, event.id, 'research-goals', 'learned', goal.id),
            type: 'notice:candidate',
            ts: event.ts,
            payload: { timestamp: event.ts, ...candidate },
          },
        },
      ],
    };
  }

  if (event.type !== 'clock:tick') return { state, effects: [] };

  const now = Date.parse(event.ts);
  const byId = new Map(state.mind.gaps.map((gap) => [goalId(gap), gap] as const));
  const effects: ReturnType<Rule>['effects'] = [];

  let changed = false;
  const goals: ResearchGoal[] = state.mind.goals.map((goal) => {
    if (goal.closedAt !== null) return goal;

    const gap = byId.get(goal.id);

    // A cell missing from the map is UNKNOWN, not solved.
    //
    // `mind.gaps` is a top-five list, so a cell leaves it when four others
    // outrank it — which says nothing whatever about this one. Reading the
    // absence as zero loss (as this rule first did) turned every displacement
    // into a total, fabricated victory: the goal closed `learned` and the
    // notice announced a fall "0.81 → 0.00 nats" that never happened. Since a
    // goal on a cell that STAYS ranked could never close as learned either,
    // displacement was in practice the only way this rule ever reported
    // anything, and everything it reported was false.
    //
    // Displaced goals are retired under their own outcome and say nothing.
    if (!gap) {
      changed = true;
      return {
        ...goal,
        closedAt: event.ts,
        outcome: 'superseded' as const,
        closedWith: { n: goal.openedWith.n, expectedLoss: goal.openedWith.expectedLoss },
      };
    }

    // A goal persisted before `excessLoss` existed has no baseline in the unit
    // progress is now judged in. Left alone, the arithmetic below reads
    // `undefined - x = NaN`, every comparison goes false, and the goal becomes a
    // zombie that can only ever time out — the third can-never-succeed bug in
    // this rule's short life, and the quietest. Re-baseline it from the current
    // gap and judge from the NEXT tick; one tick of grace on a three-week
    // criterion costs nothing, a silent zombie costs the feature.
    if (typeof goal.openedWith.excessLoss !== 'number') {
      changed = true;
      return { ...goal, openedWith: { ...goal.openedWith, excessLoss: gap.excessLoss } };
    }

    const currentLoss = gap.expectedLoss;
    const currentN = gap.n;
    // Progress is measured on the reducible part only. The total also contains
    // the cell's entropy, which is a fact about the owner's day and not
    // something the forecaster can improve on.
    const dropped = goal.openedWith.excessLoss - gap.excessLoss;
    // A goal that opened on a cell with nothing reducible (possible for goals
    // persisted before `MIN_EXCESS_TO_OPEN` existed) is retired quietly: a 30%
    // drop of ~0 is noise, and announcing it as learned would be a lie.
    const nothingToLearn = goal.openedWith.excessLoss < MIN_EXCESS_TO_OPEN;
    // K0.4 — this ending is NOT `learned`, and the rename is the item.
    //
    // Nothing was tested here. No hypothesis was formed (not one of the
    // record's five goals ever had one), no variable was split, no arm was
    // compared: the cell's correctable error simply fell past a bar.
    // `MIN_EXCESS_TO_OPEN` is 0.02 and `LEARNED_LOSS_DROP` is 0.3, so a goal
    // may open on two hundredths of a nat and close on six thousandths of one,
    // which two coin flips produce. That is worth reporting and it is not
    // understanding. `learned` belongs to the trial path, which has a variable,
    // two arms and a measured gain; this one says what it did.
    const faded = !nothingToLearn && goal.openedWith.excessLoss > 0 && dropped >= goal.openedWith.excessLoss * LEARNED_LOSS_DROP;
    // Stale by time — or by exhaustion: every menu variable proposed and
    // rejected, nothing left to test. "Neither hypothesis explains this" is
    // the finding, and holding the slot for three more weeks of it would
    // just block the next question.
    const exhausted = (goal.hypothesis ?? null) === null && (goal.tried ?? []).length >= MAX_PROPOSALS;
    const stale = exhausted || nothingToLearn || now - Date.parse(goal.openedAt) >= STALE_AFTER_MS;
    if (!faded && !stale) return goal;

    changed = true;
    const closed: ResearchGoal = {
      ...goal,
      closedAt: event.ts,
      outcome: faded ? 'faded' : 'stale',
      // K0.4 — `excessLoss` too. The close is DECIDED on it and stored the
      // expected loss instead, so the arithmetic of a closed goal could not be
      // checked from the record afterwards: the two `learned` rows on this
      // machine show a baseline and a final expected loss and nothing that
      // explains why either closed.
      closedWith: { n: currentN, expectedLoss: currentLoss, excessLoss: gap.excessLoss },
      // K0.4 — the conclusion, which every closed goal owed and none had.
      //
      // `finding` existed and was only ever written by the trial path, which
      // has never fired, so all five closed goals carry `null` and the card had
      // to say so per row. The sentence the notice below already builds is the
      // honest conclusion for THIS ending, and it was being thrown away: what
      // came down, from what to what, and on how many new observations. Kept
      // as numbers rather than as prose so a surface can phrase it.
      finding: faded
        ? { variable: null, gain: dropped, arms: null, excessFrom: goal.openedWith.excessLoss, excessTo: gap.excessLoss, newObservations: currentN - goal.openedWith.n }
        : { variable: null, gain: 0, arms: null, excessFrom: goal.openedWith.excessLoss, excessTo: gap.excessLoss, newObservations: currentN - goal.openedWith.n, stalled: true },
    };

    // Only a goal whose gap actually closed is offered as a notice. A stale one is a real finding
    // about the question — "this is not learnable from what I can see" — but it is
    // a finding about Gnomon, not about the owner, and saying it would spend the
    // day's attention on an apology.
    if (faded) {
      const candidate: NoticeCandidate = {
        shape: 'self-report',
        kind: 'goal-learned',
        // Keyed by the goal, so re-learning the same cell later habituates rather
        // than being announced afresh every time the forecaster wobbles.
        key: `goal:${goal.id}`,
        // The loss actually burnt off, in nats — already the unit every other
        // producer's surprise is in, so it needs no rescaling to be comparable.
        surprise: dropped,
        // How much evidence stands behind the improvement, on the same
        // twenty-observation ramp the other producers use.
        precision: Math.min(1, currentN / 20),
        // Keeps until morning: this is something Gnomon learned, not something
        // happening now, and it must never interrupt.
        valueHalfLifeMs: null,
        observation: `I set out to understand ${goal.label} and now predict it better — ${goal.openedWith.excessLoss.toFixed(2)} to ${gap.excessLoss.toFixed(2)} nats of correctable error over ${currentN - goal.openedWith.n} more observations`,
        evidence: [goal.question, `opened ${goal.openedAt.slice(0, 10)}`, `n ${goal.openedWith.n} → ${currentN}`],
        concerns: [],
      };
      effects.push({
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'research-goals', goal.id),
          type: 'notice:candidate',
          ts: event.ts,
          payload: { timestamp: event.ts, ...candidate },
        },
      });
    }

    return closed;
  });

  // Open at most one new goal, and only once the cooldown since the last opening
  // has passed — a fresh boot with a full gap map must not open a goal per tick.
  const open = goals.filter((goal) => goal.closedAt === null);
  const lastOpenedAt = goals.reduce((latest, goal) => Math.max(latest, Date.parse(goal.openedAt)), 0);
  if (open.length < MAX_OPEN && now - lastOpenedAt >= REOPEN_COOLDOWN_MS) {
    const gap = nextGap({ ...state, mind: { ...state.mind, goals } }, now);
    if (gap) {
      changed = true;
      goals.unshift({
        id: goalId(gap),
        forecaster: gap.forecaster,
        cell: gap.cell,
        label: gap.label,
        question: questionFor(gap),
        openedAt: event.ts,
        openedWith: { n: gap.n, expectedLoss: gap.expectedLoss, excessLoss: gap.excessLoss },
        closedAt: null,
        outcome: null,
        closedWith: null,
        proposalRequestedAt: null,
        hypothesis: null,
        tried: [],
        finding: null,
      });
    }
  }

  // ── Ask for a hypothesis, once per proposal slot ─────────────────────────
  // Fires for a goal opened this very tick, for one that lost its hypothesis
  // to a rejected trial, and for one persisted before propose-and-verify
  // existed (its `proposalRequestedAt` hydrates undefined — same nullish read
  // as everywhere else). One request at a time, marked before the result can
  // possibly land, so a slow model cannot be asked twice.
  for (let index = 0; index < goals.length; index += 1) {
    const goal = goals[index];
    if (goal.closedAt !== null) continue;
    if ((goal.hypothesis ?? null) !== null || (goal.proposalRequestedAt ?? null) !== null) continue;
    if ((goal.tried ?? []).length >= MAX_PROPOSALS) continue;
    const menu = menuFor(goal);
    if (menu.length === 0) continue;

    changed = true;
    goals[index] = { ...goal, proposalRequestedAt: event.ts, tried: goal.tried ?? [], hypothesis: null };
    effects.push({
      type: 'ScheduleLLM',
      purpose: 'goal',
      momentId: null,
      delayMs: 0,
      messages: proposalMessages(goal, menu),
      metadata: { goalId: goal.id },
    });
  }

  if (!changed) return { state, effects: [] };

  // Open goals first, then the most recent settled ones. Bounding the closed tail
  // here rather than dropping them at close time is what lets a report be written
  // about a goal that settled while the owner was away.
  const kept = [...goals.filter((goal) => goal.closedAt === null), ...goals.filter((goal) => goal.closedAt !== null).slice(0, MAX_CLOSED_KEPT)];

  return { state: { ...state, mind: { ...state.mind, goals: kept } }, effects };
};
