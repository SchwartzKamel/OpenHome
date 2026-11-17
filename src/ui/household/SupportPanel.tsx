import type { Status } from '@openhome-core/remote'
import { useState } from 'react'
import { useHousehold } from './workspace'

export function SupportPanel() {
  const { backend, connection, local, locked, isCurrent } = useHousehold()
  const [latest, setLatest] = useState<Status>()
  const status = latest ?? connection.status
  return (
    <section aria-label="Actual server capabilities">
      <h2>Server capabilities and evidence boundaries</h2>
      <button
        disabled={locked}
        onClick={() =>
          void local(async () => {
            const response = await backend.api.call('getStatus', {})
            if (isCurrent()) setLatest(response.data)
          })
        }
      >
        Read actual server status
      </button>
      {!status && <p role="status">No ready status received. Capabilities are not assumed.</p>}
      {status && (
        <>
          <dl className="hh-facts">
            <dt>Ready</dt>
            <dd>{String(status.ready)}</dd>
            <dt>API</dt>
            <dd>{status.api_version}</dd>
            <dt>Worker version</dt>
            <dd>{status.engine.worker_version}</dd>
            <dt>Upstream revision</dt>
            <dd>
              <code>{status.engine.upstream_revision}</code>
            </dd>
            <dt>Server native-write flag</dt>
            <dd>
              {status.features.native_writes_enabled
                ? 'Enabled by server (not client/hardware certification)'
                : 'Disabled'}
            </dd>
            <dt>Server native families</dt>
            <dd>{status.features.native_write_families.join(', ') || 'None'}</dd>
            <dt>Workspace native writes</dt>
            <dd>Disabled; no automatic local_applied/finalize acknowledgement.</dd>
            <dt>Import limits</dt>
            <dd>
              {status.limits.pkm_bytes.toLocaleString()} PKM bytes;{' '}
              {status.limits.save_bytes.toLocaleString()} save bytes
            </dd>
          </dl>
          <div className="hh-table-scroll">
            <table>
              <caption>
                Actual Status.engine.capabilities—not a universal format-support promise
              </caption>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Input</th>
                  <th>Advertised outputs</th>
                </tr>
              </thead>
              <tbody>
                {status.engine.capabilities.map((capability, index) => (
                  <tr key={`${capability.operation}:${capability.input_format}:${index}`}>
                    <td>{capability.operation}</td>
                    <td>{capability.input_format}</td>
                    <td>{capability.output_formats.join(', ') || 'No game PKM outputs'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <section className="hh-card" aria-label="Checked-in engine scope notes">
        <h3>Checked-in engine evidence scope</h3>
        <p>
          These are the bounded upstream fixture notes from the bundled engine documentation, not a
          live attestation of this server build. A family advertisement does not certify every
          variant.
        </p>
        <ul>
          <li>
            Gen1: International/Japanese Blue in-memory preparation; not physical cartridge or VC
            archive certification.
          </li>
          <li>
            Gen2: International/Japanese Crystal; not Gold/Silver. International active-box editing
            has an explicit unverified synchronization limit.
          </li>
          <li>Gen4: Pearl, Platinum, HeartGold fixture coverage.</li>
          <li>Gen5: Black/White fixtures; B2/W2 are not certified by that evidence.</li>
          <li>
            Gen6: bounded XY PC interoperability only; not ORAS, complete live-save/trainer/header
            validity, or hardware certification.
          </li>
          <li>
            Gen7 and later variants: do not infer working support from a roadmap. Only actual
            advertised operations can be attempted, and independent fixture/hardware evidence
            remains separate.
          </li>
        </ul>
        <p>
          No universal legality, official HOME compatibility, Nintendo signing, native filesystem
          overwrite, or console-write claim. Unsupported operations and checksum/conversion failures
          remain visible.
        </p>
      </section>
    </section>
  )
}
