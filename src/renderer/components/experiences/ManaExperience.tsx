// Mana (Experience) — the mana PERCEIVE just reported, as a compass: your room
// in the centre, each neighbouring room PERCEIVE named around it in its own
// direction, above and below beside the compass.
//
// A PURE VIEW over `mana` (ExperienceProps), which GameWindow fills from the
// PERCEIVE reply (manaPerceive.ts) and drops the moment you change rooms. It
// remembers nothing: a room you walk back into is blank until you PERCEIVE
// again (Kaesken's call).
//
// Strength is shown three ways so it never rests on colour alone (§34.7): the
// word, the ring that fills with it (rank of 21), and the bubble's tint. The
// hue is the realm's (fixed lore colours, --mana-* in themes.ts). A direction
// PERCEIVE didn't mention keeps a faint dot, so the layout never shifts
// (UX #2). The em chain is anchored to --game-font-size (pitfall #58a).
import { memo, type CSSProperties } from 'react'
import type { ExperienceProps } from '../../experiences'
import { optionShown, experienceById } from '../../experiences'
import { MANA_WORDS, type Realm } from '../panels/damaps/daMapsData'
import { guildManaRealm, type ManaStrength } from '../../manaPerceive'
import '../../styles/experiences.css'

const GRID: (string | null)[][] = [
  ['northwest', 'north', 'northeast'],
  ['west', null, 'east'],
  ['southwest', 'south', 'southeast'],
]
const SHORT: Record<string, string> = {
  north: 'N', northeast: 'NE', east: 'E', southeast: 'SE', south: 'S', southwest: 'SW', west: 'W', northwest: 'NW',
  above: 'Up', below: 'Down',
}
const REALM_VAR: Record<Realm, string> = {
  Life: 'var(--mana-life)', Holy: 'var(--mana-holy)', Elemental: 'var(--mana-elemental)',
  Arcane: 'var(--mana-arcane)', Lunar: 'var(--mana-lunar)',
}

function Bubble({ s, realm, big, label, numbers }: {
  s?: ManaStrength; realm: Realm | null; big?: boolean; label?: string; numbers: boolean
}) {
  if (!s) {
    return (
      <div className={`mx-cell${big ? ' mx-cell--here' : ''}`}>
        <span className="mx-none" title={label ? `${label}: not mentioned by PERCEIVE` : undefined} />
        {label && <span className="mx-dir">{label}</span>}
      </div>
    )
  }
  const pct = (s.rank + 1) / MANA_WORDS.length
  const style = {
    '--mx-hue': realm ? REALM_VAR[realm] : 'var(--text-secondary)',
    '--mx-fill': `${Math.round(18 + pct * 52)}%`,
    '--mx-ring': `${Math.round(pct * 1000) / 1000}turn`,
  } as CSSProperties
  return (
    <div className={`mx-cell${big ? ' mx-cell--here' : ''}`}>
      <div className="mx-bubble" style={style} title={`${s.word}: ${s.rank + 1} of ${MANA_WORDS.length}`}>
        <span className="mx-word">{s.word}</span>
        {numbers && <span className="mx-num">{s.rank + 1}/{MANA_WORDS.length}</span>}
      </div>
      {label && <span className="mx-dir">{label}</span>}
    </div>
  )
}

function ManaExperience({ mana, guild, hidden }: ExperienceProps) {
  const def = experienceById('mana')
  const shown = (id: string) => { const o = def?.options?.find(x => x.id === id); return o ? optionShown(hidden, o) : true }
  const numbers = shown('numbers')
  const myRealm = guildManaRealm(guild)

  if (!mana || (!mana.here && mana.near.length === 0)) {
    return (
      <div className="mx-scene">
        <div className="mx-empty">
          <div className="mx-empty-line">PERCEIVE to read this room&apos;s mana.</div>
          <div className="mx-empty-hint">
            {myRealm === 'Lunar'
              ? 'Lunar mana follows the moons, not the room.'
              : guild && !myRealm
                ? 'Your guild doesn’t sense mana.'
                : 'Your room shows in the centre, with the rooms around it that PERCEIVE mentions. It clears when you move.'}
          </div>
        </div>
      </div>
    )
  }

  const by = new Map(mana.near.map(n => [n.dir, n]))
  const other = mana.near.filter(n => !SHORT[n.dir])
  const realm = mana.realm
  return (
    <div className="mx-scene">
      {shown('header') && (
        <div className="mx-header">
          <span className="mx-realm" style={{ color: realm ? REALM_VAR[realm] : undefined }}>{realm ?? 'Mana'}</span>
          <span className="mx-at">{new Date(mana.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        </div>
      )}
      {realm === 'Lunar' && <div className="mx-note">Lunar mana follows the moons, not the room.</div>}
      <div className="mx-body">
        <div className="mx-grid">
          {GRID.flat().map(dir => dir === null
            ? <Bubble key="here" s={mana.here} realm={realm} big numbers={numbers} />
            : <Bubble key={dir} s={by.get(dir)} realm={realm} label={SHORT[dir]} numbers={numbers} />)}
        </div>
        <div className="mx-side">
          <Bubble s={by.get('above')} realm={realm} label="Up" numbers={numbers} />
          <Bubble s={by.get('below')} realm={realm} label="Down" numbers={numbers} />
        </div>
      </div>
      {other.length > 0 && (
        <div className="mx-other">
          {other.map(n => <span key={n.dir}>{n.dir}: {n.word}{numbers ? ` ${n.rank + 1}/${MANA_WORDS.length}` : ''}</span>)}
        </div>
      )}
    </div>
  )
}

export default memo(ManaExperience)
