use crate::Result;
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::Path,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub item_id: u64,
    pub key: String,
    pub name: String,
    pub icon: String,
    pub category: String,
    pub quality: u8,
    pub min_buyout: u64,
    pub median_buyout: Option<u64>,
    pub quantity: Option<u64>,
    pub listings: Option<u64>,
}
#[derive(Deserialize, Serialize)]
pub struct Capture {
    pub captured: u64,
    pub received: u64,
}
#[derive(Deserialize, Serialize)]
pub struct Snapshot {
    pub realm: String,
    pub faction: String,
    pub source: String,
    pub timestamp: String,
    pub coverage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture: Option<Capture>,
    pub items: Vec<Item>,
}
impl Snapshot {
    pub(crate) fn house(&self) -> Option<&'static str> {
        match self.faction.as_str() {
            "Alliance" | "Horde" | "Faction" => Some("Faction"),
            "Neutral" => Some("Neutral"),
            _ => None,
        }
    }
}
#[derive(Deserialize, Serialize)]
pub struct History {
    pub version: u32,
    pub snapshots: Vec<Snapshot>,
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().ok_or("Missing output directory")?)?;
    let temporary = path.with_extension("tmp");
    let file = fs::File::create(&temporary)?;
    use std::io::Write;
    (&file).write_all(bytes)?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}
pub(crate) fn metadata(s: &Snapshot) -> Value {
    let mut value = json!({"realm":s.realm,"faction":s.faction,"source":s.source,"timestamp":s.timestamp,"coverage":s.coverage,"itemCount":s.items.len()});
    if let Some(detail) = &s.detail {
        value["detail"] = json!(detail);
    }
    if let Some(capture) = &s.capture {
        value["capture"] = json!(capture);
    }
    value
}
fn median(values: &mut [u64]) -> f64 {
    values.sort_unstable();
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) as f64 / 2.0
    } else {
        values[middle] as f64
    }
}
fn sampled<T: Clone>(points: &[T], limit: usize) -> Vec<T> {
    if points.len() <= limit {
        return points.to_vec();
    }
    (0..limit)
        .map(|n| points[n * (points.len() - 1) / (limit - 1)].clone())
        .collect()
}

