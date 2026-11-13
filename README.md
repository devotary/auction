# The Auction Ledger

A personal World of Warcraft Auction House observatory for Auctioneer scans and Auctionator price history.

The dashboard is being built. It will provide daily price trends, listed supply, movers, a watchlist, and a resale calculator, with scan imports processed locally in the browser.

## Enable GitHub Pages

In **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source. The deployment workflow will publish the completed dashboard at https://devotary.github.io/auction/.

Original game files remain untouched. Raw SavedVariables should never be committed; only sanitized aggregate price observations belong in the published site.
