import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'

const PLUGIN = 'sundial-proactive'

/**
 * The notice, as model-facing context.
 *
 * dsh has a purpose-built context form for exactly this — `form: 'notice'`
 * renders as a collapsed transcript row with a one-line account — so an
 * admitted notice does not have to masquerade as a user message. The owner
 * sees "Gnomon noticed …", not a line they never typed.
 */
export function noticeContext({ kind, observation, evidence, weight, noticeKey, askId }, channel) {
  const lines = [
    `Gnomon noticed something (${channel}, ${kind}, weight ${weight}).`,
    observation,
    Array.isArray(evidence) && evidence.length > 0 ? `Evidence: ${evidence.join('; ')}.` : null,
    `Notice key: ${noticeKey}`,
    // A question carries its id in the context too, not only in the wake-up
    // turn: the context is what survives in the transcript, for the model.
    // (The web shell binds the companion's words by the brief's folded cause, W1.)
    kind === 'owner-question' && typeof askId === 'string' && askId !== '' ? `Ask id: ${askId}` : null,
  ].filter((line) => typeof line === 'string' && line !== '')

  return createUserMessage({
    content: [{ type: 'text', text: lines.join('\n') }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN,
      form: 'notice',
      summary: boundContextSummary(`Gnomon noticed: ${observation}`),
    },
  })
}

/** W1: a turn's brief, as the context it is (the present as its one-line account). */
export function briefMessage({ text, present }) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: boundContextSummary(present) } })
}

/**
 * A follow-up line (W2): one sentence in the chat where Gnomon raised the thing,
 * no model turn. The summary's `Follow-up: ` prefix is what `shell/frames.js`
 * draws as Gnomon's own line, live and on replay; the model reads the same words
 * as context on its next turn there.
 */
export const FOLLOWUP_PREFIX = 'Follow-up: '
export function followupLine({ observation }) {
  const text = `${FOLLOWUP_PREFIX}${observation}`
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: boundContextSummary(text) } })
}

/**
 * The wake-up, for the phasic path only.
 *
 * Separate from the context above because `inject` and `followup` are
 * different acts: the context is what the model should KNOW, this is what it
 * should DO. Sending only the context would leave an idle agent idle — dsh is
 * explicit that injection is not a wake-up.
 *
 * This is where the companion is a COLLEAGUE, not a notice-reader. A person who
 * noticed the same thing would not always "report" it — sometimes they ask,
 * sometimes they check in, sometimes they offer to handle it. The prompt hands
 * the model that repertoire and lets it pick the move that fits, the way a good
 * teammate reads the room. The gate already decided it is worth speaking; this
 * decides HOW.
 *
 * The one fixed requirement is the last line: the owner's verdict is the gate's
 * only training signal, and it cannot be given against a notice the owner
 * cannot name.
 */
export function wakeupPrompt({ noticeKey, kind, askId }) {
  // A question Gnomon itself asked is not a notice to be delivered with a
  // repertoire of moves — the move is already chosen, and the only thing that
  // matters is that the question arrives verbatim and the answer gets recorded
  // against the right ask. Offering "brief / check in / offer" here would let
  // the model paraphrase its own question into something else.
  if (kind === 'owner-question' && typeof askId === 'string' && askId !== '') {
    return createUserMessage({
      content: [
        {
          type: 'text',
          text: [
            'You asked the owner a question earlier and the moment to put it to them has arrived. Ask it now, in the words above — do not rephrase it into something softer or broader.',
            '',
            'When they answer, record it with gnomon_owner_answer using exactly this askId:',
            askId,
            '',
            'If they answer something adjacent rather than the question, record what they actually said — their answer is the fact, not the one you hoped for.',
            'If they decline or change the subject, let it go. It expires on its own; pressing it is how an assistant becomes something people mute.',
          ].join('\n'),
        },
      ],
      source: { kind: 'plugin', plugin: PLUGIN },
    })
  }

  return createUserMessage({
    content: [
      {
        type: 'text',
        text: [
          'Something you noticed cleared the bar for interrupting the owner. You are their colleague, not a dashboard — say it the way a sharp teammate would, in one or two sentences.',
          '',
          'Choose the move that fits, do not default to "reporting":',
          '• Brief — just tell them, when the fact itself is the useful thing.',
          '• Ask — when the useful thing is something only they know ("still on the deploy, or did you move on?"). A good question beats a guess.',
          '• Check in — when it is about them, not the work ("you have been heads-down a while — want a break?"). Light, not naggy.',
          '• Offer — when there is something you could DO about it, propose it with gnomon_propose and, if they say yes, carry it out and record the outcome with gnomon_record_outcome. Do not act first and tell them after.',
          '',
          'Ground it first: pull evidence with the gnomon_* tools if the observation alone would be thin.',
          // The gate scores whether an observation is worth an interruption; it
          // cannot check whether the observation is still true by the time the
          // turn opens. A deferred candidate can wait out its value half-life
          // and be delivered against a moment that has already moved on.
          'If the tools show it no longer holds, say so plainly instead of defending it — a retracted notice is a better turn than a forced one.',
          '',
          // The client draws Useful / Not now / Wrong buttons from the notice
          // key itself, so the old "(notice <key> — say not now…)" tail the
          // model had to write was a second copy of those buttons in prose.
          'Stop after the one or two sentences: no sign-off, no offer beyond a gnomon_propose.',
        ].join('\n'),
      },
    ],
    source: { kind: 'plugin', plugin: PLUGIN },
  })
}