fn analyze(scans: &[(i64, &Snapshot)], days: i64) -> Value {
    let latest = scans.last().unwrap().1;
    // Movement compares adjacent scans, independently of the price-history lookback.
    let previous_scan = scans.iter().rev().nth(1);
    let hours = previous_scan
        .map(|(t, _)| (scans.last().unwrap().0 - t) as f64 / 3_600_000.0)
        .filter(|h| *h > 0.0);
    let previous_items: HashMap<&str, &Item> = previous_scan
        .map(|(_, s)| s.items.iter().map(|i| (i.key.as_str(), i)).collect())
        .unwrap_or_default();
    let target = scans.last().unwrap().0 - days * 86_400_000;
    let baseline_index = scans
        .iter()
        .rposition(|(time, _)| *time <= target)
        .unwrap_or(0);
    let window = &scans[baseline_index..];
    let baseline = window[0].1;
    let maps: Vec<HashMap<&str, &Item>> = window
        .iter()
        .map(|(_, s)| s.items.iter().map(|i| (i.key.as_str(), i)).collect())
        .collect();
    let old = &maps[0];
    let mut histories: HashMap<&str, Vec<Value>> = latest
        .items
        .iter()
        .map(|i| (i.key.as_str(), Vec::new()))
        .collect();
    for (_, s) in window {
        for i in &s.items {
            if let Some(history) = histories.get_mut(i.key.as_str()) {
                history.push(
                    json!({"timestamp":s.timestamp,"price":i.min_buyout,"quantity":i.quantity}),
                );
            }
        }
    }
    let mut items = Vec::with_capacity(latest.items.len());
    for i in &latest.items {
        let history = histories.remove(i.key.as_str()).unwrap();
        let mut prices: Vec<u64> = history
            .iter()
            .map(|h| h["price"].as_u64().unwrap())
            .collect();
        let reference = median(&mut prices);
        let previous = old.get(i.key.as_str());
        let change = previous
            .filter(|_| window.len() > 1)
            .map(|p| (i.min_buyout as f64 / p.min_buyout as f64 - 1.0) * 100.0);
        let supply_change = previous
            .filter(|_| window.len() > 1)
            .and_then(|p| p.quantity)
            .zip(i.quantity)
            .map(|(before, after)| after as i64 - before as i64);
        let activity = previous_items
            .get(i.key.as_str())
            .filter(|p| p.item_id == i.item_id)
            .zip(hours)
            .and_then(|(p, hours)| {
                p.quantity.zip(i.quantity).map(|(before, after)| {
                    let delta = after as i64 - before as i64;
                    let listing_change =
                        p.listings.zip(i.listings).map(|(a, b)| b as i64 - a as i64);
                    let percent = (before > 0).then(|| delta as f64 / before as f64 * 100.0);
                    json!({"quantityBefore":before,"quantityAfter":after,"unitChange":delta,
                        "unitsPerHour":delta as f64 / hours,"percentChange":percent,
                        "percentPerHour":percent.map(|p| p / hours),"listingChange":listing_change,
                        "listingsPerHour":listing_change.map(|n| n as f64 / hours)})
                })
            });
        let mut item = serde_json::to_value(i).unwrap();
        let fields = item.as_object_mut().unwrap();
        fields.insert("historyCount".into(), json!(history.len()));
        // Display measured samples; calculate reference and margins from every observation above.
        fields.insert("history".into(), json!(sampled(&history, 32)));
        fields.insert("change".into(), json!(change));
        fields.insert("supplyChange".into(), json!(supply_change));
        fields.insert("activity".into(), json!(activity));
        fields.insert("reference".into(), json!(reference));
        fields.insert(
            "spread".into(),
            json!((reference * 0.95).floor() as i64 - i.min_buyout as i64),
        );
        items.push(item);
    }
    let basket: Vec<&Item> = latest
        .items
        .iter()
        .filter(|i| old.contains_key(i.key.as_str()))
        .collect();
    let series: Vec<Value> = window
        .iter()
        .enumerate()
        .map(|(index, (_, s))| {
            let complete = !basket.is_empty()
                && basket
                    .iter()
                    .all(|i| maps[index].contains_key(i.key.as_str()));
            let value = complete.then(|| {
                basket
                    .iter()
                    .map(|i| {
                        maps[index][i.key.as_str()].min_buyout as f64
                            / old[i.key.as_str()].min_buyout as f64
                    })
                    .sum::<f64>()
                    / basket.len() as f64
                    * 100.0
            });
            json!({"timestamp":s.timestamp,"value":value})
        })
        .collect();
    let mut movers: Vec<&Value> = items.iter().filter(|i| i["change"].is_number()).collect();
    movers.sort_by(|a, b| {
        b["change"]
            .as_f64()
            .unwrap()
            .abs()
            .total_cmp(&a["change"].as_f64().unwrap().abs())
    });
    let mover_keys: Vec<&Value> = movers.iter().take(5).map(|i| &i["key"]).collect();
    let known_supply: Vec<u64> = latest.items.iter().filter_map(|i| i.quantity).collect();
    let spreads = items
        .iter()
        .filter(|i| i["spread"].as_i64().unwrap() > 0 && i["history"].as_array().unwrap().len() > 1)
        .count();
    let sparse = series.iter().filter(|p| p["value"].is_null()).count();
    let matched = items.iter().filter(|i| i["activity"].is_object()).count();
    json!({"items":items,"latest":metadata(latest),"baseline":metadata(baseline),"series":sampled(&series,365),"seriesCount":series.len(),"basketSize":basket.len(),
        "activity":{"previous":previous_scan.map(|(_,s)| metadata(s)),"latest":metadata(latest),"hours":hours,"matchedItems":matched},
        "summary":{"knownSupplyCount":known_supply.len(),"listedSupply":if known_supply.is_empty(){None}else{Some(known_supply.iter().sum::<u64>())},"movers":mover_keys,"positiveSpreads":spreads,"sparseScans":sparse}})
}

fn save_report(output: &Path, report: &Value) -> Result<String> {
    let bytes = serde_json::to_vec(report)?;
    if bytes.len() > 90 * 1024 * 1024 {
        return Err("A report exceeds 90 MiB; split this market before publishing.".into());
    }
    let filename = format!("{}.json", hash(&bytes));
    atomic_write(&output.join("reports").join(&filename), &bytes)?;
    Ok(format!("data/reports/{filename}"))
}

