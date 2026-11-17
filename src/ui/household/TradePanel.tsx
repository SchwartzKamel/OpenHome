import {
  parseWire,
  RemoteError,
  type ApiResponse,
  type Trade,
  type TradeETag,
  type TradeView,
} from '@openhome-core/remote'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PokemonSummary } from './PokemonSummary'
import { vaultTag } from './model'
import { toError, useHousehold, usePrivateDraft } from './workspace'

interface Room {
  trade: Trade
  etag: TradeETag
  ownUserId: string
}
interface RoomOwner {
  readonly roomId: string
  readonly generation: number
  readonly epoch: number
}
function liveTrade(trade: Trade) {
  return trade.state === 'WAITING' || trade.state === 'OPEN'
}
function offerFingerprint(trade: Trade) {
  return JSON.stringify([
    trade.id,
    trade.offer_version,
    trade.participants.map((participant) => ({
      user: participant.user.id,
      offer: participant.offer,
    })),
  ])
}

export function TradePanel() {
  const {
    backend,
    data,
    connection,
    locked,
    durableBlocked,
    mutate,
    refresh,
    announce,
    isCurrent,
    report,
  } = useHousehold()
  const [room, setRoom] = useState<Room>()
  const [joinCode, setJoinCode] = useState('')
  const [createdCode, setCreatedCode] = useState<{ roomId: string; code: string }>()
  const [offer, setOffer] = useState<string[]>([])
  const [reviewed, setReviewed] = useState('')
  const [readError, setReadError] = useState<RemoteError>()
  const [reading, setReading] = useState(false)
  const [pollPaused, setPollPaused] = useState(false)
  const [offerLimit, setOfferLimit] = useState(30)
  const currentRoom = useRef<Room | undefined>(undefined)
  const roomEpoch = useRef(0)
  const readingRef = useRef<RoomOwner | undefined>(undefined)
  const own = room?.trade.participants.find((participant) => participant.user.id === room.ownUserId)
  const fingerprint = room ? offerFingerprint(room.trade) : ''
  const consent = !!room && reviewed === fingerprint
  const open = !!room && liveTrade(room.trade)
  const ownOffer = own?.offer.map((item) => item.pokemon_id) ?? []
  const offerDirty = open && JSON.stringify(offer) !== JSON.stringify(ownOffer)
  usePrivateDraft('trade-join', !!joinCode.trim())
  usePrivateDraft(
    'trade-consent',
    open && consent && own?.confirmed_offer_version !== room?.trade.offer_version
  )
  usePrivateDraft('trade-offer', offerDirty)

  const ownsRoom = useCallback(
    (owner: RoomOwner) =>
      isCurrent() &&
      owner.generation === backend.api.generation &&
      owner.epoch === roomEpoch.current &&
      owner.roomId === currentRoom.current?.trade.id,
    [backend, isCurrent]
  )
  const captureRoom = useCallback(
    (): RoomOwner | undefined =>
      currentRoom.current
        ? {
            roomId: currentRoom.current.trade.id,
            generation: backend.api.generation,
            epoch: roomEpoch.current,
          }
        : undefined,
    [backend]
  )

  const acceptRoom = useCallback(
    (response: ApiResponse<TradeView>, ownUserId: string, owner: RoomOwner | 'select') => {
      if (!isCurrent() || (owner !== 'select' && !ownsRoom(owner))) return false
      if (owner !== 'select' && response.data.trade.id !== owner.roomId)
        throw new RemoteError(
          'protocol_error',
          'The room response did not match the requested room'
        )
      const etag = parseWire('TradeETag', response.etag)
      if (etag !== `"trade-${response.data.trade.revision}"`)
        throw new RemoteError('protocol_error', 'Trade revision and strong ETag disagree')
      const next = { trade: response.data.trade, etag, ownUserId }
      if (!next.trade.participants.some((participant) => participant.user.id === ownUserId))
        throw new RemoteError('protocol_error', 'The authenticated room participant is missing')
      const previous = currentRoom.current
      if (previous?.trade.id === next.trade.id && previous.trade.revision > next.trade.revision)
        return false
      if (owner === 'select') {
        roomEpoch.current++
        readingRef.current = undefined
        setReading(false)
      }
      const before = previous?.trade.participants.find(
        (participant) => participant.user.id === ownUserId
      )
      const after = next.trade.participants.find((participant) => participant.user.id === ownUserId)
      if (
        !previous ||
        previous.trade.id !== next.trade.id ||
        JSON.stringify(before?.offer) !== JSON.stringify(after?.offer)
      ) {
        setOffer(after?.offer.map((item) => item.pokemon_id) ?? [])
      }
      if (
        previous?.trade.id === next.trade.id &&
        offerFingerprint(previous.trade) !== offerFingerprint(next.trade)
      ) {
        setReviewed('')
        announce(
          'Trade offers changed. Both confirmations were reset; review the current offers before consenting again.'
        )
      }
      currentRoom.current = next
      setRoom(next)
      setReadError(undefined)
      return true
    },
    [announce, isCurrent, ownsRoom]
  )

  const refreshRoom = useCallback(
    async (expectedOwner?: RoomOwner) => {
      const current = currentRoom.current
      const owner = expectedOwner ?? captureRoom()
      if (
        !current ||
        !owner ||
        !ownsRoom(owner) ||
        (readingRef.current && ownsRoom(readingRef.current))
      )
        return undefined
      readingRef.current = owner
      setReading(true)
      try {
        const response = await backend.api.call('getTrade', { path: { trade_id: owner.roomId } })
        if (!ownsRoom(owner)) return undefined
        acceptRoom(response, current.ownUserId, owner)
        if (!liveTrade(response.data.trade)) await refresh()
        if (!ownsRoom(owner)) return undefined
        return undefined
      } catch (failure) {
        if (!ownsRoom(owner)) return undefined
        const detail = toError(failure)
        setReadError(detail)
        return detail
      } finally {
        if (readingRef.current === owner) {
          readingRef.current = undefined
          if (ownsRoom(owner)) setReading(false)
        }
      }
    },
    [acceptRoom, backend, captureRoom, ownsRoom, refresh]
  )

  const roomId = room?.trade.id
  useEffect(() => {
    if (!open || !roomId) return
    const owner = captureRoom()
    if (!owner || !ownsRoom(owner)) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let requests = 0
    let nextAllowed = Date.now() + 10_000
    let sequence = backend.connection.eventSequence
    setPollPaused(false)
    const schedule = (delay: number) => {
      clearTimeout(timer)
      if (!active || !ownsRoom(owner)) return
      if (requests >= 60) {
        setPollPaused(true)
        return
      }
      timer = setTimeout(
        () => {
          if (!active || !ownsRoom(owner)) return
          requests++
          void refreshRoom(owner).then((failure) => {
            if (!active || !ownsRoom(owner)) return
            const delay = Math.max(10_000, (failure?.retryAfterSeconds ?? 0) * 1000)
            nextAllowed = Date.now() + delay
            schedule(delay)
          })
        },
        Math.max(delay, nextAllowed - Date.now())
      )
    }
    schedule(10_000)
    const unsubscribe = backend.subscribe(() => {
      const next = backend.connection.eventSequence
      if (!active || !ownsRoom(owner) || next === sequence) return
      sequence = next
      schedule(0)
    })
    return () => {
      active = false
      clearTimeout(timer)
      unsubscribe()
    }
  }, [backend, captureRoom, open, ownsRoom, refreshRoom, roomId])

  const create = () => {
    void mutate(
      'Create private trade room',
      () => backend.api.prepare('createTrade', { body: {} }),
      async (response) => {
        const creator = response.data.trade.participants[0]
        if (!creator || response.data.trade.participants.length !== 1)
          throw new RemoteError(
            'protocol_error',
            'The create receipt did not establish the creator participant'
          )
        if (!acceptRoom(response, creator.user.id, 'select')) return
        setCreatedCode({ roomId: response.data.trade.id, code: response.data.join_code })
        setReviewed('')
        await refresh()
        if (!isCurrent()) return
      }
    )
  }
  const join = () => {
    void mutate(
      'Join private trade room',
      () =>
        backend.api.prepare('joinTrade', {
          body: { join_code: joinCode.trim().toUpperCase() },
        }),
      async (response) => {
        const participant = response.data.trade.participants[1]
        if (!participant || response.data.trade.participants.length !== 2)
          throw new RemoteError(
            'protocol_error',
            'The join receipt did not establish the second participant'
          )
        if (!acceptRoom(response, participant.user.id, 'select')) return
        setCreatedCode(undefined)
        setJoinCode('')
        setReviewed('')
        await refresh()
        if (!isCurrent()) return
      }
    )
  }
  const act = (action: 'offer' | 'confirm' | 'cancel') => {
    const owner = captureRoom()
    if (!room || !data || !owner || !ownsRoom(owner)) return
    const body =
      action === 'offer'
        ? { action, vault_if_match: vaultTag(data.vault.revision), pokemon_ids: offer }
        : action === 'confirm'
          ? {
              action,
              vault_if_match: vaultTag(data.vault.revision),
              offer_version: room.trade.offer_version,
            }
          : { action }
    void mutate(
      `Trade ${action}`,
      () =>
        backend.api.prepare('actOnTrade', {
          path: { trade_id: room.trade.id },
          ifMatch: room.etag,
          body,
        }),
      async (response) => {
        if (!acceptRoom(response, room.ownUserId, owner)) return
        await refresh()
        if (!ownsRoom(owner)) return
        if (response.data.trade.state === 'COMMITTED')
          announce(
            'Trade committed by the server. Acquired Pokémon are unplaced, with the server-provided reset personal metadata.'
          )
      }
    )
  }
  const toggleOffer = (id: string) => {
    if (offer.includes(id)) setOffer((previous) => previous.filter((item) => item !== id))
    else if (offer.length < 6) setOffer((previous) => [...previous, id])
    else report(new RemoteError('limit_exceeded', 'Offer at most six owned Pokémon.'))
    setReviewed('')
  }

  return (
    <section aria-label="Household link trade">
      <h2>Private household link trade</h2>
      <p className="hh-help">
        Two distinct household members, private 10-minute room. Only offered UUIDs and locked
        observations are shared—not collections, labels, source saves, or vault selectors.
      </p>
      <div className="hh-toolbar">
        <button disabled={durableBlocked || open} onClick={create}>
          Create trade room
        </button>
        <form
          className="hh-toolbar"
          onSubmit={(event) => {
            event.preventDefault()
            join()
          }}
        >
          <label>
            Trade join code
            <input
              required
              minLength={12}
              maxLength={12}
              autoComplete="off"
              value={joinCode}
              disabled={locked || open}
              onChange={(event) => setJoinCode(event.target.value)}
            />
          </label>
          <button disabled={durableBlocked || open || joinCode.trim().length !== 12}>
            Join trade room
          </button>
          <button
            type="button"
            disabled={locked || !joinCode.trim()}
            onClick={() => setJoinCode('')}
          >
            Discard join draft
          </button>
        </form>
      </div>
      {createdCode && createdCode.roomId === room?.trade.id && open && (
        <p className="hh-warning">
          Private join code: <strong className="hh-join-code">{createdCode.code}</strong> · share
          only with the intended household member.
        </p>
      )}
      {room && (
        <>
          <div className="hh-toolbar">
            <h3>{room.trade.state}</h3>
            <span>
              Trade revision {room.trade.revision} · offer version {room.trade.offer_version}
            </span>
            <button disabled={reading || locked} onClick={() => void refreshRoom()}>
              Refresh room
            </button>
          </div>
          <p>
            Room <code>{room.trade.id}</code> · expires {room.trade.expires_at}
          </p>
          {open && (
            <p className="hh-help">
              Live invalidations use the backend's authenticated RemoteEvents sequence, with at most
              60 fallback GETs every ≥10 seconds while this room is open. No mutation is
              automatically retried.
            </p>
          )}
          {pollPaused && (
            <p role="status">
              Automatic room reads paused after their bounded budget. Use Refresh room.
            </p>
          )}
          {readError && (
            <p role="alert" className="hh-error">
              {readError.code}: {readError.message}
              {readError.retryAfterSeconds !== undefined
                ? ` · Retry-After ${readError.retryAfterSeconds} seconds`
                : ''}
            </p>
          )}
          <div className="hh-participants">
            {room.trade.participants.map((participant) => (
              <section
                key={participant.user.id}
                className="hh-card"
                aria-label={`${participant.user.username}'s current offer`}
              >
                <h4>
                  {participant.user.username}
                  {participant.user.id === room.ownUserId ? ' (you)' : ''}
                </h4>
                <p>
                  {participant.confirmed_offer_version === room.trade.offer_version
                    ? `Confirmed offer version ${room.trade.offer_version}`
                    : 'Not confirmed for the current offers'}
                </p>
                {!participant.offer.length && <p>Empty offer.</p>}
                {participant.offer.map((item) => (
                  <div key={item.pokemon_id}>
                    <PokemonSummary observed={item.observed} />
                    <code className="hh-id">{item.pokemon_id}</code>
                  </div>
                ))}
              </section>
            ))}
            {room.trade.participants.length < 2 && (
              <p role="status">Waiting for the other member to join.</p>
            )}
          </div>
          {open && (
            <>
              <h3>Your offer ({offer.length}/6)</h3>
              <p>
                Choose only your server-owned UUIDs. Submitting any offer, even unchanged, resets
                both confirmations and reserves those records.
              </p>
              <div className="hh-offer-choices">
                {data?.records.slice(0, offerLimit).map((record) => {
                  const reservedElsewhere = data.vault.reservations.some(
                    (reservation) =>
                      reservation.operation_id !== room.trade.id &&
                      'pokemon_id' in reservation.resource &&
                      reservation.resource.pokemon_id === record.id
                  )
                  return (
                    <label className="hh-check hh-card" key={record.id}>
                      <input
                        type="checkbox"
                        checked={offer.includes(record.id)}
                        disabled={locked || reservedElsewhere}
                        onChange={() => toggleOffer(record.id)}
                        aria-label={`Offer ${record.observed.nickname || `species ${record.observed.species}`} ${record.id}`}
                      />
                      <span>
                        <PokemonSummary observed={record.observed} />
                        <code className="hh-id">{record.id}</code>
                        {reservedElsewhere ? 'Reserved elsewhere' : ''}
                      </span>
                    </label>
                  )
                })}
              </div>
              {(data?.records.length ?? 0) > offerLimit && (
                <button onClick={() => setOfferLimit((count) => count + 30)}>
                  Show 30 more owned trade choices
                </button>
              )}
              <div className="hh-toolbar">
                <button disabled={durableBlocked || offer.length > 6} onClick={() => act('offer')}>
                  Submit my UUID offer
                </button>
                <button
                  disabled={locked || !offerDirty}
                  onClick={() => {
                    setOffer(ownOffer)
                    setReviewed('')
                  }}
                >
                  Discard unsent offer selection
                </button>
              </div>
              <label className="hh-check hh-warning">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={locked || offerDirty}
                  onChange={(event) => setReviewed(event.target.checked ? fingerprint : '')}
                />
                I reviewed both current offers (version {room.trade.offer_version}) and consent only
                to these Pokémon. Changed offers require new consent.
              </label>
              <div className="hh-toolbar">
                <button
                  disabled={
                    durableBlocked ||
                    !consent ||
                    offerDirty ||
                    room.trade.participants.length !== 2 ||
                    !room.trade.participants.some((participant) => participant.offer.length) ||
                    own?.confirmed_offer_version === room.trade.offer_version
                  }
                  onClick={() => act('confirm')}
                >
                  Confirm current offers
                </button>
                <button disabled={durableBlocked} onClick={() => act('cancel')}>
                  Cancel trade room
                </button>
              </div>
            </>
          )}
          {room.trade.state === 'COMMITTED' && (
            <p className="hh-success">
              Server-committed exchange. Refresh the Collection tab for authoritative acquired
              records. No client-side optimistic swap occurred.
            </p>
          )}
        </>
      )}
      {connection.editing && (
        <p>Save or roll back your staged collection changes before offering or confirming.</p>
      )}
    </section>
  )
}
