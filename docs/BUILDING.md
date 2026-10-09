# Building from source

Use this file when you want your own binary, or when you are about to change the code and need the
test gates on your machine first. For day-to-day use of a published build, see
[USAGE.md](USAGE.md).

## 1. What you are building

One desktop application and two small helper executables. All three come out of one build, but they
are separate crates:

| Artifact | Crate | What it is for |
| --- | --- | --- |
| `auto-quest-complete-discord` | `src-tauri` | The app itself: Tauri 2 shell, Vue 3 frontend, Discord REST/Gateway client, CDP client, quest engine, game simulation |
| runner | `src-runner` | A minimal game process. Discord's activity scanner has to see a real process to accept a simulated game, so the app launches this instead of the game. It is embedded in the app bundle |
| `waybridge` | `src-cdp-launcher` | The CDP launcher sidecar. Starts your Discord or Vesktop client with `--remote-debugging-port`. It ships as an external binary (`src-tauri/binaries/waybridge-<target-triple>[.exe]`) and must stay next to the main executable in a portable package |

`crates/discord-cdp-launch-core` is a library, not an artifact: client discovery and launch logic
shared by the app and the sidecar. It must stay free of Tauri — CI enforces that with
`pnpm run check:cdp-core-deps`.

## 2. Prerequisites

| Component | Requirement | Notes |
| --- | --- | --- |
| Node.js | 18 or newer | Vite 7 and the scripts in `scripts/` |
| pnpm | `11.18.0` | Pinned by `"packageManager"` in `package.json`. With `corepack enable` you get the pinned version automatically; a different pnpm can resolve a different dependency tree |
| Rust | stable toolchain | The whole workspace builds on stable; `--locked` is used in CI, so keep `Cargo.lock` committed |
| Windows | Visual Studio Build Tools with the C++ workload, plus the Evergreen WebView2 runtime | WebView2 is already present on current Windows 10/11 builds |
| macOS | Xcode Command Line Tools | Apple Silicon build; macOS 11 or newer |
| Linux | `build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev curl wget file patchelf xdg-utils` | apt-based distributions. `build-ubuntu.sh --install-deps` installs exactly this list |

Python is only needed for `pnpm run analyze:har`, a development aid for reading quest payloads out
of a HAR capture. It is not part of the build.

## 3. First-time setup

```bash
git clone https://github.com/ninokiru/Auto-Quest-Complete-Discord.git
cd Auto-Quest-Complete-Discord
corepack enable            # optional, but gives you the pinned pnpm
pnpm install
```

`pnpm install` only fetches frontend packages. Rust dependencies are fetched by the first `cargo` or
`tauri` invocation.

## 4. Run it in development

```bash
pnpm tauri:dev
```

That single command is a chain, defined in `package.json`:

1. `pnpm run sync-version` — copies `public/version.txt` into `package.json`,
   `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
2. `pnpm run build:runner` — builds the runner sidecar.
3. `pnpm run build:cdp-launcher` — builds `waybridge` for your target triple.
4. `node scripts/run-tauri-dev.js` — starts `tauri dev`, which runs `pnpm run dev` (Vite on port
   1420) and then compiles the Rust backend.

Skip the chain if you only changed Rust: `cargo run --manifest-path src-tauri/Cargo.toml` will not
build the sidecars, so CDP launch and game simulation will fail until you build them once.

`pnpm dev` alone gives you a browser tab on `http://localhost:1420` with no Tauri runtime: the
interface renders, but every `invoke()` fails. It is useful for styling, not for testing behavior.

## 5. Build release artifacts

```bash
pnpm tauri:build
```

Same chain as dev, then `tauri build` (`beforeBuildCommand` runs `pnpm run build`, i.e. `vue-tsc`
followed by `vite build` — a type error stops the build).

Because the workspace root is the repository root, everything lands under `target/release/`:

| Platform | Output |
| --- | --- |
| Windows | `target/release/auto-quest-complete-discord.exe`, `target/release/bundle/nsis/*-setup.exe` |
| macOS | `target/release/bundle/macos/*.app`, `target/release/bundle/dmg/*.dmg` |
| Linux | `target/release/bundle/deb/*.deb`, `target/release/bundle/appimage/*.AppImage` |

Add `--bundles deb,appimage` (Linux) or `--no-sign` (macOS) to pick formats or skip signing
attempts; `src-tauri/tauri.conf.json` sets `"targets": "all"` by default.

### Convenience scripts

| Command | What it does |
| --- | --- |
| `pwsh ./build-windows.ps1` | Builds the runner, builds the app, then assembles a portable folder (`auto-quest-complete-discord.exe` + `waybridge.exe`) and zips it. `-SkipRunnerBuild` and `-SkipTauriBuild` skip either stage |
| `./build-macos.sh` | Builds both sidecars, verifies the bundle with `scripts/verify-macos-bundle.sh`, runs `pnpm tauri build --no-sign`, archives symbols, and audits packaged identity for platform `macos`. `--skip-runner-build`, `--skip-tauri-build` |
| `./build-ubuntu.sh` | Checks apt dependencies, builds both sidecars, runs `pnpm tauri build --bundles deb,appimage`, then lists the artifacts found in `target/release/bundle`. `--install-deps`, `--skip-runner-build`, `--skip-tauri-build` |

`build-ubuntu.sh` fails fast if `node_modules` is missing — run `pnpm install` first.

## 6. Checks CI runs, in the order that fails fastest

