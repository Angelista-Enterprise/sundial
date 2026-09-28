-- K0.2: the two bars a gate decision was actually weighed against.
--
-- `noticeGate` scales BOTH thresholds by `2 ** noticeBias` before it weighs
-- anything, so the policy's shipped 0.55 and 1.6 are not the bars any given row
-- met — with the dial at −1 they are 0.275 and 0.8. Nothing recorded that, so a
-- decision could never be placed against its own line: the Unsaid card drew
-- today's bar across the whole record, and 40 of its 171 rows sat on the wrong
-- side of it, countable and unresolvable.
--
-- Nullable, and it stays nullable forever. There is no honest backfill — the
-- dial's value at the time of an old row is not stored anywhere — so NULL means
-- "this row cannot be placed" and every reader must say so rather than
-- substituting today's.
ALTER TABLE `gate_decisions` ADD `tonic_bar` real;--> statement-breakpoint
ALTER TABLE `gate_decisions` ADD `phasic_bar` real;
