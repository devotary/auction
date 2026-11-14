# Auction Ledger Scanner

Auction Ledger Scanner is a small, read-only addon for WoW Forever 1.60.1 (`Interface: 16001`). It requests an Auction House replicate list, stores compact listing rows in `AuctionLedgerDB`, and lets the desktop publisher turn those rows into a sanitized price and supply snapshot.

## Install and scan

Copy the `AuctionLedger` folder from this directory into the Forever client’s `Interface/AddOns/` folder. This installs a new addon folder; it does not replace or edit your existing addons. No account IDs or account-folder paths are needed in addon settings.

Open the Auction House, then enter:

```text
/ald scan
```

The scanner requests one list. Keep the Auction House open and leave other auction scanners idle while it runs. The first response can take several minutes; `/ald status` shows progress. When rows settle, use `/reload` so WoW writes SavedVariables, then run the desktop publisher described in [PUBLISHER.md](../PUBLISHER.md).

Use `/ald scan neutral` to label the scan as Neutral. `/ald cancel` stops the current capture without saving it. `/ald status` reports progress or the last attempt. Closing the Auction House also stops the capture without replacing saved scans.

The API may throttle successful full-list requests for about 15 minutes. The addon applies its own 15-minute cooldown after a response, but it cannot see other characters’ or addons’ server-side requests. If no response arrives, wait and try again later; the addon gives up after 15 minutes without a response.

## What gets saved

Saved data keeps at most three scans and roughly 40 MiB by estimate. One capture stops above 250,000 rows or an estimated 24 MiB. A newer successful scan can evict the oldest saved scan, so publish after each scan and before taking more than three. Cancelled or failed captures keep earlier scans.

Each compact row stores a variant index, stack count, buyout, minimum bid, current bid, and time-left band. Variant metadata preserves item differences such as enchantments, gems, suffixes, difficulty, and bonuses while removing per-instance IDs and viewer-only level or specialization fields. The scanner does not retain seller or bidder names.

The publisher converts buyout listings into minimum and weighted-median unit prices, listed quantity, listing count, variant, and timestamp. Bid-only rows do not become prices. Raw bids and time-left bands are not included in the published market data.

Every scan is marked **partial**. A quiet list for 15 seconds is a settling heuristic, not proof that the server sent every auction. Rows that remain unresolved after 90 seconds are omitted. Commodity coverage is unverified; sales and completed transactions are not recorded. See Blizzard’s [Forever Auction House API reference](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/AuctionHouseDocumentation.lua) for the replicate API signatures.

This addon has not yet had a first scan verified in the actual Forever client. Treat the first run as an in-game check: confirm `/ald status` reports saved rows, reload, and make sure the publisher imports the new snapshot before relying on its trend history.
