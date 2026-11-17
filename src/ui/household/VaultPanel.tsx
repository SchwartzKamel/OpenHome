import { newId, type Bank, type Box, type PokemonRecord } from '@openhome-core/remote'
import { useState, type KeyboardEvent } from 'react'
import { collectionById, placement, reserved } from './model'
import { PokemonSummary, speciesLabel } from './PokemonSummary'
import { useHousehold, usePrivateDraft } from './workspace'

export function VaultPanel({
  selected,
  onSelect,
}: {
  selected: string
  onSelect: (id: string) => void
}) {
  const { data, connection, locked, stage, announce } = useHousehold()
  const [bankId, setBankId] = useState('')
  const [boxId, setBoxId] = useState('')
  const [unplacedLimit, setUnplacedLimit] = useState(30)
  if (!data) return null
  const { vault, records } = data
  const bank = vault.content.banks.find((item) => item.id === bankId) ?? vault.content.banks[0]
  const box = bank?.boxes.find((item) => item.id === boxId) ?? bank?.boxes[0]
  const byId = collectionById(records)
  const unplaced = records.filter((record) => !placement(vault.content, record.id))
  const editBlocked = locked || (!connection.coherent && !connection.editing)
  const move = async (slot: number) => {
    if (!selected || !bank || !box || box.slots[slot]) {
      announce('Choose an owned Pokémon, then an empty slot. Occupied slots are never overwritten.')
      return
    }
    await stage([
      {
        op: 'pokemon_place',
        pokemon_id: selected,
        destination: { bank_id: bank.id, box_id: box.id, slot },
      },
    ])
  }
  const navigateGrid = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof HTMLButtonElement)) return
    const slot = Number(target.dataset.slot)
    if (!Number.isInteger(slot)) return
    let next = slot
    switch (event.key) {
      case 'ArrowRight':
        next = Math.min(29, slot + 1)
        break
      case 'ArrowLeft':
        next = Math.max(0, slot - 1)
        break
      case 'ArrowDown':
        next = Math.min(29, slot + 6)
        break
      case 'ArrowUp':
        next = Math.max(0, slot - 6)
        break
      case 'Home':
        next = event.ctrlKey ? 0 : Math.floor(slot / 6) * 6
        break
      case 'End':
        next = event.ctrlKey ? 29 : Math.floor(slot / 6) * 6 + 5
        break
      default:
        return
    }
    event.preventDefault()
    event.currentTarget.querySelector<HTMLButtonElement>(`button[data-slot="${next}"]`)?.focus()
  }
  return (
    <section aria-label="Vault banks and boxes">
      <div className="hh-toolbar">
        <label>
          Bank
          <select
            value={bank?.id ?? ''}
            onChange={(event) => {
              setBankId(event.target.value)
              setBoxId('')
            }}
          >
            {vault.content.banks.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Box
          <select value={box?.id ?? ''} onChange={(event) => setBoxId(event.target.value)}>
            {bank?.boxes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <span>{box?.slots.filter(Boolean).length ?? 0} / 30 occupied</span>
        <button
          disabled={!selected || editBlocked || reserved(vault.reservations, selected)}
          onClick={() =>
            void stage([{ op: 'pokemon_place', pokemon_id: selected, destination: null }])
          }
        >
          Unplace selected
        </button>
      </div>
      <p className="hh-help">
        Select a Pokémon, switch boxes if needed, then choose an empty slot. Changes are staged
        until saved. Arrow keys navigate the grid.
      </p>
      {box && bank && (
        <>
          <div
            role="grid"
            aria-label={`${bank.name} / ${box.name}: 30 slots`}
            aria-rowcount={5}
            aria-colcount={6}
            className="hh-grid"
            onKeyDown={navigateGrid}
          >
            {Array.from({ length: 5 }, (_, row) => (
              <div role="row" className="hh-grid-row" key={row}>
                {box.slots.slice(row * 6, row * 6 + 6).map((id, column) => {
                  const slot = row * 6 + column
                  const record = id ? byId.get(id) : undefined
                  const address = { bank_id: bank.id, box_id: box.id, slot }
                  const unavailable = reserved(vault.reservations, id ?? undefined, address)
                  const selectedReserved = !!selected && reserved(vault.reservations, selected)
                  return (
                    <div role="gridcell" key={slot} aria-colindex={column + 1}>
                      <button
                        data-slot={slot}
                        type="button"
                        className={id ? 'hh-slot hh-slot-occupied' : 'hh-slot'}
                        aria-pressed={id ? selected === id : undefined}
                        aria-label={`Slot ${slot + 1}: ${record ? `${record.observed.nickname || speciesLabel(record.observed.species, record.observed.form)}, level ${record.observed.level}${record.observed.shiny ? ', shiny' : ''}` : id ? 'unavailable record' : 'empty'}${unavailable ? ', reserved' : ''}`}
                        disabled={!id && (editBlocked || unavailable || selectedReserved)}
                        onClick={() => {
                          if (id) onSelect(id)
                          else void move(slot)
                        }}
                      >
                        <span className="hh-slot-number">{slot + 1}</span>
                        {record ? (
                          <PokemonSummary observed={record.observed} compact />
                        ) : id ? (
                          <strong>Unavailable record</strong>
                        ) : (
                          <span>Empty</span>
                        )}
                        {record?.metadata.favorite && (
                          <span className="hh-star" aria-label="Favorite">
                            ★
                          </span>
                        )}
                        {unavailable && <small>Reserved</small>}
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <LayoutEditor key={`${bank.id}:${box.id}`} bank={bank} box={box} />
        </>
      )}
      <section aria-label="Unplaced Pokémon">
        <h2>
          Unplaced Pokémon <span className="hh-count">{unplaced.length}</span>
        </h2>
        <p className="hh-help">
          COPY imports and acquired trades arrive here. Rollback never undoes a previously
          acknowledged import.
        </p>
        {!records.length && (
          <p role="status">
            Your vault is empty. Import PKM/OHPKM or copy selected Pokémon from a complete save.
          </p>
        )}
        {!!records.length && !unplaced.length && <p>No unplaced Pokémon.</p>}
        <div className="hh-record-list">
          {unplaced.slice(0, unplacedLimit).map((record) => (
            <RecordChoice
              key={record.id}
              record={record}
              selected={selected === record.id}
              onSelect={onSelect}
            />
          ))}
        </div>
        {unplaced.length > unplacedLimit && (
          <button onClick={() => setUnplacedLimit((count) => count + 30)}>
            Show 30 more unplaced
          </button>
        )}
      </section>
    </section>
  )
}

export function RecordChoice({
  record,
  selected,
  onSelect,
}: {
  record: PokemonRecord
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      className="hh-record-choice"
      aria-pressed={selected}
      onClick={() => onSelect(record.id)}
    >
      <PokemonSummary observed={record.observed} />
      <small>
        {record.metadata.favorite ? '★ Favorite · ' : ''}
        {record.metadata.tags.join(' · ')}
      </small>
      <code className="hh-id" title={record.id}>
        {record.id}
      </code>
    </button>
  )
}

function LayoutEditor({ bank, box }: { bank: Bank; box: Box }) {
  const { data, locked, connection, stage } = useHousehold()
  const [bankName, setBankName] = useState(bank.name)
  const [boxName, setBoxName] = useState(box.name)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<'box' | 'bank'>('box')
  const blocked = locked || (!connection.coherent && !connection.editing)
  usePrivateDraft('layout', bankName !== bank.name || boxName !== box.name || !!newName)
  return (
    <details className="hh-card">
      <summary>Manage banks and boxes</summary>
      <div className="hh-form-grid">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void stage([{ op: 'bank_put', bank: { ...bank, name: bankName.trim() } }])
          }}
        >
          <label>
            Bank name
            <input
              required
              maxLength={64}
              value={bankName}
              onChange={(event) => setBankName(event.target.value)}
            />
          </label>
          <button disabled={blocked || bankName === bank.name}>Stage bank rename</button>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void stage([{ op: 'box_put', bank_id: bank.id, box: { ...box, name: boxName.trim() } }])
          }}
        >
          <label>
            Box name
            <input
              required
              maxLength={64}
              value={boxName}
              onChange={(event) => setBoxName(event.target.value)}
            />
          </label>
          <button disabled={blocked || boxName === box.name}>Stage box rename</button>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const name = newName.trim()
            const createdBox: Box = {
              id: newId(),
              name: newKind === 'box' ? name : 'Box 1',
              slots: Array.from({ length: 30 }, () => null),
            }
            void stage(
              newKind === 'box'
                ? [{ op: 'box_put', bank_id: bank.id, box: createdBox }]
                : [{ op: 'bank_put', bank: { id: newId(), name, boxes: [createdBox] } }]
            ).then((ok) => {
              if (ok) setNewName('')
            })
          }}
        >
          <label>
            Create
            <select
              value={newKind}
              onChange={(event) => setNewKind(event.target.value === 'bank' ? 'bank' : 'box')}
            >
              <option value="box">Box in this bank</option>
              <option value="bank">Bank with one box</option>
            </select>
          </label>
          <label>
            New name
            <input
              required
              maxLength={64}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <button
            disabled={
              blocked ||
              !newName.trim() ||
              (newKind === 'box'
                ? bank.boxes.length >= 64
                : (data?.vault.content.banks.length ?? 16) >= 16)
            }
          >
            Stage creation
          </button>
        </form>
      </div>
      <div className="hh-toolbar">
        <button
          disabled={locked}
          onClick={() => {
            setBankName(bank.name)
            setBoxName(box.name)
            setNewName('')
          }}
        >
          Discard unsent layout names
        </button>
        <button
          disabled={blocked || bank.boxes.length <= 1 || box.slots.some(Boolean)}
          onClick={() => void stage([{ op: 'box_delete', bank_id: bank.id, box_id: box.id }])}
        >
          Stage deletion of empty box
        </button>
        <button
          disabled={
            blocked ||
            (data?.vault.content.banks.length ?? 1) <= 1 ||
            bank.boxes.some((entry) => entry.slots.some(Boolean))
          }
          onClick={() => void stage([{ op: 'bank_delete', bank_id: bank.id }])}
        >
          Stage deletion of empty bank
        </button>
      </div>
      <p className="hh-help">
        The last bank/box and nonempty banks/boxes cannot be deleted. Imported records and legacy
        Pokédex history are preserved.
      </p>
    </details>
  )
}
