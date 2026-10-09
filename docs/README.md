# Documentation

The [repository README](../README.md) explains **what** this app is. The files here explain **how**:
how to use it, how to compile it, and how to read an error when something refuses to work.

All documentation in this repository is written in English. There is no Vietnamese-only doc; the
interface itself is translated into 16 languages, but the code and its documentation are English.

## Which file do you need?

| Document | Read it when | It answers |
| --- | --- | --- |
| [USAGE.md](USAGE.md) | You want to run the app | Install, sign in, connect to Discord, run each quest type, settings, background running, where your data is stored |
| [BUILDING.md](BUILDING.md) | You want your own binary, or you are about to change code | Toolchain prerequisites per OS, what the two sidecar binaries are, every command, where artifacts land, the exact gates CI runs |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Something failed | Every error code the app can show, what each one means in plain language, and what to do about it |
| [cdp-runtime-validation.md](cdp-runtime-validation.md) | You are changing Chrome DevTools Protocol code | How target discovery, verification and cleanup work, why each timeout has its current value, and the validation history behind those choices |
| [desktop-client-provider-migration.md](desktop-client-provider-migration.md) | You are changing Discord/Vesktop discovery or launch | Why client handling sits behind a provider layer instead of one path per channel |
| [discord-cdp-launch-core-migration.md](discord-cdp-launch-core-migration.md) | You are changing the launcher crate | The boundary between `crates/discord-cdp-launch-core` and `src-tauri`, and what must not leak across it |
| [runtime-identity-audit.schema.json](runtime-identity-audit.schema.json) | You are renaming a binary or changing the bundle | The contract CI checks packaged binaries against |
| [runtime-identity-debug-audit.schema.json](runtime-identity-debug-audit.schema.json) | Same, for debug builds | The debug-build variant of that contract |

## Reading order for a new contributor

1. `README.md` — the product, its limits, and the account risk.
2. [USAGE.md](USAGE.md) — you cannot fix what you have never seen working.
3. [BUILDING.md](BUILDING.md) — get `pnpm tauri:dev` running once before reading any code.
4. The architecture block in `README.md`, then open the files it names.
5. [cdp-runtime-validation.md](cdp-runtime-validation.md) **before** touching anything in
   `src-tauri/src/cdp_client.rs`, `src-tauri/src/cdp_quest.rs`, or
   `crates/discord-cdp-launch-core/`. Most of the odd-looking constants in those files exist because
   of a specific documented failure; changing them without that context is how the bugs came back.

## How to read the rest of `docs/`

`cdp-runtime-validation.md` contains dated sections — "Validation record", "PR #NNN review",
"Local validation after the fixes". Those are **history logs**: they record what was tested on a
given day, by which bot reviewer, and with how many tests. They are useful as evidence and as a
record of why a timeout or a cap has its current value. They are not specifications, and the numbers
in them (test counts, sizes, PIDs, review ids) describe the machine and the commit they were taken
from, not your build. When a section starts with a date, treat it as a snapshot.

## If documentation disagrees with the code

The code is right. Open an issue, or fix the doc in a pull request — the doc set is part of the
repository and is reviewed like anything else.
