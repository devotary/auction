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

`/ald` displays the detected house. **Scan current** or `/ald scan` uses that detection. Recognition uses the current interacting auctioneer's NPC identity, including the five Classic neutral auctioneers and the common faction-capital auctioneers. It does not infer the market from the player's faction or a broad map zone. The new recognition paths still need an in-game check on Forever.

For an unknown auctioneer, automatic scanning stays disabled. Choose **Scan Faction AH** (`/ald scan faction`) or **Scan Neutral AH** (`/ald scan neutral`). After a successful saved manual scan, ALD remembers that NPC's house choice across reloads. A later manual scan can correct the choice. If the client does not expose an interacting NPC identity, use the manual buttons each time.

Manual buttons override detection, so choose the one matching the AH you actually opened. Progress and saved messages identify the selected house. The full-scan cooldown applies between houses too.

Save and `/reload` after each house, then run **Auction Ledger Flips** or `./publish-flips`. The existing publisher also updates the comparisons. The website's **Flips** tab shows the direction, both unit prices and the potential margin after the destination sale fee. A scan of only one house produces an explanation of which counterpart is missing, not invented prices.

**Cancel** or `/ald cancel` discards the current capture. `/ald status` reports progress or the last attempt. Closing the Auction House also stops the capture without replacing saved scans.

Updating an already loaded addon requires `/reload`. If a scan is running, finish it or use **Stop and Save** before reloading to keep its rows. Installing the updated files does not interrupt it.

The API may throttle successful full-list requests for about 15 minutes. The addon applies its own 15-minute cooldown after a response, but it cannot see other characters’ or addons’ server-side requests. If no response arrives, wait and try again later; the addon gives up after 15 minutes without a response.

## What gets saved

Saved data keeps at most three scans and roughly 48 MiB by estimate. One capture stops above 250,000 rows or an estimated 24 MiB. Older duplicates of a realm/house are evicted first, preserving the latest other-house scan during repeated scans of one house. The size budget still applies across all realms and houses; publish after each scan. Cancelled or failed captures keep earlier scans.

Each compact row stores a variant index, stack count, buyout, minimum bid, current bid, and time-left band. Variant metadata preserves item differences such as enchantments, gems, suffixes, difficulty, and bonuses while removing per-instance IDs and viewer-only level or specialization fields. The scanner does not retain seller or bidder names.

The publisher converts buyout listings into minimum and weighted-median unit prices, listed quantity, listing count, variant, and timestamp. Bid-only rows do not become prices. Raw bids and time-left bands are not included in the published market data.

Every scan is marked **partial**. A quiet list for 15 seconds is a settling heuristic, not proof that the server sent every auction. After 90 seconds with no newly captured rows or growth in the result list, unresolved rows are omitted and the captured rows are saved. Cache notifications alone do not reset this timer. Commodity coverage is unverified; sales and completed transactions are not recorded. See Blizzard’s [Forever Auction House API reference](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/AuctionHouseDocumentation.lua) for the replicate API signatures.

## Item tooltips

When hovering an observed item, ALD adds **Faction / unit** and **Neutral / unit** prices to the same item tooltip used by Auctionator. Each line identifies ALD and shows its scan age and capture coverage. The source is the latest retained ALD scan for that house on the current realm; item variants must match exactly. Unobserved variants, other realms and the opposing faction's scans are excluded.

Prices update as soon as a scan is saved, including **Stop and Save**. No publisher run or reload is needed for that in-game update. Reloading is still needed to write scans for desktop publishing. After login or reload, saved rows are indexed in small frame-budgeted batches before their prices are shown.

These are separate ALD lines alongside Auctionator's existing price. Auctionator's database and own price line are not overwritten. The integration uses Blizzard's [native item-tooltip callbacks](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_SharedXMLGame/Tooltip/TooltipDataHandler.lua), works without Auctionator too, and stores no tooltip or inventory history.

NPC recognition uses Classic reference identities: neutral Beardo (8661), Grizzlin (9857), Kresky (9858), Graves (15677), and O'reely (15681), plus the common auctioneers in each faction capital. See the [auctioneer location reference](https://warcraft.wiki.gg/wiki/Auctioneer). NPC identity comes from the interacting `npc` unit's [UnitGUID](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/UnitDocumentation.lua); full GUIDs are never saved. Manual choices store only the NPC type ID and house label.

After updating, verify each house in game: confirm the detected label and saved rows, hover an observed item to check the ALD price lines, reload, and make sure the publisher imports both snapshots. Automated tests cover recognition, remembered choices, tooltip updates and the scan/import/report pipeline; the new client-facing behavior still needs this in-game check.
