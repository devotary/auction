# Auction Ledger Scanner

Auction Ledger Scanner is a small, read-only addon for WoW Forever 1.60.1 (`Interface: 16001`). It requests an Auction House replicate list, stores compact listing rows in `AuctionLedgerDB`, and lets the desktop publisher turn those rows into a sanitized price and supply snapshot.

## Install and scan

Copy the `AuctionLedger` folder from this directory into the Forever client’s `Interface/AddOns/` folder. This installs a new addon folder; it does not replace or edit your existing addons. No account IDs or account-folder paths are needed in addon settings.

Open the Auction House and click **Scan** in its bottom-right tab strip to open the ALD menu. The menu contains **Scan current**, Faction/Neutral selection, **Stop and Save**, and **Cancel**. You can also open it with `/ald`, or start a recognized house directly with:

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

Saved data keeps at most three scans and roughly 56 MiB by a conservative storage estimate. One capture stops above 250,000 rows or an estimated 48 MiB. These estimates include headroom and can be much larger than the file WoW writes. If a row, storage or capture-time budget is reached, ALD saves any captured rows as a partial scan instead of discarding them. The saved message includes the stop reason. Older duplicates of a realm/house are evicted first, preserving the latest other-house scan during repeated scans of one house. The total size budget still applies across all realms and houses; publish after each scan. Cancelled or failed captures keep earlier scans.

Each compact row stores a variant index, stack count, buyout, minimum bid, current bid, and time-left band. Variant metadata preserves item differences such as enchantments, gems, suffixes, difficulty, and bonuses while removing per-instance IDs and viewer-only level or specialization fields. The scanner does not retain seller or bidder names.

The publisher converts buyout listings into minimum and weighted-median unit prices, listed quantity, listing count, variant, and timestamp. Bid-only rows do not become prices. Raw bids and time-left bands are not included in the published market data.

Every scan is marked **partial**. A quiet list for 15 seconds is a settling heuristic, not proof that the server sent every auction. Newly loaded items and newly returned rows take priority over the retry backlog. After the initial pass, ALD allows up to 90 seconds for unresolved data, then saves captured rows. New list growth restarts that phase; cache notifications and a trickle of resolved rows do not prolong it. Progress distinguishes missing item data from incomplete auction details, and saved diagnostics include both counts plus unread rows. ALD requests known missing items through the client's item-loading API, reacts to load results and keeps a polling fallback; it cannot force the client to supply every row. Commodity coverage is unverified; sales and completed transactions are not recorded. See Blizzard’s [Forever Auction House API reference](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/AuctionHouseDocumentation.lua) for the replicate API signatures and [item-loading callbacks](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_ObjectAPI/Mainline/AsyncCallbackSystem.lua) for the load-result event.

## Item tooltips

Keep Auctionator enabled for its tooltip interface. ALD supplies saved prices to Auctionator's existing **Auction** line; it does not add separate ALD tooltip lines. You only need ALD to scan. Auctionator retains its own coin formatting, **Vendor** line, localization and tooltip settings. Normal hover shows one unit; holding Shift over a stack shows the whole stack's Auction and Vendor totals. ALD enables Auctionator's existing Shift-for-stack setting.

The price source is the latest retained ALD scan for the current realm and house, matching the exact item variant. At a recognized Neutral AH, Auctionator shows the Neutral price; outside the AH it uses the player's Faction price. An unobserved Faction item uses Auctionator's normal fallback. An unobserved Neutral item shows Unknown instead of substituting a Faction price. The website still compares both houses separately.

Prices update as soon as a scan is saved, including **Stop and Save**. No publisher run or reload is needed for that in-game update. Reloading is still needed to write scans for desktop publishing. After login or reload, saved rows are indexed in small frame-budgeted batches before their prices are used. These are partial observations and may miss cheaper listings. Auctionator's optional age display uses its usual whole-day buckets.

The bridge delegates to Auctionator's renderer and supplies its price/age lookups only during that item-tooltip render. It does not rewrite Auctionator's files or persistent cache, and unrelated price lookups remain unchanged. Historical averages still come from Auctionator; Faction averages are suppressed at the Neutral AH. The adapter is checked against installed Auctionator version 347 and guards the required runtime interfaces. ALD scanning and publishing also work with Auctionator disabled, but ALD supplies no standalone tooltip renderer.

NPC recognition uses Classic reference identities: neutral Beardo (8661), Grizzlin (9857), Kresky (9858), Graves (15677), and O'reely (15681), plus the common auctioneers in each faction capital. See the [auctioneer location reference](https://warcraft.wiki.gg/wiki/Auctioneer). NPC identity comes from the interacting `npc` unit's [UnitGUID](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/UnitDocumentation.lua); full GUIDs are never saved. Manual choices store only the NPC type ID and house label.

After updating, verify each house in game: confirm the detected label and saved rows, hover an observed item to check Auctionator's Auction price, and hold Shift over a stack to check both totals. Reload and make sure the publisher imports both snapshots. Automated tests cover recognition, remembered choices, the Auctionator bridge and the scan/import/report pipeline; the new client-facing behavior still needs this in-game check.
