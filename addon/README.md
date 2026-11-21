# Auction Ledger Scanner

Auction Ledger Scanner is a small, read-only addon for WoW Forever 1.60.1 (`Interface: 16001`). It requests an Auction House replicate list, with a paged browse-summary fallback, stores observations in `AuctionLedgerDB`, and lets the desktop publisher turn them into sanitized price and supply snapshots.

## Install and scan

Copy the `AuctionLedger` folder from this directory into the Forever client’s `Interface/AddOns/` folder. This installs a new addon folder; it does not replace or edit your existing addons. No account IDs or account-folder paths are needed in addon settings.

Open the Auction House and click **Scan** in its bottom-right tab strip to open the ALD menu. The menu contains **Scan current**, Faction/Neutral selection, **Stop and Save**, and **Cancel**. You can also open it with `/ald`, or start a recognized house directly with:

```text
/ald scan
```

Keep the Auction House open and leave other auction searches and scanners idle while it runs. ALD requests one full list. If no response event arrives within 45 seconds, it switches to a paged browse summary. `/ald status` shows progress. In listing mode, once every returned row is cataloged, the menu shows a countdown and saves automatically after the list has stopped growing for 15 seconds. The button changes to **Save now** if you want to save immediately. Browse mode saves when the client reports all browse pages received. When it reports saved data, use `/reload` so WoW writes SavedVariables, then run the desktop publisher described in [PUBLISHER.md](../PUBLISHER.md).

To bypass an unresponsive full-list endpoint, use `/ald browse`, `/ald browse faction`, or `/ald browse neutral`. These use the same house detection and manual choices as `/ald scan`. The paged scan waits for the client's query throttle and sends one request at a time. A new search interrupts it and saves already captured groups as partial data. Cancel and closing the AH still discard the current capture. A browse response timeout saves any captured groups, retaining older scans when none were received.

Browse summaries record the AH's minimum price and total listed quantity for each item group. They cannot provide auction counts, listing-level price distributions or a weighted median. The publisher preserves those unknowns and labels the summary on the website. Item ID, item level, random suffix and pet species identify each group. Groups remain separate from detailed item-string variants, so two summary scans are needed for their supply movement; use summaries at both houses for flips. Browse quantities are the game's summary counts, not confirmed sales or a count of units available at the lowest price.

Click **Stop and Save** or enter `/ald save` to keep the rows already captured without waiting for the remaining items. The result includes captured, received and unresolved counts. If all returned rows were captured, it reports **Capture complete**, including when you save manually; otherwise it reports **Partial capture saved**. Then `/reload` and run the publisher as usual. The button is enabled once at least one row is captured; an empty `/ald save` leaves the scan running.

`/ald` displays the detected house. **Scan current** or `/ald scan` uses that detection. Recognition uses the current interacting auctioneer's NPC identity, including the five Classic neutral auctioneers and the common faction-capital auctioneers. It does not infer the market from the player's faction or a broad map zone. The new recognition paths still need an in-game check on Forever.

For an unknown auctioneer, automatic scanning stays disabled. Choose **Scan Faction AH** (`/ald scan faction`) or **Scan Neutral AH** (`/ald scan neutral`). After a successful saved manual scan, ALD remembers that NPC's house choice across reloads. A later manual scan can correct the choice. If the client does not expose an interacting NPC identity, use the manual buttons each time.

Manual buttons override detection, so choose the one matching the AH you actually opened. Progress and saved messages identify the selected house. The full-scan cooldown applies between houses too.

Save and `/reload` after each house, then run **Auction Ledger Flips** or `./publish-flips`. The existing publisher also updates the comparisons. The website's **Flips** tab shows the direction, both unit prices and the potential margin after the destination sale fee. A scan of only one house produces an explanation of which counterpart is missing, not invented prices.

**Cancel** or `/ald cancel` discards the current capture. `/ald status` reports progress or the last attempt. Closing the Auction House also stops the capture without replacing saved scans.

Updating an already loaded addon requires `/reload`. If a scan is running, finish it or use **Stop and Save** before reloading to keep its rows. Installing the updated files does not interrupt it.

The API may throttle full-list requests for about 15 minutes. The addon records its own requests and responses; during that cooldown it uses browse mode if available. It cannot see other characters’ or addons’ server-side full-list requests. If browse APIs are unavailable, the existing full-list wait is capped at 15 minutes. No stale cached list is accepted without a response to the new scan.

## What gets saved

Saved data keeps at most three scans and roughly 56 MiB by a conservative storage estimate. One capture stops above 500,000 listing rows or an estimated 48 MiB. The publisher accepts the same row limit and aggregates listings into item variants, so many auctions of the same item do not become separate website entries. These estimates include headroom and can be much larger than the file WoW writes. If a row, storage or capture-time budget is reached, ALD saves any captured rows as a partial scan instead of discarding them. The saved message includes the stop reason. Older duplicates of a house are evicted first, preserving the latest other-house scan during repeated scans of one house. Realm and player-faction labels share one economy, matching the publisher; Faction and Neutral stay separate. The total size budget still applies; publish after each scan. Cancelled or failed captures keep earlier scans.

