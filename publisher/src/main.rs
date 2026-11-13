mod report;
use serde::Deserialize;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::Instant,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    repository: String,
    deploy_key: PathBuf,
    #[serde(default)]
    timezone: Option<String>,
}
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}
fn run(mut command: Command) -> Result<Output> {
    let output = command.output()?;
    if !output.status.success() {
        return Err(format!(
            "Command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(output)
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn git(config: &Config, cwd: &Path, args: &[&str]) -> Result<String> {
    let ssh = format!(
        "ssh -F /dev/null -i {} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=15",
        quote(config.deploy_key.to_str().ok_or("Invalid key path")?)
    );
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .args(args)
        .env("GIT_SSH_COMMAND", ssh)
        .env("GIT_TERMINAL_PROMPT", "0");
    Ok(String::from_utf8(run(command)?.stdout)?.trim().to_owned())
}
fn local_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn copy_reports(source: &Path, target: &Path) -> Result<()> {
    // ponytail: retain immutable files for open browser tabs; prune old report generations if Pages storage becomes a concern.
    for folder in ["reports", "history"] {
        fs::create_dir_all(target.join(folder))?;
        for entry in fs::read_dir(source.join(folder))? {
            let entry = entry?;
            fs::copy(entry.path(), target.join(folder).join(entry.file_name()))?;
        }
    }
    fs::copy(source.join("history.json"), target.join("history.json"))?;
    fs::copy(source.join("trends.json"), target.join("trends.json"))?;
    Ok(())
}
fn main() {
    if let Err(error) = execute() {
        eprintln!("Auction publisher: {error}");
        std::process::exit(1);
    }
}
fn execute() -> Result<()> {
    let started = Instant::now();
    let root = root();
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "--help" || a == "-h") {
        println!(
            "Auction Publisher\n\nRun after /reload or logging out of WoW.\n  publish-auctions              Read scans, calculate trends, commit and push main\n  publish-auctions --preview    Calculate locally; no Git/network changes\n  publish-auctions --config FILE [--preview]\n  auction-publisher --build HISTORY_JSON OUTPUT_DATA_DIR\n\nPrivate configuration: .local/publisher/config.json. See PUBLISHER.md."
        );
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "--build") {
        if args.len() != 3 {
            return Err("Usage: --build HISTORY_JSON OUTPUT_DATA_DIR".into());
        }
        let report = report::build(Path::new(&args[1]), Path::new(&args[2]))?;
        println!(
            "Calculated {} markets in {:.2}s",
            report["markets"].as_array().unwrap().len(),
            started.elapsed().as_secs_f64()
        );
        return Ok(());
    }
    let mut config_path = root.join(".local/publisher/config.json");
    let mut preview = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--preview" => preview = true,
            "--config" => {
                index += 1;
                config_path = PathBuf::from(args.get(index).ok_or("--config needs a file")?);
            }
            _ => return Err("Unknown option. Use --help.".into()),
        }
        index += 1;
    }
    let config_path =
        fs::canonicalize(&config_path).map_err(|_| "Missing private config. See PUBLISHER.md.")?;
    let config: Config = serde_json::from_slice(&fs::read(&config_path)?)?;
    let state = config_path.parent().ok_or("Invalid config location")?;
    local_directory(state)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(state.join("publish.lock"))?;
    lock.try_lock()
        .map_err(|_| "Another publisher is running. Wait for it to finish.")?;
    let checkout = state.join("checkout");
    if !preview {
        if !config.deploy_key.is_absolute() || !config.deploy_key.is_file() {
            return Err("Configured deploy key is missing or not an absolute file path.".into());
        }
        if !checkout.exists() {
            println!("Creating a separate publishing checkout…");
            git(
                &config,
                state,
                &[
                    "clone",
                    "--single-branch",
                    "--branch",
                    "main",
                    "--",
                    &config.repository,
                    "checkout",
                ],
            )?;
            fs::write(checkout.join(".git/auction-publisher-owned"), b"1")?;
        }
        if !checkout.join(".git/auction-publisher-owned").is_file() {
            return Err(
                "Publishing checkout is not owned by this app; refusing to modify it.".into(),
            );
        }
        if !git(&config, &checkout, &["status", "--porcelain"])?.is_empty() {
            return Err("Publishing checkout has unfinished changes. History is safe in history.json; see PUBLISHER.md recovery instructions.".into());
        }
        if git(&config, &checkout, &["remote", "get-url", "origin"])? != config.repository {
            return Err("Publishing checkout remote does not match configuration.".into());
        }
        git(&config, &checkout, &["fetch", "origin", "main"])?;
        git(&config, &checkout, &["merge", "--ff-only", "origin/main"])?;
    }
    let history = state.join("history.json");
    if !history.exists() {
        report::atomic_write(&history, br#"{"version":1,"snapshots":[]}"#)?;
    }
    // Include any sanitized observations published from another machine, without losing local unpushed history.
    let prepared = state.join("prepared.json");
    let mut command = Command::new("node");
    command
        .arg(root.join("publisher/ingest/prepare.mjs"))
        .arg(&config_path)
        .arg(&history)
        .arg(&prepared);
    let published_root = if preview { &root } else { &checkout };
    command.arg(published_root.join("data/history.json"));
    if let Some(timezone) = &config.timezone {
        command.env("TZ", timezone);
    }
    let summary = run(command)?;
    let receipt: serde_json::Value = serde_json::from_slice(&summary.stdout)?;
    println!(
        "Read {} input observations; library contains {} snapshots.",
        receipt["imported"], receipt["total"]
    );
    if let Some(warnings) = receipt["warnings"].as_array() {
        for warning in warnings {
            println!("{}", warning.as_str().unwrap_or("Input skipped."));
        }
    }
    let output = state.join("preview/data");
    // Rebuild only generated staging files; private history and the publishing checkout stay intact on failure.
    if output.exists() {
        fs::remove_dir_all(&output)?;
    }
    let manifest = report::build(&prepared, &output)?;
    report::atomic_write(&history, &fs::read(&prepared)?)?;
    #[cfg(unix)]
    fs::set_permissions(&history, fs::Permissions::from_mode(0o600))?;
    println!(
        "Calculated {} markets / 4 periods from {} snapshots in {:.2}s.",
        manifest["markets"].as_array().unwrap().len(),
        manifest["snapshots"].as_array().unwrap().len(),
        started.elapsed().as_secs_f64()
    );
    if preview {
        println!("Preview data ready. Nothing committed or pushed.");
        return Ok(());
    }
    copy_reports(&output, &checkout.join("data"))?;
    git(
        &config,
        &checkout,
        &[
            "add",
            "--",
            "data/history.json",
            "data/history",
            "data/trends.json",
            "data/reports",
        ],
    )?;
    let staged = git(&config, &checkout, &["diff", "--cached", "--name-only"])?;
    if !staged.is_empty() {
        if staged.lines().any(|p| {
            p != "data/history.json"
                && p != "data/trends.json"
                && !(p.starts_with("data/history/") && p.ends_with(".json"))
                && !(p.starts_with("data/reports/") && p.ends_with(".json"))
        }) {
            return Err("Refusing to commit a file outside generated market data.".into());
        }
        git(
            &config,
            &checkout,
            &[
                "-c",
                "user.name=Auction Ledger",
                "-c",
                "user.email=auction-ledger@users.noreply.github.com",
                "commit",
                "-m",
                "Update locally calculated auction trends",
            ],
        )?;
    }
    let ahead = git(
        &config,
        &checkout,
        &["rev-list", "--count", "origin/main..HEAD"],
    )?;
    if ahead == "0" {
        println!("No new market data; Pages is already up to date.");
        return Ok(());
    }
    git(&config, &checkout, &["push", "origin", "HEAD:main"])?;
    println!(
        "Published to main. GitHub Pages will update shortly.\nhttps://devotary.github.io/auction/"
    );
    Ok(())
}
