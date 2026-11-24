use anyhow::{bail, Result};
use bothq_a2ui_agent::agent::{Agent, Event, Pause};
use bothq_a2ui_agent::feed::{self, Kalshi};
use bothq_a2ui_agent::server::{router, App};
use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Copy, Debug, ValueEnum)]
enum FeedKind {
    Kalshi,
    Replay,
}

#[derive(Parser)]
#[command(version, about = "bot-Hq durable A2UI 1.0 OrderTicket agent (paper trading only)")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
    /// SQLite file holding the rpi-durable journal and the paper orders.
    #[arg(long, env = "BOTHQ_A2UI_DB", default_value = "./data/a2ui-agent.sqlite")]
    db: PathBuf,
    #[arg(long, env = "BOTHQ_A2UI_LISTEN", default_value = "127.0.0.1:8790")]
    listen: String,
    #[arg(long, env = "BOTHQ_A2UI_FEED", value_enum, default_value = "kalshi")]
    feed: FeedKind,
    /// Kalshi market ticker. Default: the resumed ticket's market, else a liquid open market.
    #[arg(long, env = "BOTHQ_A2UI_SYMBOL")]
    symbol: Option<String>,
    /// JSONL of recorded Kalshi responses (for --feed replay).
    #[arg(long, env = "BOTHQ_A2UI_REPLAY_FILE")]
    replay_file: Option<PathBuf>,
    #[arg(long, env = "BOTHQ_A2UI_POLL_MS", default_value_t = 1000)]
    poll_ms: u64,
    #[arg(long, env = "BOTHQ_A2UI_REPLAY_INTERVAL_MS", default_value_t = 1000)]
    replay_interval_ms: u64,
    #[arg(long, env = "BOTHQ_A2UI_KALSHI_BASE", default_value = feed::KALSHI_BASE)]
    kalshi_base: String,
}

#[derive(Subcommand)]
enum Cmd {
    /// Record real `GET /markets/{ticker}` responses to a replay JSONL file.
    Record {
        #[arg(long)]
        symbol: Option<String>,
        #[arg(long, default_value_t = 60)]
        count: usize,
        #[arg(long, default_value_t = 2000)]
        interval_ms: u64,
        #[arg(long)]
        out: PathBuf,
    },
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let ansi = std::io::IsTerminal::is_terminal(&std::io::stderr());
    let fmt = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).with_ansi(ansi);
    if std::env::var("BOTHQ_A2UI_LOG_FORMAT").as_deref() == Ok("json") {
        fmt.json().init();
    } else {
        fmt.init();
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    if let Some(Cmd::Record { symbol, count, interval_ms, out }) = cli.cmd {
        let client = Kalshi::new(&cli.kalshi_base)?;
        let ticker = feed::record(&client, symbol, count, Duration::from_millis(interval_ms), &out).await?;
        eprintln!("recorded {count} responses for {ticker} to {}", out.display());
        return Ok(());
    }

    let agent = Agent::open(&cli.db, Pause::from_env())?;
    let health = agent.health();
    let (events, rx) = tokio::sync::mpsc::unbounded_channel();
    let (ticks, mut tick_rx) = tokio::sync::mpsc::unbounded_channel();
    match cli.feed {
        FeedKind::Replay => {
            let Some(path) = &cli.replay_file else { bail!("--feed replay needs --replay-file") };
            let mut lines = feed::read_replay(path)?;
            if let Some(sym) = &cli.symbol {
                lines.retain(|r| r.body["market"]["ticker"] == sym.as_str());
                if lines.is_empty() {
                    bail!("{} has no responses for {sym}", path.display());
                }
            }
            tracing::info!(target: "a2ui::feed", file = %path.display(), lines = lines.len(), "replay feed");
            tokio::spawn(feed::run_replay(lines, Duration::from_millis(cli.replay_interval_ms), ticks));
        }
        FeedKind::Kalshi => {
            let client = Kalshi::new(&cli.kalshi_base)?;
            let ticker = match cli.symbol.clone().or_else(|| agent.ticket_symbol()) {
                Some(t) => t,
                None => client.pick().await?,
            };
            tracing::info!(target: "a2ui::feed", %ticker, poll_ms = cli.poll_ms, "kalshi feed");
            tokio::spawn(feed::run_kalshi(client, ticker, Duration::from_millis(cli.poll_ms), ticks));
        }
    }
    let forward = events.clone();
    tokio::spawn(async move {
        while let Some(t) = tick_rx.recv().await {
            if forward.send(Event::Tick(t)).is_err() {
                break;
            }
        }
    });
    std::thread::Builder::new().name("a2ui-agent".into()).spawn(move || agent.run(rx))?;

    let listener = tokio::net::TcpListener::bind(&cli.listen).await?;
    tracing::info!(target: "a2ui::transport", addr = %listener.local_addr()?, "listening (GET /a2ui/ws, GET /a2ui/health)");
    axum::serve(listener, router(App::new(events, health)))
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await?;
    Ok(())
}
