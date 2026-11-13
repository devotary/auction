# The Auction Ledger

Product: a personal World of Warcraft Auction House observatory. Compare daily/twice-daily Auctioneer listing snapshots and Auctionator price history, discover price movers, inspect listed supply, track favorites, estimate resale proceeds after configurable fees. Static GitHub Pages, all imports parsed locally; no account identifiers published.

Character: old-world, familiar, exact. World: the original World of Warcraft auction window. Signature: authentic red beveled controls, black parchment and original gold dialog borders. Rich moments: Warcraft landscape, quality-colored items and an amber price-history chart.

Primary style reference: the user's explicit Classic WoW UI direction. Use original Blizzard button states and frame art, dark mottled surfaces, yellow/gold serif headings and in-game item colors. Bevels, textured chrome and subtle title shadows intentionally follow that request. Preserve readable data, accessible focus, touch controls and the established responsive layout. No generic dashboard gradients, glass, fake live indicators or gratuitous motion.

Palette: textured black background #0e0c0a, sidebar #100e0c, panel #171411, raised #2c241c, border #574635, text #eee0c7, secondary #c2b399, muted #ab9c85. Brass #e5bf76, Classic heading/button text #ffd100, original red button art, positive #8cc987, negative #ed9a86. Warcraft rarity colors carry item meaning.

Typography: Georgia serif for product and section headings, system sans for controls/body, system monospace/tabular figures for market prices. H1 40px normal, H2 22px normal, body 14px, small 12px. No decorative display fonts needed.

Layout: 216px framed sidebar with Warcraft Classic logo, fluid content capped at 1600px. Compact top bar, illustrated masthead, scan notice, four stats, 2:1 chart and movers, searchable sortable ledger. Red import action; realm/faction/source selector and period controls. Mobile: compact logo and horizontal navigation, stacked panels, scrollable table. Preserve 44px touch controls, keyboard focus and phone dialog bounds. Frame art uses CSS border-image; textures tile locally. Motion limited to short state changes; respect reduced motion.

Data semantics: prices in copper, unit buyouts, distinguish listings from units. Missing supply stays unknown. Price index uses a matched basket. Trends compare observed scans with explicit reference dates. Sample data clearly labeled. No claims of actual sales or guaranteed profit. Profit calculator exposes buy price, target sale price, quantity, AH cut and nonrefundable expenses. No hidden offsite dependencies for runtime charts or parsing.

Views: overview; item ledger; watchlist; scan library/import dialog; item detail with price-history chart and resale calculator. Native accessible dialogs, explicit labels, focus indicators, keyboard-operable controls, useful empty/error states. First screen should look like a crafted Warcraft trading tool, not an admin template.

Design reference: unslop by Damir Sokolovsky, https://x.com/heydamir, CC BY 4.0.
