// The apps and web hosts the record saw in the last 30 days, by name only: what the privacy settings suggest from.
// Empty when the record cannot say.
import { getSeenNames } from '@sundial/db/index.js'

export const readSeen = (now = Date.now()) => getSeenNames(new Date(now - 30 * 86_400_000).toISOString()).catch(() => ({ apps: [], hosts: [] }))