pub fn build(history_path: &Path, output: &Path, fees: &crate::flips::Fees) -> Result<Value> {
    let mut history: History = serde_json::from_slice(&fs::read(history_path)?)?;
    if history.version != 1 || history.snapshots.is_empty() {
        return Err("No supported snapshots to publish".into());
    }
    let mut observations = BTreeMap::new();
    for mut scan in history.snapshots {
        if scan.source == "Auction Ledger" {
            scan.faction = scan
                .house()
                .ok_or("Auction Ledger scans must identify Faction or Neutral AH.")?
                .into();
            scan.realm = "Auction House".into();
        }
        let identity = (
            scan.realm.clone(),
            scan.faction.clone(),
            scan.source.clone(),
            scan.timestamp.clone(),
        );
        observations.insert(identity, scan);
    }
    history.snapshots = observations.into_values().collect();
    let mut groups: BTreeMap<String, Vec<(i64, &Snapshot)>> = BTreeMap::new();
    let mut snapshot_metadata = Vec::new();
    for s in &history.snapshots {
        let timestamp = DateTime::parse_from_rfc3339(&s.timestamp)?.timestamp_millis();
        if s.items.is_empty()
            || s.items
                .iter()
                .any(|i| i.min_buyout == 0 || i.min_buyout > 100_000_000_000_000)
        {
            return Err("Invalid price history".into());
        }
        let key = serde_json::to_string(&(&s.realm, &s.faction, &s.source))?;
        groups.entry(key).or_default().push((timestamp, s));
        let bytes = serde_json::to_vec(s)?;
        let filename = format!("{}.json", hash(&bytes));
        atomic_write(&output.join("history").join(&filename), &bytes)?;
        let mut entry = metadata(s);
        entry["file"] = json!(format!("data/history/{filename}"));
        snapshot_metadata.push(entry);
    }
    snapshot_metadata.sort_by(|a, b| a["timestamp"].as_str().cmp(&b["timestamp"].as_str()));
    let mut markets = Vec::new();
    for (key, mut scans) in groups {
        scans.sort_by_key(|s| s.0);
        let latest = scans.last().unwrap().1;
        let mut periods = BTreeMap::new();
        for days in [1, 7, 30, 36500] {
            periods.insert(
                days.to_string(),
                save_report(output, &analyze(&scans, days))?,
            );
        }
        markets.push(json!({"key":key,"realm":latest.realm,"faction":latest.faction,"source":latest.source,"periods":periods}));
    }
    atomic_write(
        &output.join("history.json"),
        &serde_json::to_vec(&json!({"version":1,"snapshots":snapshot_metadata}))?,
    )?;
    let flips = save_report(output, &crate::flips::build(&history, fees)?)?;
    let revision = hash(&serde_json::to_vec(
        &json!({"history":history,"flipFees":fees}),
    )?);
    let manifest = json!({"version":1,"engine":"rust-v1","revision":revision,"asOf":snapshot_metadata.last().unwrap()["timestamp"],"markets":markets,"snapshots":snapshot_metadata,"flips":flips});
    atomic_write(&output.join("trends.json"), &serde_json::to_vec(&manifest)?)?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn movement_uses_adjacent_matched_counts_without_inventing_sales_or_missing_stock() {
        let make = |date: &str, rows: &[(u64, &str, Option<u64>, Option<u64>)]| -> Snapshot {
            serde_json::from_value(json!({"realm":"Auction House","faction":"Faction",
                "source":"Auction Ledger","timestamp":date,"coverage":"partial",
                "capture":{"captured":95,"received":100},
                "items":rows.iter().map(|(id,key,quantity,listings)| json!({"itemId":id,
                    "key":key,"name":key,"icon":"icon","category":"Other","quality":1,
                    "minBuyout":100,"medianBuyout":100,"quantity":quantity,"listings":listings})).collect::<Vec<_>>()})).unwrap()
        };
        let first = make(
            "2026-01-01T00:00:00Z",
            &[(1, "1", Some(200), Some(20)), (2, "2", Some(100), Some(10))],
        );
        let previous = make(
            "2026-01-01T02:00:00Z",
            &[
                (1, "1", Some(160), Some(16)),
                (3, "3", Some(50), None),
                (4, "4", Some(0), Some(0)),
                (5, "5:variant-a", Some(100), Some(10)),
                (6, "6", Some(10), Some(1)),
            ],
        );
        let latest = make(
            "2026-01-01T04:00:00Z",
            &[
                (1, "1", Some(120), Some(12)),
                (2, "2", Some(10), Some(1)),
                (3, "3", None, Some(1)),
                (4, "4", Some(10), None),
                (5, "5:variant-b", Some(20), Some(2)),
                (6, "6", Some(10), Some(2)),
            ],
        );
        let scans = [(0, &first), (7_200_000, &previous), (14_400_000, &latest)];
        let report = analyze(&scans, 36500);
        let movement = &report["items"][0]["activity"];
        assert_eq!(report["items"][0]["supplyChange"], -80); // Price lookback is independent.
        assert_eq!(movement["unitChange"], -40);
        assert_eq!(movement["unitsPerHour"], -20.0);
        assert_eq!(movement["listingChange"], -4);
        assert_eq!(movement["listingsPerHour"], -2.0);
        assert_eq!(movement["percentPerHour"], -12.5);
        assert_eq!(report["activity"]["hours"], 2.0);
        assert_eq!(
            report["activity"]["previous"]["timestamp"],
            previous.timestamp
        );
        assert_eq!(report["activity"]["previous"]["capture"]["captured"], 95);
        assert_eq!(report["activity"]["matchedItems"], 3);
        for index in [1, 2, 4] {
            assert!(report["items"][index]["activity"].is_null());
        }
        assert_eq!(report["items"][3]["activity"]["unitsPerHour"], 5.0);
        assert!(report["items"][3]["activity"]["percentPerHour"].is_null());
        assert!(report["items"][3]["activity"]["listingChange"].is_null());
        assert_eq!(report["items"][5]["activity"]["unitChange"], 0);
        assert_eq!(report["items"][5]["activity"]["listingChange"], 1);
        let only = analyze(&scans[2..], 1);
        assert!(only["activity"]["hours"].is_null());
        assert!(only["items"][0]["activity"].is_null());
        let same_time = analyze(&[(0, &previous), (0, &latest)], 1);
        assert!(same_time["items"][0]["activity"].is_null());
    }

    #[test]
    fn sampling_keeps_real_endpoints_and_metrics_use_full_history() {
        let indices: Vec<usize> = sampled(&(0..70).collect::<Vec<_>>(), 32);
        assert_eq!(indices.first(), Some(&0));
        assert_eq!(indices.last(), Some(&69));
        let mut snapshots = Vec::new();
        for n in 0..70 {
            let item = Item {
                item_id: 1,
                key: "1".into(),
                name: "Test".into(),
                icon: "icon".into(),
                category: "Other".into(),
                quality: 1,
                min_buyout: if n == 69 {
                    10
                } else if indices.contains(&n) {
                    1000
                } else {
                    100
                },
                median_buyout: Some(100),
                quantity: None,
                listings: None,
            };
            snapshots.push(Snapshot {
                realm: "Test".into(),
                faction: "Shared".into(),
                source: "CSV".into(),
                timestamp: n.to_string(),
                coverage: "partial".into(),
                detail: None,
                capture: None,
                items: vec![item],
            });
        }
        let scans: Vec<_> = snapshots
            .iter()
            .enumerate()
            .map(|(n, s)| (n as i64 * 86_400_000, s))
            .collect();
        let report = analyze(&scans, 36500);
        assert_eq!(report["items"][0]["historyCount"], 70);
        assert_eq!(report["items"][0]["history"].as_array().unwrap().len(), 32);
        assert_eq!(report["items"][0]["reference"], 100.0);
        assert_eq!(report["items"][0]["spread"], 85);
    }
    #[test]
    fn reference_sparse_basket_and_copper_margins() {
        let make = |date: &str, prices: &[(u64, u64, Option<u64>)]| Snapshot {
            realm: "Test".into(),
            faction: "Alliance".into(),
            source: "Auctioneer".into(),
            timestamp: date.into(),
            coverage: "partial".into(),
            detail: None,
            capture: None,
            items: prices
                .iter()
                .map(|(id, price, quantity)| Item {
                    item_id: *id,
                    key: id.to_string(),
                    name: id.to_string(),
                    icon: "icon".into(),
                    category: "Other".into(),
                    quality: 1,
                    min_buyout: *price,
                    median_buyout: Some(*price),
                    quantity: *quantity,
                    listings: None,
                })
                .collect(),
        };
        let first = make(
            "2026-01-01T00:00:00Z",
            &[(1, 100, Some(10)), (2, 200, None)],
        );
        let sparse = make("2026-01-02T00:00:00Z", &[(1, 120, Some(20))]);
        let last = make(
            "2026-01-03T00:00:00Z",
            &[(1, 80, Some(5)), (2, 300, None), (3, 50, None)],
        );
        let scans = vec![(0, &first), (86_400_000, &sparse), (172_800_000, &last)];
        let a = analyze(&scans, 7);
        assert_eq!(a["basketSize"], 2);
        assert!(a["series"][1]["value"].is_null());
        assert!((a["series"][2]["value"].as_f64().unwrap() - 115.0).abs() < 1e-10);
        assert!((a["items"][0]["change"].as_f64().unwrap() + 20.0).abs() < 1e-10);
        assert_eq!(a["items"][0]["reference"], 100.0);
        assert_eq!(a["items"][0]["spread"], 15);
        assert_eq!(a["items"][0]["supplyChange"], -5);
        assert!(a["items"][2]["change"].is_null());
        assert_eq!(a["summary"]["listedSupply"], 5);
        assert_eq!(a["summary"]["positiveSpreads"], 1);
        let day = analyze(&scans, 1);
        assert_eq!(day["baseline"]["timestamp"], sparse.timestamp);
        let only = analyze(&scans[2..], 7);
        assert!(only["items"][0]["change"].is_null());
    }
}
