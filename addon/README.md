# Auction Ledger Scanner

Auction Ledger Scanner is a small, read-only addon for WoW Forever 1.60.1 (`Interface: 16001`). It requests an Auction House replicate list, stores compact listing rows in `AuctionLedgerDB`, and lets the desktop publisher turn those rows into a sanitized price and supply snapshot.

## Install and scan

Copy the `AuctionLedger` folder from this directory into the Forever client’s `Interface/AddOns/` folder. This installs a new addon folder; it does not replace or edit your existing addons. No account IDs or account-folder paths are needed in addon settings.

Open the Auction House, then enter:

```text
/ald scan
```

The scanner requests one list. Keep the Auction House open and leave other auction scanners idle while it runs. The first response can take several minutes; `/ald status` shows progress. When rows settle, use `/reload` so WoW writes SavedVariables, then run the desktop publisher described in [PUBLISHER.md](../PUBLISHER.md).

Click **Stop and Save** or enter `/ald save` to keep the rows already captured without waiting for the remaining items. The result is a saved partial scan with captured, received and unresolved counts. Then `/reload` and run the publisher as usual. The button is enabled once at least one row is captured; an empty `/ald save` leaves the scan running.

Use **Scan Faction AH** (`/ald scan faction`, or the original `/ald scan`) at your faction's Auction House. Use **Scan Neutral AH** (`/ald scan neutral`) at the Neutral Auction House. The labels are explicit selections: the API reads only the currently open AH, so choose the matching button. Progress and saved messages identify the selected house. The full-scan cooldown applies between houses too.

Save and `/reload` after each house, then run **Auction Ledger Flips** or `./publish-flips`. The existing publisher also updates the comparisons. The website's **Flips** tab shows the direction, both unit prices and the potential margin after the destination sale fee. A scan of only one house produces an explanation of which counterpart is missing, not invented prices.

**Cancel** or `/ald cancel` discards the current capture. `/ald status` reports progress or the last attempt. Closing the Auction House also stops the capture without replacing saved scans.

Updating an already loaded addon requires `/reload`. The old version cannot save the active scan early, so finish that scan before reloading if you want to keep it. Installing the updated files does not interrupt it.

The API may throttle successful full-list requests for about 15 minutes. The addon applies its own 15-minute cooldown after a response, but it cannot see other characters’ or addons’ server-side requests. If no response arrives, wait and try again later; the addon gives up after 15 minutes without a response.

## What gets saved

Saved data keeps at most three scans and roughly 48 MiB by estimate. One capture stops above 250,000 rows or an estimated 24 MiB. Older duplicates of a realm/house are evicted first, preserving the latest other-house scan during repeated scans of one house. The size budget still applies across all realms and houses; publish after each scan. Cancelled or failed captures keep earlier scans.

Each compact row stores a variant index, stack count, buyout, minimum bid, current bid, and time-left band. Variant metadata preserves item differences such as enchantments, gems, suffixes, difficulty, and bonuses while removing per-instance IDs and viewer-only level or specialization fields. The scanner does not retain seller or bidder names.

The publisher converts buyout listings into minimum and weighted-median unit prices, listed quantity, listing count, variant, and timestamp. Bid-only rows do not become prices. Raw bids and time-left bands are not included in the published market data.

Every scan is marked **partial**. A quiet list for 15 seconds is a settling heuristic, not proof that the server sent every auction. After 90 seconds with no newly captured rows or growth in the result list, unresolved rows are omitted and the captured rows are saved. Cache notifications alone do not reset this timer. Commodity coverage is unverified; sales and completed transactions are not recorded. See Blizzard’s [Forever Auction House API reference](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/AuctionHouseDocumentation.lua) for the replicate API signatures.

After updating, verify each house in game: confirm `/ald status` reports the intended house and saved rows, reload, and make sure the publisher imports both snapshots. The scan/import/report pipeline is covered by automated Lua and publisher tests; the new buttons still need this in-game check.
