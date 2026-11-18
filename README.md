# OpenHome

## Fork & Remote Server Notice

> **Important:** This is the `feat/remote-backend` fork used with
> [`openhome-server`](../README.md), **not** upstream
> [`andrewbenington/OpenHome`](https://github.com/andrewbenington/OpenHome).
> Upstream GitHub Releases do not include remote server support.

When connected to **`openhome-server` (Remote mode)**, capabilities and
guarantees differ from upstream **Local desktop mode**:

| Feature / Guarantee        | Upstream Local Mode (Desktop Only)                                             | Remote Server Mode (`openhome-server`)                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Box & save layout**      | 120-slot local banks, plugins, item bag                                        | **30-slot boxes** only; no plugins, item bag, or desktop-only editors                                                                                                                                                                                                                                                                                                                                                            |
| **Supported PKM / saves**  | All official formats (except Korean Gen 1–2, Colosseum/XD, HOME) + 4 ROM hacks | **Bounded subset:** `OHPKM` V2 and `PK1/2/4/5/6/7/8`; saves: `Gen 1` (Int/JP, excluding standalone JP `PK1` conversion), `Gen 2` (Crystal — **no Gold/Silver**), `Gen 4` (Pearl/Platinum/HeartGold tested; Diamond/SoulSilver unverified), `Gen 5` (Black/White — **no B2/W2**), `Gen 6` (repaired XY PC-box fixture only; live saves & ORAS uncertified), `Gen 7` (Moon SM & Ultra Sun USUM tested; Sun/Ultra Moon uncertified) |
| **Unsupported in Remote**  | —                                                                              | **Excluded:** `OHPKM V1`, standalone JP `PK1` conversion, Gen 3/`PK3`, `PB7/PB8/PA8/PK9/PA9`, Gen 8+ saves, `Gold/Silver`, `B2/W2`, `ORAS`, ROM hacks, plugins, item bag, party access, VC archive extraction/reimport, and direct 3DS save writes                                                                                                                                                                               |
| **Conversion loss policy** | Mutates PID/OT/conversion data locally                                         | **`allow_lossy: false` by default** (`422` when lossy); preview-only lossy export requires explicit per-insertion consent                                                                                                                                                                                                                                                                                                        |
| **Source saves & custody** | Reads/writes local save files directly                                         | **Source saves are never overwritten on upload** (COPY semantics); raw original bytes/length/SHA-256 retained separately                                                                                                                                                                                                                                                                                                         |
| **Vault separation**       | Local desktop folder only                                                      | Local desktop collections and server vaults are **separate** (no auto-upload or merge)                                                                                                                                                                                                                                                                                                                                           |

### Fork Run & Build Links

- **Run server & browser client:** See [`../docs/running.md`](../docs/running.md)
- **Build & connect the Linux desktop client:** Follow [`../docs/desktop.md`](../docs/desktop.md) (`pnpm --dir openhome install --frozen-lockfile --ignore-scripts`, **not** upstream `BUILD_LINUX.md` / `make start`; Linux `--debug` verified only, Windows/macOS untested)
- **Remote backend & UI guides:**
  - [`src/core/remote/README.md`](src/core/remote/README.md) — `RemoteBackend`, transport, retry, and transaction invariants
  - [`src/ui/remote-controls/README.md`](src/ui/remote-controls/README.md) — profiles, auth, 3DS pairing, snapshots, and folder import/export
  - [`src/ui/household/README.md`](src/ui/household/README.md) — 30-slot boxes, COPY imports, tags/favorites, trackers, and link trade rooms

## Disclaimer

OpenHome is intended for hobby use only. Modified Pokémon are not guaranteed
to be legal in official competitions or online play and should never be moved
into Pokémon HOME (doing so may suspend your account). No Nintendo-service
compatibility is claimed, piracy is not endorsed, and you should always back up
original save files before modifying them.

---

## Upstream OpenHome Overview (Local Mode)

> Everything below describes upstream OpenHome's **Local desktop mode** and does
> **not** apply to `openhome-server` Remote mode.

OpenHome is an open-source, cross-platform tool (built with Tauri, React,
Radix UI, and Vite) for storing and moving Pokémon between local save files,
including backward transfers across generations while retaining future-game
data in local OpenHome storage.

<img width="900" src="docs/newScreenshots/MainPage.png">

### Upstream Local-Mode Building & Demo

To build standalone **Local mode** without `openhome-server` remote features:

- [Windows build guide](./docs/BUILD_WINDOWS.md)
- [macOS build guide](./docs/BUILD_MAC.md)
- [Linux build guide](./docs/BUILD_LINUX.md) (upstream local desktop only — for this fork, use [`../docs/desktop.md`](../docs/desktop.md))
- [Install notes](./docs/INSTALL.md) · [Upstream project page](https://andrewbenington.github.io/OpenHome/) · [Local-mode demo video](https://youtu.be/s8MoLsySvOw)

### Upstream Local-Mode Format Support

Local mode supports official PKM/save formats except Korean Gen 1/Gen 2,
Pokémon Colosseum/XD, and Pokémon HOME files, plus four ROM hacks:

- Pokémon Radical Red
- Pokémon Unbound
- Pokémon Luminescent Platinum
- Pokémon Compass

When moving Pokémon to older games in Local mode, OpenHome adapts tracking
fields (such as PID or Gen 1/2 OT tracking IDs) to preserve nature, ability,
gender, and shininess where possible, and restores local data when moved back
to newer games.

### Code & Research Credits

- **[PKHeX](https://github.com/kwsch/PKHeX)**, [Project Pokémon](https://projectpokemon.org/),
  [PokémonDB](https://pokemondb.net/), and [Bulbagarden](https://www.bulbagarden.net/)
  for PKM/save format documentation, encryption/decryption, personal stats,
  move learnsets, and text/sprite resources.
- **ROM hack & icon credits:** Radical Red Team, Team Luminescent
  (PKLumiHeX), Pokémon Compass / PKCompassHeX, and
  [PkmnHomeIcons](https://github.com/nileplumb/PkmnHomeIcons).
