// Mana PERCEIVE reader — turns the game's reply to PERCEIVE into a typed reading
// for the Mana Experience (components/experiences/ManaExperience.tsx).
//
// Pure (no React, no storage): GameWindow arms a reading when the player sends
// PERCEIVE (or a Lich script's PERCEIVE echoes as "[script]>perceive"), feeds it
// the main-stream lines that follow, and drops it when the room changes. Nothing
// is remembered between rooms: the window shows the latest PERCEIVE only.
//
// The wording is the game's real text (Empath and Cleric captures, 2026-11),
// with or without a "(17/21)" a player's substitutes may add:
//   You reach out with your senses and see brilliant streams of golden Holy mana radiating through the area.
//   Letting your senses extend further, you feel there is shining mana to the southwest, and radiant mana to the north.
//   ... flaring mana below you, and fulgent mana above you.
// plus the lower-skill forms ("your developing senses and see muted streams",
// 3/5/9 steps, scaled to the 21 words) and "Faint streams of fiery mana ..."
// where only the colour names the realm.
//
// Lunar (Moon Mage) mana is not per room: PERCEIVE MANA names a strength per
// spellbook, which follows the moons (Moon Mage capture, 2026-11-18):
//   You reach out with your senses and see glowing streams of cold, white Lunar mana available for the Perception book.
// Those go into `books`, and a reading with books is kept when you move.

import { MANA_WORDS, guildRealm, type Realm } from './components/panels/damaps/daMapsData'

export interface ManaStrength {
  word: string
  /** 0-20 on the 21-word scale */
  rank: number
}
export interface ManaNeighbour extends ManaStrength {
  /** north, northeast, ..., above, below (as the game said it) */
  dir: string
}
export interface ManaBook extends ManaStrength {
  /** the spellbook as the game names it, e.g. "Moonlight Manipulation" */
  book: string
}
export interface ManaView {
  realm: Realm | null
  here?: ManaStrength
  near: ManaNeighbour[]
  /** Lunar: one strength per spellbook, in the order the game listed them */
  books: ManaBook[]
  /** when the PERCEIVE reply arrived */
  at: number
}

/** How long after PERCEIVE its reply is read (it arrives at once; the RT is 3s). */
export const MANA_WINDOW_MS = 10_000

export function isPerceiveCommand(cmd: string): boolean {
  return /^perc(?:eive|eiv|ei|e)?(?:\s+mana)?$/i.test(cmd.trim())
}

/** a Lich script's PERCEIVE shows only as its echo: "[custom/damaps-mana]>perceive" */
export function isScriptPerceiveEcho(line: string): boolean {
  return line.charCodeAt(0) === 91 /* [ */ && /^\[[^\]]+\]>\s*perc(?:eive|eiv|ei|e)?(?:\s+mana)?\s*$/i.test(line)
}

const TIER_WORDS: Record<string, string[]> = {
  weak:       ['dim', 'glowing', 'bright'],
  developing: ['faint', 'muted', 'glowing', 'luminous', 'bright'],
  improving:  ['faint', 'hazy', 'flickering', 'shimmering', 'glowing', 'lambent', 'shining', 'fulgent', 'glaring'],
}
const STEP = String.raw`(?: \(\d+\/\d+\))?`
const HERE_RE    = new RegExp(String.raw`your (?:(weak|developing|improving) )?senses and (?:see|hear) (\w+)${STEP} (?:streams|mana)`, 'i')
const COLOUR_RE  = new RegExp(String.raw`^(\w+)${STEP} streams of (bluish-white|cold, white|fiery|golden|unholy black) mana`, 'i')
const NEAR_RE    = new RegExp(String.raw`\b(\w+)${STEP} mana (?:to the (\w+)|(above|below) you)[,.]`, 'gi')
const BOOK_RE    = new RegExp(String.raw`your (?:(weak|developing|improving) )?senses and (?:see|hear) (\w+)${STEP} streams of [^.]*?mana available for the (.+?) book`, 'i')
const REALM_WORD = /streams of [^.]*?\b(Life|Holy|Elemental|Arcane|Lunar) mana/
const COLOURS: Record<string, Realm> = {
  'bluish-white': 'Life', 'golden': 'Holy', 'fiery': 'Elemental', 'cold, white': 'Lunar', 'unholy black': 'Arcane',
}

/** strength on the 21-word scale, from a word on its own tier's scale (null if unknown) */
export function manaStrength(word: string, tier?: string): ManaStrength | null {
  const w = word.toLowerCase()
  const scale = tier ? TIER_WORDS[tier.toLowerCase()] : undefined
  if (!scale) {
    const i = MANA_WORDS.indexOf(w)
    return i < 0 ? null : { word: w, rank: i }
  }
  const i = scale.indexOf(w)
  return i < 0 ? null : { word: w, rank: Math.max(0, Math.round(((i + 1) / scale.length) * MANA_WORDS.length) - 1) }
}

/**
 * Read one line of a PERCEIVE reply into `view`. Returns a NEW view when the
 * line added something, else null (so the caller only re-renders on a change).
 * `fallbackRealm` is the character's guild realm, for lines that don't name it.
 */
export function readManaLine(view: ManaView, line: string, fallbackRealm: Realm | null): ManaView | null {
  if (!/mana/i.test(line)) return null
  const b = BOOK_RE.exec(line)
  if (b) {
    const st = manaStrength(b[2], b[1])
    if (!st) return null
    const book = b[3].trim()
    const books = [...view.books]
    const i = books.findIndex(x => x.book === book)
    if (i >= 0) books[i] = { book, ...st }
    else books.push({ book, ...st })
    return { ...view, realm: 'Lunar', books, at: Date.now() }
  }
  const named = REALM_WORD.exec(line)?.[1] as Realm | undefined
  const colour = COLOUR_RE.exec(line)
  const realm = named ?? (colour ? COLOURS[colour[2].toLowerCase()] : undefined) ?? view.realm ?? fallbackRealm
  let here = view.here
  const h = HERE_RE.exec(line)
  if (h) here = manaStrength(h[2], h[1]) ?? here
  else if (colour) here = manaStrength(colour[1]) ?? here
  const near = [...view.near]
  for (const m of line.matchAll(NEAR_RE)) {
    const s = manaStrength(m[1])
    if (!s) continue
    const dir = (m[2] ?? m[3]).toLowerCase()
    const i = near.findIndex(n => n.dir === dir)
    if (i >= 0) near[i] = { dir, ...s }
    else near.push({ dir, ...s })
  }
  if (here === view.here && near.length === view.near.length && realm === view.realm &&
      near.every((n, i) => n === view.near[i])) return null
  return { realm, here, near, books: view.books, at: Date.now() }
}

/** a fresh, empty reading for GameWindow to arm */
export function emptyManaView(): ManaView {
  return { realm: null, near: [], books: [], at: Date.now() }
}

export function guildManaRealm(guild: string | null | undefined): Realm | null {
  return guildRealm(guild)
}
