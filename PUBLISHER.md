# Daily Auction Ledger publisher

The desktop app reads only Auction Ledger Scanner SavedVariables, preserves sanitized Auction Ledger history, calculates trends locally in Rust, and pushes generated market JSON to GitHub Pages. No web server, database service, Tailscale or port forwarding is needed. Your PC can be off once the push completes.

## Daily use

From the repository directory, run:

```sh
cd /path/to/auction
./publish-auctions
```

1. Finish the Auction Ledger scans.
2. Use `/reload` or log out so WoW writes SavedVariables.
3. Run the publisher. It reports skipped files and whether anything changed.
4. Open https://devotary.github.io/auction/ after GitHub Pages finishes deploying.

For cross-house comparisons, scan the faction AH with `/ald scan faction` and the Neutral AH with `/ald scan neutral`, saving and reloading after each. The scanner reads only the currently open house and the full-scan cooldown still applies between requests. Run **Auction Ledger Flips** or `./publish-flips` to publish. Both launchers use this same pipeline and update the **Flips** tab as well as normal trends.

Configure the `AuctionLedger.lua` SavedVariables path in ignored `.local/publisher/config.json`. The scanner's file is optional until WoW first saves it. Its saved faction and timestamps identify each observation. Legacy input entries for other addons are skipped before their files are read.

For a standard `WTF/Account/<account>/SavedVariables/AuctionLedger.lua` path, the publisher also discovers saved Ledger files under the other accounts in that same `Account` directory on every run. Changing WoW accounts needs no configuration change. Save the scan and `/reload` or log out on the account that scanned before publishing. The app reports how many scanner files it read; account and character names are not included in generated market data. Duplicate observations are merged, and realms and factions stay separate. For another game installation or a nonstandard layout, add its `AuctionLedger.lua` path as another input.

The included [scanner addon](addon/README.md) captures observed listing quantities and prices using the Forever 1.60.1 replicate API. Auctionator cache, daily lows, Auctioneer exports and CSV/JSON inputs do not feed publishing. No supply counts or sales are invented. This does not change the addon's in-game Auctionator tooltip integration.

## Preview and configuration

```sh
./publish-auctions --preview   # reads/calculates locally; no Git or network changes
./publish-auctions --help
```

Preview updates the private local history and produces JSON under `.local/publisher/preview/data/`. It does not change addon files, commit, or push.

Requirements: Git, OpenSSH, Node.js 24+, and Rust/Cargo 1.89+ to compile. Daily runs use the compiled Rust binary and the existing Node decoder; there are no npm dependencies. Rust handles trend/index/median/spread calculation, report generation and Git orchestration. Node uses the tested literal Lua decoder. Neither executes Lua.

The launcher checks for Rust changes and rebuilds when needed. To build explicitly:

```sh
cargo build --release --locked --manifest-path publisher/Cargo.toml
```

Create `.local/publisher/config.json` with absolute paths for your installation.

```json
{
  "repository": "git@github.com:devotary/auction.git",
  "deployKey": "/absolute/path/to/private-deploy-key",
  "flipFees": {"factionPercent": 5, "neutralPercent": 15},
  "inputs": [
    {"path": "/absolute/path/to/AuctionLedger.lua", "optional": true}
  ]
}
```

Keep `.local/` private (directory mode 700; config/key mode 600). The deploy key must have write permission on this repository. The publisher uses strict SSH host checking; add GitHub's verified host key to known_hosts when setting up a different machine. Private key contents are never read by the importer, embedded in JSON, copied to the checkout or committed. SSH uses the existing key directly.

`flipFees` is optional and defaults to the Classic assumptions shown above. Set the whole-number sale percentages to match the current game rules; values must be from 0 to 100. The defaults have not been verified against a completed sale on the current Forever build. Changing fees rebuilds the flip report even when the scans are unchanged. `--build` uses the defaults; normal publishing and `--preview` use the private configuration.

## What is published

- `data/trends.json`: small manifest with market/source, snapshot metadata and paths to prepared reports.
- `data/reports/<sha256>.json`: precomputed 24h, 7d, 30d and all-history reports. Identical period results share a file.
- The manifest's `flips` path points to another content-addressed report in `data/reports/`, containing paired scanner timestamps, configured fees and positive cross-house margins.
- `data/history.json` and `data/history/<sha256>.json`: sanitized snapshot archive. One file per snapshot avoids an ever-growing single Git file.

