// Bot callouts: the bots that fill empty seats talk like teammates. Every bot name has a voice, and at key moments (the
// fight starts, a hero goes down, a kill steal...) one of them says a short handwritten line, shown in the log like a
// chat line. Odds, a one-line-per-bot-per-round cooldown and a cap per round keep the log from flooding.
// {target} is a monster (the "Goblin"), {ally} a hero. Only real bots talk, never people who switched on auto-play:
// the game checks that (server/game.ts `callout`); this file is plain data and small pure helpers.

export type CallEvent = 'start' | 'elite' | 'boss' | 'low' | 'down' | 'revive' | 'healed' | 'kill' | 'steal' | 'crit' | 'hunted' | 'level' | 'won';

export type Voice = 'gruff' | 'cheery' | 'pious' | 'veteran' | 'cocky' | 'tinker' | 'noble' | 'earthy' | 'plain';

/** What fills the {placeholders} of a line. */
export interface CallVars {
  target?: string;
  ally?: string;
}

/** The names the server gives bots, in the order it hands them out ("Bot N" once they run out). */
export const BOT_NAMES = ['Brakka', 'Pip', 'Sister Wren', 'Old Tam', 'Vexa', 'Grimble', 'Lady Ash', 'Moss'];

/** Gruff Brakka, cheerful Pip, gentle Wren, grumpy Tam, cocky Vexa, nervous Grimble, cool Ash, calm Moss. */
export const VOICE: Record<string, Voice> = {
  Brakka: 'gruff', Pip: 'cheery', 'Sister Wren': 'pious', 'Old Tam': 'veteran', Vexa: 'cocky', Grimble: 'tinker', 'Lady Ash': 'noble', Moss: 'earthy',
};

/** A bot's voice: its own if its name has one, a plain one otherwise ("Bot 4"). */
export const voiceOf = (name: string): Voice => (Object.hasOwn(VOICE, name) ? VOICE[name] : 'plain');

/** Which placeholders each event can fill: the game passes exactly these. */
export const PLACEHOLDERS: Record<CallEvent, string[]> = {
  start: ['target'], elite: ['target'], boss: ['target'], low: [], down: ['ally'], revive: ['ally'], healed: ['ally'],
  kill: ['target'], steal: ['target', 'ally'], crit: ['target'], hunted: [], level: [], won: [],
};