Run these before pushing. CI is the gate of record, but every command below is the same one CI uses,
so a local pass saves a round trip.

| Command | Gate | Notes |
| --- | --- | --- |
| `pnpm run build` | TypeScript | `vue-tsc && vite build`. `vue-tsc` is the type gate — there is no separate `typecheck` script |
| `pnpm test` | Frontend unit tests | `vitest run src` |
| `pnpm run i18n:check` | Locales | Validates all 16 locale files against `src/locales/en.json`. Fails on missing/extra keys, placeholder mismatch, empty strings, `TODO`/`[[` markers, non-string leaves. Translations identical to English only **warn** |
| `pnpm run sync-version` | Version | Also validates that each file was actually patched |
| `pnpm run check:runtime-identity`, `pnpm run test:identity-audit`, `pnpm run test:packaged-identity` | Runtime identity | Policy check plus audit-tool tests |
| `pnpm run check:cdp-core-deps` | Architecture | `crates/discord-cdp-launch-core` must not depend on Tauri |
| `cargo fmt --package discord-cdp-launch-core --package discord-cdp-launcher -- --check` | Rust format | Only the shared crates are formatted-checked |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Rust format | The Tauri backend |
| `cargo clippy --workspace --all-targets --all-features -- -D unused -D clippy::correctness -D clippy::suspicious` | Rust lint | `unused`, correctness and suspicious are hard errors. Style/pedantic stay warnings because of a known backlog — do not "fix" them by adding `-D clippy::style` |
| `cargo test --workspace --no-fail-fast -- --test-threads=1` | Rust tests | Single-threaded on purpose: several tests mutate process environment or need a free loopback port |

Note that `cargo fmt` only covers three crates in CI. If `rustfmt` reformats a file you did not
touch, that is the diff CI will show you; paste `rustfmt` output rather than guessing at it.

## 7. Version numbers

- `public/version.txt` is the single source of truth.
- `node scripts/sync-version.js` propagates it to `package.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json`. It refuses to exit 0 if a patch did not apply.
- `Cargo.lock` has to be edited by hand on a bump (the workspace members are listed in it) because
  CI uses `--locked`, which forbids dependency drift. If you change a dependency version in any
  `Cargo.toml`, regenerate `Cargo.lock` locally with `cargo update -p <crate>` — you cannot land a
  bump that leaves the lock stale.
- `public/version-desc.txt` is the body of the GitHub Release; `build-release.yml` passes it as
  `body_path`.

## 8. Which CI workflow does what

| Workflow | Trigger | Result |
| --- | --- | --- |
| `verify.yml` | Every push to `main`, plus manual dispatch | All the gates in section 6 on one Linux runner, no bundling. Fastest feedback |
| `ci.yml` | Pull requests to `main`/`develop`, pushes to `develop` | The same gates across Windows, macOS arm64, Ubuntu 22.04 |
| `build-release.yml` | A push that changes `public/version.txt`, plus manual dispatch | Builds and publishes Windows x64 `.exe` + portable `.zip`, audits packaged identity, opens the draft release |

Release publishing is **Windows-only right now**. The macOS and Linux jobs are still in
`build-release.yml`, commented out behind `TEMP` markers, because the Apple Silicon bundle is the
slowest job and the Linux job adds headless GUI smoke tests. Nothing about the source tree changed —
if you need a macOS or Linux build today, this page is the instructions.

## 9. Build failures you will actually hit

| Symptom | Cause | Fix |
| --- | --- | --- |
| Bundling fails mentioning `binaries/waybridge` | The sidecar was not built for your target triple | `pnpm run build:cdp-launcher` (or `pnpm tauri:build`, which runs it first) |
| `pnpm: Command out of date` / resolution differences | Wrong pnpm version | `corepack enable`, then reinstall |
| A `scripts/*.sh` step fails with permission denied in CI | The executable bit was lost | `git update-index --chmod=+x <path>` and commit that mode change |
| CI says the lock file needs updating | `Cargo.lock` is stale after a `Cargo.toml` change, and release builds use `--locked` | Regenerate `Cargo.lock` on the machine that can run cargo |
| `vue-tsc` errors in `pnpm tauri:build` | Type gate | Fix the type; do not disable `beforeBuildCommand` |
| `cargo test` hangs or flakes on ports | Tests were run in parallel | Use the documented `-- --test-threads=1` |
| Rust build is very slow | `opt-level = 3` with thin LTO across the graph | Expected; `--profile` tricks are not used by CI, so don't compare timings |
| Linux app opens a blank window, especially in a VM | WebKitGTK accelerated compositing | Launch with `WEBKIT_DISABLE_COMPOSITING_MODE=1`; the app already falls back for known cases |
| AppImage exits with `dlopen(): error loading libfuse.so.2` | Distribution ships FUSE 3 only | Install `libfuse2`, or use the `.deb` |
| macOS refuses to open your own `.app` | Unsigned build, quarantined | `xattr -cr "/Applications/Auto Quest Complete Discord.app"` |

## 10. Legal and practical notes

- The project is GPL-3.0-only. Any derivative you distribute must stay under GPL-3.0 with source
  available; a private build for your own machine carries no such obligation. Upstream
  `discord-quest-helper` (MIT) is credited in the README.
- Automating Discord quests can violate Discord's Terms of Service and put your account at risk.
  Test against an account you are prepared to lose, never against one you depend on.
- Do not commit `target/`, `dist/`, or `node_modules/`; they are already ignored.
