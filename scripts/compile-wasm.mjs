import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return resolve(path)
  }
}

export function wasmEnvironment(directory, environment = process.env) {
  const encoded = environment.CARGO_ENCODED_RUSTFLAGS
  const flags =
    encoded === undefined
      ? environment.RUSTFLAGS?.trim()
        ? environment.RUSTFLAGS.trim().split(/\s+/)
        : []
      : encoded
        ? encoded.split('\u001f')
        : []
  const source = canonicalPath(directory)
  const cargo = canonicalPath(
    resolve(directory, environment.CARGO_HOME ?? join(homedir(), '.cargo'))
  )
  return {
    ...environment,
    CARGO_HOME: cargo,
    CARGO_ENCODED_RUSTFLAGS: [
      ...flags,
      `--remap-path-prefix=${source}=/openhome-source`,
      `--remap-path-prefix=${cargo}=/cargo-home`,
    ].join('\u001f'),
  }
}

export function compileWasm(profile) {
  if (profile !== 'release' && profile !== 'dev') {
    console.error('Usage: node scripts/compile-wasm.mjs release|dev')
    return 2
  }
  const options = { cwd: root, env: wasmEnvironment(root), stdio: 'inherit' }
  const commands = [
    [
      'wasm-pack',
      [
        'build',
        `--${profile}`,
        ...(profile === 'dev' ? ['--panic-unwind'] : []),
        './pkm_rs',
        '--target',
        'web',
        '--',
        '--locked',
        '--features',
        'wasm',
      ],
    ],
    [process.execPath, [join(root, 'scripts/patch-types.mjs')]],
  ]
  for (const [command, arguments_] of commands) {
    const result = spawnSync(command, arguments_, options)
    if (result.error) {
      console.error(`WASM build could not run ${command}: ${result.error.message}`)
      return 1
    }
    if (result.signal) {
      console.error(`WASM build stopped by ${result.signal}`)
      return 1
    }
    if (result.status !== 0) return result.status
  }
  return 0
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.exitCode = compileWasm(process.argv[2])
}
