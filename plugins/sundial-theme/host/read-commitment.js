// One ledger row the kernel's state no longer holds, read for the owner's close.
import { getCommitment } from '@sundial/db/index.js'

/** The row under `id` while it is still open in the table; null when it is closed or absent. */
export async function readOpenRow(id) {
  const row = await getCommitment(id)
  return row && !row.closedAt ? row : null
}
