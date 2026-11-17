import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'openhome wasm build '))
  t.after(() => rmSync(directory, { recursive: true }))
  const scripts = join(directory, 'scripts')
  const bin = join(directory, 'bin')
  const cargo = join(directory, 'cargo home')
  for (const path of [scripts, bin, cargo]) mkdirSync(path)
  copyFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'compile-wasm.mjs'),
    join(scripts, 'compile-wasm.mjs')
  )
  const capture = join(directory, 'captured.json')
  const marker = join(directory, 'patched')
  writeFileSync(
    join(bin, 'wasm-pack'),
    `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.BUILD_CAPTURE, JSON.stringify({
  args:process.argv.slice(2), cwd:process.cwd(),
  flags:process.env.CARGO_ENCODED_RUSTFLAGS.split('\\u001f')
}));
process.exit(Number(process.env.BUILD_EXIT || 0));
`,
    { mode: 0o700 }
  )
  writeFileSync(
    join(scripts, 'patch-types.mjs'),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'patched');`
  )
  return {
    directory,
    cargo,
    capture,
    marker,
    run(profile, extra = {}) {
      const environment = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CARGO_HOME: cargo,
        BUILD_CAPTURE: capture,
        ...extra,
      }
      delete environment.CARGO_ENCODED_RUSTFLAGS
      if (extra.CARGO_ENCODED_RUSTFLAGS !== undefined) {
        environment.CARGO_ENCODED_RUSTFLAGS = extra.CARGO_ENCODED_RUSTFLAGS
      }
      return spawnSync(process.execPath, [join(scripts, 'compile-wasm.mjs'), profile], {
        env: environment,
        encoding: 'utf8',
      })
    },
  }
}

test('real launcher normalizes source/cache paths with spaces and retains caller flags', (t) => {
  const f = fixture(t)
  for (const profile of ['release', 'dev']) {
    const result = f.run(
      profile,
      profile === 'release'
        ? { RUSTFLAGS: '-C opt-level=2' }
        : { RUSTFLAGS: 'ignored', CARGO_ENCODED_RUSTFLAGS: '-C\u001fdebuginfo=1' }
    )
    assert.equal(result.status, 0, result.stderr)
    const actual = JSON.parse(readFileSync(f.capture, 'utf8'))
    assert.equal(actual.cwd, f.directory)
    assert.deepEqual(actual.args, [
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
    ])
    assert.deepEqual(actual.flags, [
      '-C',
      profile === 'release' ? 'opt-level=2' : 'debuginfo=1',
      `--remap-path-prefix=${f.directory}=/openhome-source`,
      `--remap-path-prefix=${f.cargo}=/cargo-home`,
    ])
    assert.equal(readFileSync(f.marker, 'utf8'), 'patched')
  }
})

test('compiler failure preserves its status and never runs the type patcher', (t) => {
  const f = fixture(t)
  assert.equal(f.run('release', { BUILD_EXIT: '23' }).status, 23)
  assert.throws(() => readFileSync(f.marker), { code: 'ENOENT' })
  assert.equal(f.run('unknown').status, 2)
})