Pages loads one market/period report at a time. It draws charts, filters/sorts displayed rows and keeps device-local watchlists. The optional interactive trade calculator performs only its small user-entered calculation in the browser. It does not recalculate scan analytics or download the full archive on startup. The scan library is read-only. The local publisher handles updates, so there is no website JSON uploader or exporter. Back up `.local/publisher/history.json` on the PC.

Metrics use every relevant observation. Item charts show at most 32 evenly spaced measured points; market charts show at most 365. The site labels sampling when applicable. These limits keep long histories practical on mobile. Complete observations remain in the archive. A report over 90 MiB is rejected rather than pushed as an oversized Git file.

All prices are copper. Realm and faction remain separate. Baseline, fixed-basket index, observed medians, price swings, availability and hypothetical 5% resale spreads follow the documented [market definitions](README.md#reading-the-ledger). No claim of confirmed sales or realized net gold is derived from scan disappearance.

Cross-house comparisons use only the latest Auction Ledger Scanner snapshot per realm and house. Auctionator caches, daily lows, Auctioneer data and unknown house labels are excluded from flips. Item keys and item IDs must match exactly; variants are not collapsed. Both routes are tested, with `floor(destination unit price × (100 − destination fee) / 100) − buy unit price` as the conservative copper margin. Only positive margins are published. Total listed supply is never multiplied by the cheapest price to invent an available trade size. Both scan times and partial coverage are retained. The browser filters by age at viewing time and defaults to 24 hours; it does not calculate the cross-house margins. Click **Return on cost** to toggle high/low order, or use **Sort by** on any screen size. **Max return (%)** optionally hides comparisons above a chosen percentage; leave it empty for no limit. This filters the display without changing scan history. It cannot establish whether an asking price is realistic or an item will sell.

Only aggregate market fields are exported. Raw Lua, seller/character/account information, addon settings, local paths and credentials stay off the site. Published market data is public. Source reads are checked for concurrent changes and capped at 64 MiB per input. A malformed Auction Ledger file aborts preparation without replacing saved history. An absent optional scanner file, or one with no saved buyout observations, is skipped with a message. A file named `AuctionLedger.lua` must contain Auction Ledger SavedVariables; renaming another export does not make it acceptable.

## History, retries and recovery

`.local/publisher/history.json` is the sanitized Auction Ledger archive. Back it up. A fresh setup can restore Auction Ledger history from the remote snapshot archive. Published remote snapshots are merged before local history and current scans; a local correction at the same identity wins. Non-Auction Ledger history is excluded from this active archive and new reports, so older cache markets cannot reappear on the next run. Previously published immutable files remain available for existing links.

Publishing uses its own checkout in `.local/publisher/checkout/`. It fetches and fast-forwards `main`, stages only generated history/report paths, and pushes normally. It never switches your development branch or force-pushes. A process lock prevents overlapping runs. Repeated unchanged runs do not create a commit. If a push fails, history and the local commit remain available; rerun to retry.

If the dedicated checkout is dirty or diverged, the app stops. Preserve it for inspection by moving **only** `.local/publisher/checkout/` aside, then rerun; it creates a fresh checkout and reapplies the retained `history.json`. Do not remove your history/config/key. Do not put manual work in the app's checkout. Immutable reports are retained so existing browser tabs can finish loading; monitor repository/Pages storage as history grows.

The earlier SQLite experiment remains on the `local-sqlite` branch for comparison. The publisher workflow uses static Pages and requires no running local services.

## Checks

Development checks also require Lua 5.1 (`lua5.1`) to simulate the addon's WoW event loop. The game already provides Lua; the desktop publisher does not require a separate Lua interpreter.

```sh
cargo build --release --locked --manifest-path publisher/Cargo.toml
cargo test --locked --manifest-path publisher/Cargo.toml
node --test tests/*.test.mjs
node scripts/build.mjs
```

Checks cover parser safety, Auction Ledger-only inputs and history, read-only imports, atomic failure, remote archive/hash validation, Rust/JavaScript calculation parity, stable reports, a complete push to a temporary Git repository, and a second unchanged run. Publisher integration checks require the release binary; build it first.