Each compact row stores a variant index, stack count, buyout, minimum bid, current bid, and time-left band. Variant metadata preserves item differences such as enchantments, gems, suffixes, difficulty, and bonuses while removing per-instance IDs and viewer-only level or specialization fields. The scanner does not retain seller or bidder names.

For scans marked `api = "browse"`, each row instead stores `group index;quantity;minimum price`, and variant metadata stores only the four numeric item-key fields and ordinary item metadata. Repeated pages replace a group's observation; they never add the same quantity twice. No imaginary stacks or auctions are created from summary data. Public summaries omit listing-row capture counts, because their rows represent item groups.

The publisher converts buyout listings into minimum and weighted-median unit prices, listed quantity, listing count, variant, and timestamp. Bid-only rows do not become prices. Raw bids and time-left bands are not included in the published market data.

Saved `captureComplete` records whether every returned row was captured. Market `coverage` remains **partial**: a quiet list for 15 seconds is a settling heuristic, not proof that the server sent every auction. Newly loaded items and newly returned rows take priority over the retry backlog. After the initial pass, ALD allows up to 90 seconds for unresolved data, then saves captured rows. New list growth restarts that phase; cache notifications and a trickle of resolved rows do not prolong it. Progress distinguishes missing item data from incomplete auction details, and saved diagnostics include both counts plus unread rows. ALD requests known missing items through the client's item-loading API, reacts to load results and keeps a polling fallback; it cannot force the client to supply every row. Commodity coverage is unverified; sales and completed transactions are not recorded. See Blizzard’s [Forever Auction House API reference](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/AuctionHouseDocumentation.lua) for the replicate API signatures and [item-loading callbacks](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_ObjectAPI/Mainline/AsyncCallbackSystem.lua) for the load-result event.

## Item tooltips

Keep Auctionator enabled for its tooltip interface. ALD supplies saved prices to Auctionator's existing **Auction** line; it does not add separate ALD tooltip lines. You only need ALD to scan. Auctionator retains its own coin formatting, **Vendor** line, localization and tooltip settings. Normal hover shows one unit; holding Shift over a stack shows the whole stack's Auction and Vendor totals. ALD enables Auctionator's existing Shift-for-stack setting.

The **Auction** tooltip prefers the latest known price for that exact item variant among the account's retained ALD **Faction AH** scans, including while visiting or scanning the Neutral AH. A smaller partial scan does not erase prices for items it missed; older retained observations remain usable with their original observation date. Realm labels and Alliance/Horde labels share Faction prices, matching the publisher. ALD never substitutes a Neutral observation.

For a newer browse summary, the tooltip uses the matching AH item group rather than an individual enchanted listing. Equipment level and suffix must match; zero-level groups cover the broader group defined by the AH. If the hovered item's level is not available, ALD leaves that level-specific price to its existing stale/native fallback. Summary prices are never divided by the listed quantity.

If ALD has no usable price, Auctionator's normal cache lookup supplies the fallback, including older cached prices. While a new scan is being indexed, an already indexed ALD observation remains available; otherwise Auctionator supplies its own price and age until indexing finishes. **Unknown** appears only when neither source has a price. No separate tooltip lines are added. SavedVariables remain separate between WoW accounts; the desktop publisher combines those accounts for the website. Neutral scans still feed the website's Flips comparisons.

Prices update as soon as a scan is saved, including **Stop and Save**. Cancel and closing the AH discard the current capture and keep previous saved prices. No publisher run or reload is needed for the in-game update. Reloading is still needed to write scans for desktop publishing. After login or reload, saved rows are indexed in small frame-budgeted batches before their prices are used; refreshes preserve indexing progress. These are partial observations and may miss cheaper listings. Auctionator's optional age display uses each item's observation date in its usual whole-day buckets.

The bridge delegates to Auctionator's renderer and supplies its Auction price/age lookups only during that item-tooltip render. It does not rewrite Auctionator's files or persistent cache, and unrelated price lookups remain unchanged. Optional historical averages still come from Auctionator. The adapter is checked against installed Auctionator version 347 and guards the required runtime interfaces. ALD scanning and publishing also work with Auctionator disabled, but ALD supplies no standalone tooltip renderer.

Automatic refreshes rebuild only a confirmed item tooltip. Unit, spell, forbidden and unknown tooltip types are left alone, preventing price-index updates from rebuilding protected unit tooltips. Item prices still update on save and when indexing finishes.

NPC recognition uses Classic reference identities: neutral Beardo (8661), Grizzlin (9857), Kresky (9858), Graves (15677), and O'reely (15681), plus the common auctioneers in each faction capital. See the [auctioneer location reference](https://warcraft.wiki.gg/wiki/Auctioneer). NPC identity comes from the interacting `npc` unit's [UnitGUID](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/UnitDocumentation.lua); full GUIDs are never saved. Manual choices store only the NPC type ID and house label.

After updating, verify each house in game: confirm the detected label and saved rows, hover an observed item to check Auctionator's Auction price, and hold Shift over a stack to check both totals. Reload and make sure the publisher imports both snapshots. Automated tests cover recognition, remembered choices, the Auctionator bridge and the scan/import/report pipeline; the new client-facing behavior still needs this in-game check.
