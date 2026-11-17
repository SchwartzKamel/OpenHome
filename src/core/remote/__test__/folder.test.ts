// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { IdentityMap, projectBanks, translateBanks } from '../identity'
import { isObject, parseJson, parseWire } from '../validation'
import { realPokemon } from './support'

it('preserves actual folder UUID/name/index/history mappings while translating sparse IDs through real binary identities', () => {
  const fixture = parseJson(
    readFileSync(
      new URL('../../../../../contracts/folder-adapter.fixtures.json', import.meta.url),
      'utf8'
    )
  )
  if (!isObject(fixture) || !isObject(fixture.expected_import))
    throw new Error('Invalid mapping fixture')
  const content = parseWire('VaultContent', fixture.expected_import.content)
  const pokemon = realPokemon()
  const map = new IdentityMap()
  map.register(content.metadata[0].pokemon_id, pokemon.binary)
  const stored = projectBanks(content, map)
  const link = content.openhome_compatibility?.banks[0]
  expect(stored.banks[0].id).toBe(link?.folder_id)
  expect(stored.banks[0].name).toBeNull()
  expect(stored.banks[0].boxes.get(0)?.name).toBeNull()
  expect([...(stored.banks[0].boxes.get(0)?.identifiers ?? [])]).toEqual([[0, pokemon.identifier]])
  const translated = translateBanks(stored, content, map)
  expect(translated.banks).toEqual(content.banks)
  expect(translated.openhome_compatibility).toEqual(content.openhome_compatibility)
  expect(
    translated.openhome_compatibility?.pokedex_history.find((entry) => entry.species === 150)
  ).toMatchObject({
    level: 'Seen',
    games: ['Red'],
    extra: [],
    flags: [],
    shiny_leaves: 0,
  })
  expect(map.bytes(content.metadata[0].pokemon_id)).toEqual(pokemon.binary)
  // The contract's AA== fixture is shape evidence only, not a purported OHPKM parser fixture.
})

it('rejects repeated placements and inconsistent folder Map indices before staging any request', () => {
  const pokemon = realPokemon()
  const map = new IdentityMap()
  const pokemonId = '00000000-0000-4000-8000-000000000003'
  map.register(pokemonId, pokemon.binary)
  const content = parseWire('VaultContent', {
    banks: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Bank 1',
        boxes: [
          {
            id: '00000000-0000-4000-8000-000000000002',
            name: 'Box 1',
            slots: Array.from({ length: 30 }, (_, slot) => (slot === 0 ? pokemonId : null)),
          },
        ],
      },
    ],
    settings: {
      theme: 'system',
      language: 'en',
      sort: 'manual',
      snapshot_retention: 10,
      default_strategy_id: null,
    },
    lookups: [],
    conversion_strategies: [],
    metadata: [{ pokemon_id: pokemonId, favorite: false, tags: [] }],
  })
  const stored = projectBanks(content, map)
  const box = stored.banks[0].boxes.get(0)
  if (!box) throw new Error('No fixture box')
  box.identifiers.set(1, pokemon.identifier)
  expect(() => translateBanks(stored, content, map)).toThrow('cannot occupy two slots')
  box.identifiers.delete(1)
  box.index = 2
  expect(() => translateBanks(stored, content, map)).toThrow('indices must be consecutive')
})
