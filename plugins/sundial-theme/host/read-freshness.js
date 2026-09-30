// When each signal stream last spoke, for the Services list's "last heard" (empty when the record cannot say).
import { getSignalFreshness } from '@sundial/db/index.js'

export const readFreshness = () => getSignalFreshness().catch(() => [])
