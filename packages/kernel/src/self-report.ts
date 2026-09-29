import { localDate, localHour } from '@sundial/helpers/local-day.js';
import type { KernelState } from './types.js';

const SELF_REPORT_GAP_MS = 3 * 3_600_000;
const SELF_REPORTS_A_DAY = 3;

/**
 * Whether the owner's "flow / meh / stuck" tap is due: under three today, three
 * hours since the last, between 08:00 and 23:00 in the owner's zone.
 *
 * One answer for two readers. The Now strip offers the chips when this is true,
 * and `ownerPerceive` judges only while it is (or while the gate reads its
 * beliefs), so the belief a tap is scored against was built for that tap.
 */
export function selfReportDue(owner: Pick<KernelState['owner'], 'selfReports'> | null | undefined, ts: string, timeZone: string): boolean {
  const reports = Array.isArray(owner?.selfReports) ? owner.selfReports : [];
  const day = localDate(ts, timeZone);
  const today = reports.filter((r) => localDate(r.ts, timeZone) === day).length;
  const last = reports.at(-1);
  const hour = localHour(ts, timeZone);
  return today < SELF_REPORTS_A_DAY && (last === undefined || Date.parse(ts) - Date.parse(last.ts) >= SELF_REPORT_GAP_MS) && hour >= 8 && hour < 23;
}