// A voice with no lines for an event borrows the plain voice's, which has every event.
export const LINES: Record<Voice, Partial<Record<CallEvent, string[]>>> = {
  gruff: {
    start: ['Hm. {target}. Fine.', 'Fight now. Talk later.', 'Let us get this over with.', 'I hit things. You hit things. Good plan.'],
    elite: ['Big {target}. Good. I was bored.', 'That {target} looks tough. Tough is fun.', 'Strong one. Stay sharp.'],
    boss: ['{target}. Big. Loud. Dead soon.', 'So that is the {target}. Finish it.', 'Eyes up. This one bites back.'],
    low: ['Bleeding. Keep fighting.', 'Just a scratch. A big scratch.', 'I am fine. Mostly fine.', 'Hm. That one hurt.'],
    down: ['{ally} is down! Cover them!', '{ally}! Get up, you lump!', 'Nobody leaves {ally} behind. Move.'],
    revive: ['Up, {ally}. No napping.', 'On your feet, {ally}. There is work.', 'There. Do not make me do that again.'],
    healed: ['Hm. Thanks, {ally}.', 'Good. Back to work.', 'Better. Thanks.'],
    kill: ['Dead.', 'That one is done.', 'Next.', 'Stay down, {target}.'],
    steal: ['Mine now, {ally}.', 'Sorry, {ally}. Not sorry.', '{ally} did the work. I took the credit. Fair deal.', 'The {target} was in my way.'],
    crit: ['Good hit.', 'Hah! Right in the soft bit.', 'The {target} felt that.'],
    hunted: ['They want me? Good. Come.', 'All of them on me? Fair.', 'Here I am, ugly ones.'],
    level: ['Stronger now. Hm.', 'Good. More muscle.', 'I grew. Good.'],
    won: ['Done. Drink later.', 'That is that.', 'Good fight. Hm.'],
  },
  cheery: {
    start: ["Ooh, a {target}! Let's go let's go!", 'Adventure time!', "Everyone ready? I'm ready! I'm SO ready!", 'This is going to be great!'],
    elite: ['Wow, that {target} is HUGE! Cool!', 'Ooh, a fancy {target}! Careful, everyone!', "That one looks tough, but we're tougher!"],
    boss: ["The {target}!! I've heard stories!", 'Okay okay okay, big one, we can do this!', 'Everybody breathe! Then hit the {target}!'],
    low: ['Ow ow ow! Still good though!', "I'm okay! Mostly! A little squished!", "Little help? Only if it's no trouble!", 'Eep! That one was rude!'],
    down: ['{ally} fell over! Somebody help!', "Hang on, {ally}! We've got you!", 'Oh no oh no, {ally}!'],
    revive: ['Up you get, {ally}! Good as new!', 'Welcome back, {ally}!', 'Ta-da! {ally} lives!'],
    healed: ["Thank you, {ally}! You're the best!", 'Yay, I feel tingly! Thanks!', 'Good as new! Thanks, {ally}!'],
    kill: ['Got it!', 'Boop! Down goes the {target}!', 'Did you see that? I did that!', 'Yay me!'],
    steal: ['Oops! Sorry, {ally}! I got excited!', 'Finders keepers, {ally}! Sorry!', 'Whoops, I took your {target}, {ally}!'],
    crit: ['Did you see that?! Did you?!', "Critical! That's the good kind!", 'Wow, I actually hit it right!'],
    hunted: ["They're all looking at me! Hi!", 'Why me?! Okay, running!', 'Eep, they like me! Too much!'],
    level: ['I leveled up! I feel taller!', 'New trick unlocked!', 'Level up! Look at me go!'],
    won: ['We did it!!', 'High fives, everyone!', 'That was fun! Can we do another?'],
  },
  pious: {
    start: ['May the light keep us all.', 'Steady hearts, everyone.', 'Peace be with us. Perhaps the {target} too, but unlikely.'],
    elite: ['A strong {target}. Kind to each other, hard on it.', 'Stay together. The {target} is stronger than it looks.', 'Pray with me, quickly: that {target} looks fierce.'],
    boss: ['The {target}. Light, grant us steady hands.', 'Be brave, friends. The light is with us.', 'Let us do this gently. Well. Firmly.'],
    low: ['I am growing faint, friends...', 'A little mercy, please. I am hurt.', 'I will pray later. First, a bandage.', 'The light flickers in me, but it holds.'],
    down: ['{ally} has fallen! Hold on, dear!', 'Oh no. {ally}, stay with us!', 'Light, keep {ally} safe!'],
    revive: ['Rise, {ally}. It is not your time.', 'The light mends. Welcome back, {ally}.', 'There, there, {ally}. Up you get.'],
    healed: ['Bless you, {ally}.', 'Thank you, {ally}. Kind hands.', 'The light thanks you, {ally}. So do I.'],
    kill: ['Rest now, {target}.', 'I am sorry. But you were rather rude.', 'Forgive me, {target}.'],
    steal: ['Forgive me, {ally}. I did not mean to take that {target}.', 'Oh dear. Sorry, {ally}. I will do penance.', 'Greed is a sin, {ally}. That was greedy of me.'],
    crit: ['The light guided that one.', 'A blessed blow!', 'Well. That was unexpectedly divine.'],
    hunted: ['They are looking at me. I forgive them.', 'Oh, they want me? Very well.', 'Light, keep their aim poor.'],
    level: ['I feel the light grow in me.', 'A new blessing. Thank you.', 'Stronger by grace.'],
    won: ['Thank the light. Is everyone well?', 'Peace at last. For a moment.', 'Let us tend our wounds, friends.'],
  },
  veteran: {
    start: ["Not another {target}. I've seen a hundred.", "Grumble grumble. Fine, let's do it.", 'In my day, monsters knocked first.', 'Keep your heads down, whelps.'],
    elite: ['That {target}? Seen worse. Barely.', 'Hmph. A tough {target}. Pay attention, whelps.', "Don't get cocky. That one eats cocky for lunch."],
    boss: ['The {target}. My knees are not ready for this.', 'Last time I met one of those, I lost a boot. Careful.', 'Hmph. A {target}. Everyone listen to Tam.'],
    low: ['My back! My knee! My everything!', "I've had worse. Last Tuesday, probably.", 'Ow. My knees were fine before that.', 'Somebody patch the old man up!'],
    down: ['{ally} is down! Told you to duck!', 'Up, {ally}! No lazing about!', 'Hmph. Somebody get {ally} up!'],
    revive: ["Up, {ally}. Don't make a habit of it.", 'There. Lazy youngster, {ally}.', "On your feet, {ally}. I'm not carrying you."],
    healed: ['Hmph. Thanks, {ally}.', 'Not bad. Not bad at all.', 'Fine. I owe you a drink, {ally}.'],
    kill: ['Hmph. One less.', 'And stay down.', 'Easy. Well. Easier than last time.', 'Another {target} for the pile.'],
    steal: ['Age before talent, {ally}.', 'Sorry, {ally}. Old men are sneaky.', 'Forty years of practice, {ally}. Learn from it.'],
    crit: ['Ha! Still got it.', "That, young ones, is how it's done.", 'Still got the touch.'],
    hunted: ['Me? Of course me. Always me.', "Pick on the old man, why don't you.", 'Hmph. Come and get me, then.'],
    level: ['Even an old dog learns tricks.', 'Hmph. A new trick at my age.', 'Stronger. And still grumpy.'],
    won: ['Hmph. Not bad. Somebody fetch my pipe.', "That's that. My knees hurt.", "Well done, whelps. Don't tell anyone I said so."],
  },
  cocky: {
    start: ['Oh good, a {target}. I was getting bored.', 'Try to keep up, everyone.', 'This should be quick. And a little embarrassing. For them.', 'Let me know when they get scary.'],
    elite: ["A {target}. How cute. It thinks it's special.", "Fancy {target}. I'll take the shiny bit.", 'Oh, a tough one. Finally.'],
    boss: ["The {target}. I've beaten bigger. In my head.", "Big, scary, dramatic. Love it. Let's ruin it.", "Everyone watch. I'll make this look easy."],
    low: ['Okay. Rude. That one hurt.', 'I meant to do that. Mostly.', 'Healing? Whenever. Not urgent. Very urgent.', "Fine, fine. I'm mildly inconvenienced."],
    down: ["Nice nap, {ally}. Get up, we're busy.",'Great, {ally} fainted. Dramatic.', 'Hey {ally}! Dying is cheating.'],
    revive: ['Up, {ally}. You owe me a drink.', "There. You're welcome, {ally}.", 'Rise and shine, {ally}. Try staying up this time.'],
    healed: ["Thanks, {ally}. I'd have been fine. Probably.", 'Ooh, shiny. Thanks.', "Okay, you're useful, {ally}."],
    kill: ["Another one down. You're welcome.", 'Too easy.', "Bye, {target}. Don't write.", "And that's how you do it."],
    steal: ['Thanks for softening it up, {ally}!', 'Finders keepers, {ally}.', 'Oh, was that yours, {ally}? Cute.', 'Kill steal? I call it efficiency.'],
    crit: ['Oh, that was gorgeous.', 'Ha! Say you saw that.', 'Critical hit. Naturally.'],
    hunted: ['Oh, they like me. Of course they do.', "Everyone's looking at me? Fair enough.", 'Aw, I have fans.'],
    level: ['Level up. Try to contain your envy.', 'Look at me, getting even better.', "New tricks. You're welcome."],
    won: ["Easy. Who's buying?", 'Another win for the best in the party. Me.', 'Was that all they had?'],
  },
  tinker: {
    start: ['Oh dear, oh dear. Everything is calibrated! Probably.', 'Is the {target} always that, um, big?', "Don't worry! I have a plan. Several. Mostly bad.", "Please don't let it touch my gadgets."],
    elite: ['That {target} is not in the manual!', 'Oh no, an enhanced {target}! My notes did not cover this!', 'Um. That one looks, uh, upgraded.'],
    boss: ["Th-that's a {target}. A very big {target}. Oh dear.", 'My calculations say run. My legs agree. Let us fight though!', 'Nobody panic. I am panicking enough for all of us.'],
    low: ['Oh dear oh dear, that is a lot of red!', "I'm leaking! I'm not supposed to leak!", 'Um, help? A little? Now?', 'My calculations say I should not be hurt this much!'],
    down: ['{ally} is down! Oh no oh no oh no!', '{ally}! Somebody, um, do something!', 'I have a potion! Somewhere! {ally}!'],
    revive: ['Up you get, {ally}! Phew!', 'Got you, {ally}! My hands are still shaking.', 'It worked! It actually worked! Welcome back, {ally}!'],
    healed: ['Oh, thank you, {ally}! Phew!', 'Much better! Thank you!', "I'm all in one piece again. Thanks, {ally}!"],
    kill: ['I did it? I did it! I think.', "Oh! It's dead. It's really dead.", 'Ha! Experiment successful!', 'Down it goes! Please stay down.'],
    steal: ['Oh! Oops! Sorry, {ally}! I did not mean to!', "{ally}, I'm so sorry, my aim is better than I thought!", 'Was that your {target}, {ally}? Sorry sorry sorry!'],
    crit: ['Oh! That actually worked!', 'Calculated! Totally calculated!', 'Ha! Lucky! I mean, skilled! I mean both!'],
    hunted: ['Why me?! Why is it always me?!', "Oh no, they noticed me. I'm not ready!", "Eep! They're all looking at me!"],
    level: ['I feel upgraded! Is that a good word?', 'New skills! Time to tinker!', "Level up! Don't touch the new gadgets!"],
    won: ["We're alive! Everything's fine! Mostly!", "I'm shaking. Everyone okay?", 'Phew! Excellent outcome. Excellent!'],
  },
  noble: {
    start: ['How tiresome. A {target}. Shall we?', 'Do try to keep your boots out of the blood.', 'Another brawl. How very common.', 'Let us dispatch this with some dignity.'],
    elite: ['A {target}. Marginally more interesting.', 'This one has pretensions. We shall correct that.', 'The {target} wishes to be taken seriously. Let us oblige.'],
    boss: ['The {target}. One does rise to the occasion.', 'Let us be efficient and elegant about it.', 'A dramatic one. I do appreciate effort.'],
    low: ['I am slightly inconvenienced. Do be quick.', 'My dress is ruined. And my arm. Mostly the dress.', 'Hardly fatal, but terribly rude.', 'Bleeding on a dungeon floor. How undignified.'],
    down: ['{ally} has fainted. Someone, do assist.', 'Dear me. {ally}, that was careless.', 'Up, {ally}. It is terribly embarrassing down there.'],
    revive: ['Rise, {ally}. Compose yourself.', 'There. Quite alive. Do try to stay that way.', 'You are welcome, {ally}. I do not forget a favor.'],
    healed: ['Most kind, {ally}.', 'I am obliged, {ally}.', 'Quite refreshing. My thanks.'],
    kill: ['Dispatched.', 'And that is that.', 'A tidy end for the {target}.', 'Dispatched. Quite neatly.'],
    steal: ['Terribly sorry, {ally}. The {target} was in my way.', 'The credit is mine, I fear, {ally}. Chin up.', 'Forgive me, {ally}. Manners fail me at times like this.', 'Do not sulk, {ally}. It is unbecoming.'],
    crit: ['Exquisite, if I do say so.', 'A flawless strike.', 'And with style.'],
    hunted: ['They are all looking at me. Naturally.', 'Do pick someone else. No? How rude.', 'Such attention. I do attract it.'],
    level: ['Improving, naturally.', 'A new refinement. How lovely.', 'Even better. Do keep up.'],
    won: ['A tolerable outing.', 'Splendid. Do wipe your weapons.', 'That was almost enjoyable.'],
  },
  earthy: {
    start: ['Easy now. Breathe. Then swing.', 'The {target} is just scared too.', 'Steady, friends. Like a river.', 'The wind is with us today.'],
    elite: ['A strong {target}. Like an old oak. Chop it down slowly.', 'That {target} is a storm. We weather it together.', 'Big {target}. We are bigger together.'],
    boss: ['The {target} is a mountain. Mountains erode.', 'Stay calm. Even mountains fall eventually.', 'Roots deep, friends. We hold.'],
    low: ["I'm bending, not breaking.", 'Hm. The wind knocked me down a bit.', 'A little water would be nice. Or a spell.', "I'm worn like a stone. Still here."],
    down: ["{ally}'s down. Someone breathe life back in.", 'Hold on, {ally}. Roots, not wings.', "{ally} fell. Let's lift them."],
    revive: ['Up, {ally}. Slow breaths.', 'There you go, {ally}. Like spring.', 'Back to the sun, {ally}.'],
    healed: ['Thanks, {ally}. Like rain after a dry spell.', 'Much better. Thanks.', 'That was kind, {ally}.'],
    kill: ['Back to the earth, {target}.', 'Peace. Not a lot of it. But some.', "It's done. Sorry, friend.", 'The forest grows quiet.'],
    steal: ['The river takes what it takes, {ally}.', 'Sorry, {ally}. It was nearer to me.', "Share the sun, {ally}. Next one's yours."],
    crit: ['The earth guided that.', 'Right through the bark.', 'A good seed of a hit.'],
    hunted: ['They found me. Fine. I am a tree.', "Easy, friends. I'll hold their attention.", "The storm's coming my way. All right."],
    level: ['I feel the roots grow.', 'Another ring on the tree.', 'Stronger, slowly. Like moss.'],
    won: ['Peace again. Breathe in.', 'The forest is quiet. Good work.', "We've done well. Rest now."],
  },
  plain: {
    start: ['Here we go.', 'Ready when you are.', 'Stay together.'],
    elite: ['That {target} looks tough. Careful.', 'Strong one. Focus it down.'],
    boss: ['The {target}! Everyone focus.', "Big one. Let's do this."],
    low: ["I'm hurt! Could use a heal.", 'Low on health here!'],
    down: ['{ally} is down!', 'Help {ally}!'],
    revive: ['Up you get, {ally}.', 'Got you, {ally}.'],
    healed: ['Thanks, {ally}!', 'Much better. Thanks!'],
    kill: ['One down.', "That's the {target} done."],
    steal: ['Sorry, {ally}. Got the {target}.', "That one's mine, {ally}."],
    crit: ['Nice hit!', 'Right on target.'],
    hunted: ["They're coming for me!", "I've got their attention."],
    level: ['Level up!', 'Stronger now.'],
    won: ['We did it.', 'Good fight, everyone.'],
  },
};

