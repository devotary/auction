# The Auction Ledger

**[Open the ledger](https://devotary.github.io/auction/)**

The Auction Ledger turns World of Warcraft Auction House scans into a compact market history. Compare minimum unit prices, price changes, listed supply, a fixed-basket market index, and possible resale spreads. These are observations from addon data, not confirmed sales.

## Publish a scan

Use the included [Auction Ledger Scanner](addon/README.md): open the Auction House and enter `/ald scan`. When it reports saved rows, use `/reload` or log out so WoW writes the file. The publisher also supports Auctionator and Auctioneer exports. Launch **Auction Ledger Publisher** from the application menu, or run:

```sh
cd /path/to/auction
./publish-auctions
```

The publisher reads the addon files locally. Node.js safely decodes their saved data and merges sanitized history. Rust calculates the reports. The app pushes only generated market data through the repository deploy key. Your original addon files and credentials stay on your PC.

The site is static GitHub Pages. It needs no running server, database, port forwarding, or Tailscale. Once the push and Pages deployment finish, your PC can be off.

See [PUBLISHER.md](PUBLISHER.md) for setup, private configuration, preview mode, backups, and recovery steps.

## What the site shows

The dashboard loads one market and one period at a time, including on mobile. Choose 24 hours, 7 days, 30 days, or all history. Search, filter, and sort item rows; open an item to view its price history and use the lightweight trade calculator. Watchlists stay in that browser and are not published.

The app prepares trend metrics before publishing. The browser draws the charts, filters and sorts report rows, and calculates only the amounts you enter in the trade calculator. The full sanitized archive downloads only when you request a library export.

The interface uses Classic WoW artwork throughout: stone and parchment surfaces, metal window frames, red and stone buttons, native tabs, checkboxes, scrollbars, and coin icons. Frames keep their corners and repeat their edges as the layout changes size.

## Read prices with care

- **Unit buyout** is the cheapest observed stack price divided by its stack size.
- **Price change** compares the latest price with a reference scan at or before the selected lookback. If no scan reaches that date, the earliest available scan is used.
- **Market index** compares a fixed, equal-weight basket of items present at both endpoints. It is normalized to 100 at the reference scan; it is not total market value.
- **Listed supply** counts observed buyout units. Missing counts remain unknown. Auctionator daily maximum availability is not current supply.
- **Potential spread** compares the current minimum with 95% of the observed median. It is hypothetical and does not account for fillable depth, lost deposits, or a guaranteed sale.

An auction that disappears might have sold, expired, or been cancelled. The Ledger cannot identify confirmed sales or realized profit from these scans.

Realm, faction, and source remain separate. Auctionator cache prices can be older than their capture time; daily lows are separate day buckets. The publisher reports an empty Auctioneer scan and skips it rather than creating prices or supply that were not observed.

## Development

The main tree contains `index.html`, `app.js`, `styles.css`, `trade.js`, `data/`, `assets/`, and `tests/`. Publisher code lives in `publisher/src/`; safe addon decoders and item metadata live in `publisher/ingest/`.

```sh
cargo build --release --locked --manifest-path publisher/Cargo.toml
cargo test --locked --manifest-path publisher/Cargo.toml
node --test tests/*.test.mjs
node scripts/build.mjs
```

The optional build writes a preview to `dist/`; GitHub Pages serves the repository root. See [assets/ATTRIBUTION.md](assets/ATTRIBUTION.md) for image and format sources.
