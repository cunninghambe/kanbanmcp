// The default wiring of the four collected sources (spec §4.5).
//
// This module is the only place that imports all four readers, so each source
// module stays independently compilable. `collectForUser` takes the readers as
// a dependency; tests substitute their own.

import type { CollectedSource, SourceReader } from '../types'
import { readCalendar } from './calendar'
import { readCards } from './cards'
import { readEmail } from './email'
import { readSlack } from './slack'

/** The production reader for every collected source. */
export function defaultReaders(): Record<CollectedSource, SourceReader> {
  return {
    card: readCards,
    email: readEmail,
    calendar: readCalendar,
    slack: readSlack,
  }
}
