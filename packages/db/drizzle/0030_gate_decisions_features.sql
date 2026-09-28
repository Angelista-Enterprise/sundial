-- J1.6: Jev's reading of a notice, filed beside the gate's own arithmetic.
--
-- `features` is JSON (`GateFeatures` in @sundial/kernel): speak_now, value and
-- its probability, channel and its probability, stale_soon, actionable, the
-- model that answered, and when. Written by `RecordGateFeatures` a beat after
-- `RecordGateDecision` inserted the row; NULL until then, and NULL forever on
-- the rows from before this column. Nothing reads it yet — J5.1 fits the
-- learned gate on a month of these against the owner's verdicts, and only a
-- fit that beats the fixed threshold on held-out verdicts gets to decide.
ALTER TABLE `gate_decisions` ADD `features` text;