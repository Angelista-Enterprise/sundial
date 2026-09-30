/**
 * A verdict the phone can send without holding the ingest token.
 *
 * An ntfy action is a URL and a body that live inside the notification, and
 * the notification travels through a public ntfy.sh topic. Putting the bearer
 * token in there would hand the whole ingest listener to whoever reads the
 * topic. So a verdict carries its own signature instead: an HMAC over exactly
 * the three fields it sets, keyed by the token the listener already has. A
 * leaked action can replay THAT verdict on THAT artifact and nothing else —
 * the same thing pressing the button twice does.
 */
import crypto from 'node:crypto';
import { VERDICTS } from './vocab.js';

export { VERDICTS };
export type Verdict = (typeof VERDICTS)[number];

export function signVerdict(token: string, artifactKind: string, artifactId: string, verdict: string): string {
  return crypto.createHmac('sha256', token).update(`${artifactKind}\n${artifactId}\n${verdict}`).digest('hex').slice(0, 32);
}

const LABELS: Record<Verdict, string> = { useful: 'Useful', 'not-now': 'Not now', wrong: 'Wrong' };

/**
 * The three taps, as ntfy `http` actions posting to the listener's `/verdict`.
 * `base` is where the PHONE reaches that listener (the Tailscale Serve URL of
 * :8767), never loopback. Empty when there is no base: a push with no way back
 * is still a push.
 */
export function verdictActions(base: string, token: string, artifactKind: string, artifactId: string, verdicts: readonly Verdict[] = VERDICTS): Array<Record<string, unknown>> {
  if (base === '') return [];
  // lane H (H4): `verdicts` picks and orders the taps; a wait the owner cannot rate offers only "Not now".
  return verdicts.map((verdict) => ({
    action: 'http',
    label: LABELS[verdict],
    url: `${base.replace(/\/$/, '')}/verdict`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ artifactKind, artifactId, verdict, sig: signVerdict(token, artifactKind, artifactId, verdict) }),
    clear: true,
  }));
}
