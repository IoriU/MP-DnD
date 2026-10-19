// The one data set every tab reads: the game's real pools, plus what the event sources say about their fights.

import { EVENTS } from '../../server/events.ts';
import { liveData, monsterUsage } from './data.ts';
import { eventFights } from './sources.ts';

export const DATA = liveData(eventFights(EVENTS.map((e) => e.id)));
export const USAGE = monsterUsage(DATA);

/** Monsters that are NPC ally stat blocks (they fight for the party, so they are not "used" by the acts). */
export const ALLY_MONSTERS = new Set(Object.values(DATA.allies).map((a) => a.monster));
