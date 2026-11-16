use crate::{
    Result,
    report::{History, Snapshot, metadata},
};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

#[derive(Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Fees {
    pub faction_percent: u8,
    pub neutral_percent: u8,
}
impl Default for Fees {
    fn default() -> Self {
        Self {
            faction_percent: 5,
            neutral_percent: 15,
        }
    }
}

pub fn build(history: &History, fees: &Fees) -> Result<Value> {
    if fees.faction_percent > 100 || fees.neutral_percent > 100 {
        return Err("Flip fees must be whole percentages from 0 to 100.".into());
    }
    // Realm labels and player factions share one economy; only the AH type separates scans.
    let mut houses: BTreeMap<&str, (i64, &Snapshot)> = BTreeMap::new();
    for scan in &history.snapshots {
        if scan.source != "Auction Ledger" {
            continue;
        }
        let Some(house) = scan.house() else {
            continue;
        };
        let timestamp = DateTime::parse_from_rfc3339(&scan.timestamp)?.timestamp_millis();
        if houses
            .get(house)
            .is_none_or(|(previous, _)| timestamp >= *previous)
        {
            houses.insert(house, (timestamp, scan));
        }
    }
    let mut pairs = Vec::new();
    if !houses.is_empty() {
        let faction_scan = houses.get("Faction").map(|(_, scan)| *scan);
        let neutral_scan = houses.get("Neutral").map(|(_, scan)| *scan);
        let mut items = Vec::new();
        let mut matched = 0;
        if let (Some(faction_scan), Some(neutral_scan)) = (faction_scan, neutral_scan) {
            let neutral_items: HashMap<_, _> = neutral_scan
                .items
                .iter()
                .map(|item| (item.key.as_str(), item))
                .collect();
            for faction_item in &faction_scan.items {
                let Some(neutral_item) = neutral_items
                    .get(faction_item.key.as_str())
                    .filter(|item| item.item_id == faction_item.item_id)
                else {
                    continue;
                };
                matched += 1;
                for (direction, buy, sell, fee) in [
                    (
                        "neutral-to-faction",
                        *neutral_item,
                        faction_item,
                        fees.faction_percent,
                    ),
                    (
                        "faction-to-neutral",
                        faction_item,
                        *neutral_item,
                        fees.neutral_percent,
                    ),
                ] {
                    // Round proceeds down to whole copper; do not apply the cheapest price to all listed units.
                    let proceeds = sell.min_buyout * u64::from(100 - fee) / 100;
                    if proceeds <= buy.min_buyout {
                        continue;
                    }
                    let margin = proceeds - buy.min_buyout;
                    items.push(
                        json!({"key":buy.key,"itemId":buy.item_id,"name":buy.name,"icon":buy.icon,
                            "category":buy.category,"quality":buy.quality,"direction":direction,
                            "buy":buy.min_buyout,"sell":sell.min_buyout,"feePercent":fee,
                            "margin":margin,"roi":margin as f64 / buy.min_buyout as f64 * 100.0}),
                    );
                }
            }
        }
        items.sort_by(|a, b| {
            b["margin"]
                .as_u64()
                .cmp(&a["margin"].as_u64())
                .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
                .then_with(|| a["key"].as_str().cmp(&b["key"].as_str()))
        });
        pairs.push(
            json!({"key":"shared","realm":"Auction House","faction":"Faction",
                "factionScan":faction_scan.map(metadata),"neutralScan":neutral_scan.map(metadata),
                "matchedItems":matched,"items":items}),
        );
    }
    Ok(json!({"version":1,"fees":fees,"pairs":pairs}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scan(faction: &str, timestamp: &str, items: Value) -> Snapshot {
        serde_json::from_value(
            json!({"realm":"Test","faction":faction,"source":"Auction Ledger",
            "timestamp":timestamp,"coverage":"partial","items":items}),
        )
        .unwrap()
    }
    fn item(key: &str, price: u64) -> Value {
        json!({"itemId":1,"key":key,"name":"Test item","icon":"icon","category":"Other",
            "quality":1,"minBuyout":price,"medianBuyout":price,"quantity":10,"listings":2})
    }
    #[test]
    fn directions_use_destination_fees_and_only_identical_variants_in_latest_scans() {
        let mut cache = scan("Neutral", "2026-01-03T00:00:00Z", json!([item("base", 1)]));
        cache.source = "Auctionator cache".into();
        let history = History {
            version: 1,
            snapshots: vec![
                scan(
                    "Alliance",
                    "2026-01-01T00:00:00Z",
                    json!([item("old-only", 1)]),
                ),
                scan(
                    "Alliance",
                    "2026-01-02T00:00:00Z",
                    json!([
                        item("base", 1000),
                        item("reverse", 500),
                        item("fee-loss", 900),
                        item("variant:a", 1)
                    ]),
                ),
                scan(
                    "Neutral",
                    "2026-01-02T00:30:00Z",
                    json!([
                        item("base", 500),
                        item("reverse", 1000),
                        item("fee-loss", 1000),
                        item("variant:b", 10000),
                        item("old-only", 10000)
                    ]),
                ),
                cache,
            ],
        };
        let report = build(&history, &Fees::default()).unwrap();
        let pair = report["pairs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|pair| pair["key"] == "shared")
            .unwrap();
        assert_eq!(pair["matchedItems"], 3);
        assert_eq!(pair["factionScan"]["timestamp"], "2026-01-02T00:00:00Z");
        let rows = pair["items"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["direction"], "neutral-to-faction");
        assert_eq!(rows[0]["margin"], 450);
        assert_eq!(rows[0]["roi"], 90.0);
        assert_eq!(rows[1]["direction"], "faction-to-neutral");
        assert_eq!(rows[1]["margin"], 350);
        assert_eq!(rows[1]["feePercent"], 15);
        assert_eq!(pair["neutralScan"]["coverage"], "partial");
        let no_fee = build(
            &history,
            &Fees {
                faction_percent: 0,
                neutral_percent: 0,
            },
        )
        .unwrap();
        let pair = no_fee["pairs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|pair| pair["key"] == "shared")
            .unwrap();
        assert_eq!(pair["items"].as_array().unwrap().len(), 3);
        assert!(
            build(
                &history,
                &Fees {
                    faction_percent: 101,
                    neutral_percent: 15
                }
            )
            .is_err()
        );
    }
    #[test]
    fn newest_house_scans_pair_across_realm_and_faction_labels() {
        let older = scan(
            "Alliance",
            "2026-01-01T00:00:00Z",
            json!([item("base", 1000)]),
        );
        let mut newer = scan("Horde", "2026-01-03T00:00:00Z", json!([item("base", 2000)]));
        newer.realm = "Another label".into();
        let mut neutral = scan(
            "Neutral",
            "2026-01-02T00:00:00Z",
            json!([item("base", 500)]),
        );
        neutral.realm = "Third label".into();
        let history = History {
            version: 1,
            snapshots: vec![older, newer, neutral],
        };
        let report = build(&history, &Fees::default()).unwrap();
        let pairs = report["pairs"].as_array().unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0]["factionScan"]["timestamp"], "2026-01-03T00:00:00Z");
        assert_eq!(pairs[0]["neutralScan"]["timestamp"], "2026-01-02T00:00:00Z");
        assert_eq!(pairs[0]["items"][0]["direction"], "neutral-to-faction");
        assert_eq!(pairs[0]["items"][0]["margin"], 1400);
    }
    #[test]
    fn missing_house_stays_missing_and_fee_rounding_never_invents_a_positive_margin() {
        let history = History {
            version: 1,
            snapshots: vec![
                scan("Horde", "2026-01-02T00:00:00Z", json!([item("one", 19)])),
                scan("Neutral", "2026-01-02T00:01:00Z", json!([item("one", 20)])),
                scan("Alliance", "2026-01-02T00:02:00Z", json!([item("one", 20)])),
            ],
        };
        assert!(
            build(&history, &Fees::default()).unwrap()["pairs"]
                .as_array()
                .unwrap()
                .iter()
                .all(|pair| pair["items"].as_array().unwrap().is_empty())
        );
        let history = History {
            version: 1,
            snapshots: vec![scan(
                "Alliance",
                "2026-01-02T00:00:00Z",
                json!([item("one", 500)]),
            )],
        };
        let report = build(&history, &Fees::default()).unwrap();
        assert!(report["pairs"][0]["neutralScan"].is_null());
        assert!(report["pairs"][0]["items"].as_array().unwrap().is_empty());
    }
}
