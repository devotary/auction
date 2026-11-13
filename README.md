# The Auction Ledger

**[Open the website →](https://devotary.github.io/auction/)**

A personal World of Warcraft Auction House observatory: price history, biggest price swings, searchable items, listed supply, watchlists, and a resale calculator with configurable AH cut and expenses. Warcraft artwork, brass details, gold/silver/copper prices, responsive desktop and mobile layouts.

## Hosting

GitHub Pages uses **Deploy from a branch → main → / (root)**. Site files live at the root; `.nojekyll` keeps deployment buildless. Pushes update Pages automatically. The check workflow tests code without changing Pages settings.

No backend, API key, package installation, or runtime JavaScript dependencies are required.

## Daily updates

1. Complete your scan, then `/reload` or log out so WoW writes SavedVariables.
2. Open **Import scans** and choose `Auc-ScanData.lua` or `Auctionator.lua` from `WTF/Account/…/SavedVariables/`. Supply fallback faction and capture time where missing.
3. Imports remain in that browser and are deduplicated. The scan library lets you remove local snapshots and export backups.
4. To publish across devices, choose **Scan library → Export ledger JSON**, then **Publish exported scans**. Upload `scans.json` into the repo’s `data/` directory and commit. Only aggregated prices are exported. Published Pages data is public.

Or import from a terminal:

```sh
node scripts/import-scan.mjs '/path/to/Auc-ScanData.lua'
node scripts/import-scan.mjs '/path/to/Auctionator.lua' --faction Alliance
git add data/scans.json
git commit -m 'Update Auction House observations'
git push
```

The script reads without changing source files and atomically replaces only `data/scans.json`. It does not push automatically. File modification time is the default cache capture time; use `--timestamp` to override it. `--realm` and `--faction` fill missing CSV metadata.

## Supported inputs

| Input | Imported observations | Limits |
| --- | --- | --- |
| Auctioneer `Auc-ScanData.lua` | Unpacked images and literal Lua ropes; v1.3 nesting and v1.4 `Realm_Faction` keys | Bid-only, unseen, filtered and expired listings excluded. Valid nonempty scan required. |
| Auctionator `Auctionator.lua` | Table records and CBOR db8/realm2; last cached minimum and modern daily low history | Cache capture time is supplied by you; per-item prices can be older. Daily lows form a separate source. |
| JSON | Snapshot, snapshot array, or `{version:1,snapshots:[…]}` | Validated and sanitized. |
| CSV | Download the template in Import scans | Prices are integer copper; ambiguous gold columns are rejected. |

CSV aggregate columns: `itemId,name,minBuyout,quantity,listings,realm,faction,timestamp,source`. Only `itemId` and `minBuyout` are required when realm/faction/time are supplied in the dialog. Unknown quantities stay blank. `Price (copper)` and `priceCopper` alias `minBuyout`.

For listing CSV rows, use `itemId,buyout,count`: whole-stack buyout in copper and stack size. They are aggregated into minimum unit buyout, weighted median unit buyout, listed units and listing count. Variant `key`, `category`, and `icon` are optional.

Limits: 64 MiB/file, 30 files/import, 100,000 item types/snapshot. A worker parses uploads. IndexedDB stores history; localStorage stores watchlists. Export regularly: clearing browser storage removes local history.

## Reading the ledger

- **Unit buyout:** cheapest observed stack buyout divided by stack quantity, rounded to copper.
- **Change:** latest price vs nearest scan at/before the lookback, falling back to earliest history if shorter. Exact reference date appears below the chart.
- **Market index:** a fixed, equal-weight basket present at both endpoints, normalized to 100 at reference. Intermediate scans missing any basket item are omitted and counted in the caption. Lines connect measured observations. It is not total market value.
- **Listed supply:** observed buyout units. Unknown values stay unknown. Auctionator daily maximum availability is not current supply.
- **Potential spread:** median observed minimum buyout × 95% − current minimum, per unit. Calculator exposes buy/sell prices, quantity, cut and nonrefundable costs. Neither indicates guaranteed profit or fillable depth.
- **Daily lows:** Auctionator `l[day]`, falling back to `h[day]`; days measured from local midnight January 1, 2020. Import in the game's time zone to preserve boundaries. These are day buckets, not exact scan times.
- **Sales/realized profit:** not claimed. Disappearing auctions could have sold, expired or been cancelled. Confirmed sales and net gold require transactions.

Realm, faction and source stay separate. Auctionator cache/daily observations use separate sources to preserve measurement differences. Basic item metadata names most Classic items; unfamiliar items retain an ID/Wowhead link. Auctioneer supplies item names for new items.

## Initial data and privacy

Seeded with sanitized Auctionator data captured November 13, 2026. The first saved Auctioneer v1.4 file was incomplete with zero listings, so no Auctioneer prices or supply were fabricated. Sample data is illustrative and excluded from real exports.

Seller names, character details, account identifiers, shopping lists and addon settings are excluded from the schema. Original game files remain unchanged; raw SavedVariables are not committed. See [asset/format sources](assets/ATTRIBUTION.md).

## Development

```sh
node --test tests/*.test.mjs
node scripts/build.mjs
python -m http.server 4173 --bind 127.0.0.1
```

Visit `http://127.0.0.1:4173/`. Optional build copies public site inputs into `dist/`; Pages uses root directly. No `npm install`. If a sandbox blocks test subprocesses, run `node tests/data.test.mjs` directly.

Tests cover unsafe Lua rejection, CBOR boundaries, Auctioneer formats/flags, safe exports, deduplication, CSV quoting, stack conversion, source separation, fixed-basket trends and resale arithmetic. Browser checks cover watchlists, calculator, worker imports, persistence, export and responsive layout.
