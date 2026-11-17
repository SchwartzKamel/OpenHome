import { initialVault, record, realPokemon, id } from '@openhome-core/remote/__test__/support'
import { describe, expect, it } from 'vitest'
import { rebaseContent } from './model'

describe('household conflict-preserving three-way rebase', () => {
  it('refuses contested slot occupants and duplicate concurrent placements', () => {
    const pokemon = realPokemon()
    const base = initialVault([record(pokemon.observed)]).content
    const current = structuredClone(base)
    const staged = structuredClone(base)
    current.banks[0].boxes[0].slots[0] = null
    current.banks[0].boxes[0].slots[1] = id(3)
    staged.banks[0].boxes[0].slots[0] = null
    staged.banks[0].boxes[0].slots[2] = id(3)
    expect(() => rebaseContent(base, current, staged)).toThrow(/Concurrent placements conflict/)
    current.banks[0].boxes[0].slots[2] = id(99)
    expect(() => rebaseContent(base, current, staged)).toThrow(/changed on both clients/)
  })

  it('does not drop an acquired record or overwrite metadata changed by another client', () => {
    const pokemon = realPokemon()
    const base = initialVault([record(pokemon.observed)]).content
    const current = structuredClone(base)
    const staged = structuredClone(base)
    current.metadata.push({ pokemon_id: id(90), favorite: false, tags: [] })
    current.metadata[0].tags = ['remote']
    staged.metadata[0].favorite = true
    const merged = rebaseContent(base, current, staged)
    expect(merged.metadata).toEqual([
      { pokemon_id: id(3), favorite: true, tags: ['remote'] },
      { pokemon_id: id(90), favorite: false, tags: [] },
    ])
    staged.metadata[0].tags = ['local']
    expect(() => rebaseContent(base, current, staged)).toThrow(/labels changed on both clients/)
  })
})