/** How often a callout is said when it could be: the big moments nearly always, the small ones now and then. */
export const CALLOUT_ODDS: Record<CallEvent, number> = {
  start: 0.3, elite: 0.8, boss: 0.95, low: 0.85, down: 0.6, revive: 0.9, healed: 0.3, kill: 0.2, steal: 0.9, crit: 0.35, hunted: 0.5, level: 0.6, won: 0.5,
};

/** A hero this far down is "low" (a fraction of max HP): the bot calls it out once per fight. */
export const LOW_HP = 0.35;

/** At most this many lines per round (or scene), whoever says them... */
export const MAX_PER_BEAT = 2;

/** ...except these, which may be one more: the party should hear them. */
export const URGENT: ReadonlySet<CallEvent> = new Set<CallEvent>(['low', 'down', 'revive', 'steal']);

/** The line a bot says for an event (without its "Name: " in front), or null if there's nothing for it. `roll` is [0, 1). */
export function calloutLine(name: string, ev: CallEvent, vars: CallVars, roll: number): string | null {
  const lines = LINES[voiceOf(name)][ev] ?? LINES.plain[ev];
  if (!lines?.length) return null;
  const pick = lines[Math.floor(roll * lines.length) % lines.length];
  return pick.replace(/\{(\w+)\}/g, (_, key: string) => vars[key as keyof CallVars] ?? (key === 'ally' ? 'friend' : 'it'));
}

/** Who has spoken lately, for the cooldown and the cap. */
export interface Chatter {
  beat: string; // the round (or scene: 'start', 'after') the two below count
  said: number; // lines said this beat
  spoke: Set<string>; // speakers who have already said one this beat
  low: Set<string>; // speakers who already called out low HP this fight
}

export const newChatter = (): Chatter => ({ beat: '', said: 0, spoke: new Set(), low: new Set() });

/**
 * May this speaker call this out now? Yes if they haven't spoken this beat, the beat isn't full, the odds come up
 * (`roll` is [0, 1)), and (for 'low') it's their first time this fight. A yes counts as a line spoken.
 */
export function tryCallout(c: Chatter, who: string, ev: CallEvent, beat: string, roll: number): boolean {
  if (c.beat !== beat) {
    c.beat = beat;
    c.said = 0;
    c.spoke.clear();
  }
  if (ev === 'low' && c.low.has(who)) return false;
  if (c.spoke.has(who) || c.said >= MAX_PER_BEAT + (URGENT.has(ev) ? 1 : 0)) return false;
  if (roll >= CALLOUT_ODDS[ev]) return false;
  c.spoke.add(who);
  c.said++;
  if (ev === 'low') c.low.add(who);
  return true;
}
