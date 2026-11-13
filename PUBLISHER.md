# Daily Auction Ledger publisher

The desktop app reads Auctionator and Auctioneer SavedVariables, preserves sanitized history, calculates trends locally in Rust, and pushes only generated market JSON to GitHub Pages. No web server, database service, Tailscale or port forwarding is needed. Your PC can be off once the push completes.

## Daily use

From the repository directory, run:

```sh
cd /path/to/auction
./publish-auctions
```

1. Finish the addon scans.
2. Use `/reload` or log out so WoW writes SavedVariables.
3. Run the publisher. It reports skipped files and whether anything changed.
4. Open https://devotary.github.io/auction/ after GitHub Pages finishes deploying.

Configure SavedVariables paths, the fallback faction for Auctionator markets, and the game timezone in ignored `.local/publisher/config.json`. The scanner and Auctioneer use their explicitly saved faction and timestamps.

At setup, Auctionator provided valid prices and daily history. The saved Auctioneer file contained no buyout listings; it is skipped with a warning until a complete scan is saved. No supply counts or sales are invented.

## Preview and configuration

```sh
./publish-auctions --preview   # reads/calculates locally; no Git or network changes
./publish-auctions --help
```

Preview updates the private local history and produces JSON under `.local/publisher/preview/data/`. It does not change addon files, commit, or push.

Requirements: Git, OpenSSH, Node.js 24+, and Rust/Cargo 1.89+ to compile. Daily runs use the compiled Rust binary and the existing Node decoder; there are no npm dependencies. Rust handles trend/index/median/spread calculation, report generation and Git orchestration. Node reuses the tested literal Lua/CBOR/CSV decoder. Neither executes Lua.

The launcher checks for Rust changes and rebuilds when needed. To build explicitly:

```sh
cargo build --release --locked --manifest-path publisher/Cargo.toml
```

For another installation, create this private config (absolute paths):

```json
{
  "repository": "git@github.com:devotary/auction.git",
  "deployKey": "/absolute/path/to/private-deploy-key",
  "timezone": "Etc/UTC",
  "inputs": [
    {"path": "/absolute/path/to/Auctionator.lua", "faction": "Alliance"},
    {"path": "/absolute/path/to/Auc-ScanData.lua"}
  ]
}
```

Keep `.local/` private (directory mode 700; config/key mode 600). The deploy key must have write permission on this repository. The publisher uses strict SSH host checking; add GitHub's verified host key to known_hosts when setting up a different machine. Private key contents are never read by the importer, embedded in JSON, copied to the checkout or committed. SSH uses the existing key directly.

## What is published

- `data/trends.json`: small manifest with market/source, snapshot metadata and paths to prepared reports.
- `data/reports/<sha256>.json`: precomputed 24h, 7d, 30d and all-history reports. Identical period results share a file.
- `data/history.json` and `data/history/<sha256>.json`: sanitized snapshot archive. One file per snapshot avoids an ever-growing single Git file.

Pages loads one market/period report at a time. It draws charts, filters/sorts displayed rows and keeps device-local watchlists. The optional interactive trade calculator performs only its small user-entered calculation in the browser. It does not recalculate scan analytics or download the full archive on startup. The library's JSON export downloads the complete archive only when requested.

Metrics use every relevant observation. Item charts show at most 32 evenly spaced measured points; market charts show at most 365. The site labels sampling when applicable. These limits keep long histories practical on mobile. Complete observations remain in the archive. A report over 90 MiB is rejected rather than pushed as an oversized Git file.

All prices are copper. Realm, faction and source remain separate. Baseline, fixed-basket index, observed medians, price swings, availability and hypothetical 5% resale spreads follow the documented [market definitions](README.md#reading-the-ledger). No claim of confirmed sales or realized net gold is derived from scan disappearance. Cached prices can predate capture time; daily lows are separate day buckets.

Only aggregate market fields are exported. Raw Lua, seller/character/account information, addon settings, local paths and credentials stay off the site. Published market data is public. Source reads are checked for concurrent changes and capped at 64 MiB per input. A malformed file aborts preparation without replacing saved history; an empty Auctioneer scan is the one explicitly skipped condition. Identical Auctionator cache contents do not create another fake observation just because the file was rewritten.

## History, retries and recovery

`.local/publisher/history.json` is the complete sanitized local archive. Back it up. A fresh setup can restore history from the remote snapshot archive. Published remote snapshots are merged before local history and current scans; a local correction at the same identity wins.

Publishing uses its own checkout in `.local/publisher/checkout/`. It fetches and fast-forwards `main`, stages only generated history/report paths, and pushes normally. It never switches your development branch or force-pushes. A process lock prevents overlapping runs. Repeated unchanged runs do not create a commit. If a push fails, history and the local commit remain available; rerun to retry.

If the dedicated checkout is dirty or diverged, the app stops. Preserve it for inspection by moving **only** `.local/publisher/checkout/` aside, then rerun; it creates a fresh checkout and reapplies the retained `history.json`. Do not remove your history/config/key. Do not put manual work in the app's checkout. Immutable reports are retained so existing browser tabs can finish loading; monitor repository/Pages storage as history grows.

The earlier SQLite experiment remains on the `local-sqlite` branch for comparison. The publisher workflow uses static Pages and requires no running local services.

## Checks

```sh
cargo build --release --locked --manifest-path publisher/Cargo.toml
cargo test --locked --manifest-path publisher/Cargo.toml
node --test tests/*.test.mjs
node scripts/build.mjs
```

Checks cover parser safety, read-only imports, atomic failure, cache deduplication, remote archive/hash validation, Rust/JavaScript calculation parity, stable reports, a complete push to a temporary Git repository, and a second unchanged run. Publisher integration checks require the release binary; build it first.
