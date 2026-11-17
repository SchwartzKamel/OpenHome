import type { ObservedPokemon } from '@openhome-core/remote'
import { MetadataSummaryLookup } from '@pkm-rs/pkg'
import { useMemo, useState } from 'react'
import { getPublicImageURL } from '@openhome-ui/images/images'

export function speciesLabel(species: number, form = 0): string {
  const metadata = MetadataSummaryLookup(species, form)
  if (!metadata) return `Species ${species} · form ${form}`
  try {
    return metadata.formName
  } finally {
    metadata.free()
  }
}

export function PokemonSummary({
  observed,
  compact = false,
}: {
  observed: ObservedPokemon
  compact?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const metadata = useMemo(() => {
    const resource = MetadataSummaryLookup(observed.species, observed.form)
    if (!resource) return undefined
    try {
      return { name: resource.formName, sprite: resource.sprite }
    } finally {
      resource.free()
    }
  }, [observed.species, observed.form])
  return (
    <span className={`hh-pokemon${compact ? ' hh-pokemon-compact' : ''}`}>
      {metadata && !failed && (
        <img
          className="hh-pokemon-icon"
          src={getPublicImageURL(`sprites/box-home/${metadata.sprite}.webp`)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
      <span>
        <strong>{observed.nickname || metadata?.name || `Species ${observed.species}`}</strong>
        {!compact && (
          <small>
            {metadata?.name || `Species ${observed.species}`} · #{observed.species} · form{' '}
            {observed.form}
          </small>
        )}
        <small>
          Lv. {observed.level}
          {observed.shiny ? ' · ✦ Shiny' : ''}
        </small>
      </span>
    </span>
  )
}
