use anyhow::{bail, Result};
use bothq_a2ui_agent::agent::{Agent, Event, Pause};
use bothq_a2ui_agent::feed::{self, Kalshi};
use bothq_a2ui_agent::server::{router, App, EVENT_QUEUE, TOKEN_HEADER};
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
    /// Listen address. Port 0 picks a free port; the bound address is printed
    /// to stderr as `LISTENING <addr>`.
    #[arg(long, env = "BOTHQ_A2UI_LISTEN", default_value = "127.0.0.1:8790")]
    listen: String,
    /// Shared secret required in the `x-bothq-a2ui-token` header on /a2ui/ws and
    /// /a2ui/health. Required when --listen is not a loopback address.
    #[arg(long, env = "BOTHQ_A2UI_TOKEN", hide_env_values = true)]
    token: Option<String>,
    #[arg(long, env = "BOTHQ_A2UI_FEED", value_enum, default_value = "kalshi")]
    feed: FeedKind,
    /// Kalshi market ticker. Default: the resumed ticket's market, else a liquid open market.
    #[arg(long, env = "BOTHQ_A2UI_SYMBOL")]
    symbol: Option<String>,
    /// JSONL of recorded Kalshi responses (for --feed replay).
    #[arg(long, env = "BOTHQ_A2UI_REPLAY_FILE")]
    replay_file: Option<PathBuf>,
    /// Kalshi poll period (>= 1).
    #[arg(long, env = "BOTHQ_A2UI_POLL_MS", default_value_t = 1000, value_parser = clap::value_parser!(u64).range(1..))]
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

    let token = cli.token.clone().filter(|t| !t.is_empty());
    let loopback = listen_is_loopback(&cli.listen)?;
    match (&token, loopback) {
        (None, false) => bail!(
            "refusing to listen on non-loopback {} without a token: set BOTHQ_A2UI_TOKEN (or --token); \
             clients must then send it in the {TOKEN_HEADER} header",
            cli.listen
        ),
        (None, true) => tracing::warn!(target: "a2ui::transport", listen = %cli.listen,
            "BOTHQ_A2UI_TOKEN is unset: /a2ui/ws and /a2ui/health are unauthenticated (loopback dev mode only)"),
        (Some(_), _) => tracing::info!(target: "a2ui::transport", header = TOKEN_HEADER, "token auth enabled"),
    }

    let agent = Agent::open(&cli.db, Pause::from_env())?;
    let health = agent.health();
    let (events, rx) = tokio::sync::mpsc::channel(EVENT_QUEUE);
    let (ticks, mut tick_rx) = tokio::sync::mpsc::channel(16);
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
            if forward.send(Event::Tick(t)).await.is_err() {
                break;
            }
        }
    });
    // The agent is the only consumer of `rx`: if its thread panics, nothing
    // would process events while HTTP kept answering, so exit non-zero and let
    // a supervisor restart the process (the journal makes that safe).
    std::thread::Builder::new().name("a2ui-agent".into()).spawn(move || {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| agent.run(rx))).is_err() {
            tracing::error!(target: "a2ui::agent", "agent thread panicked; exiting");
            eprintln!("bothq-a2ui-agent: agent thread panicked; exiting with status 70");
            std::process::exit(70);
        }
    })?;

    let listener = tokio::net::TcpListener::bind(&cli.listen).await?;
    let addr = listener.local_addr()?;
    if !addr.ip().is_loopback() && token.is_none() {
        bail!("refusing to serve on non-loopback {addr} without BOTHQ_A2UI_TOKEN");
    }
    tracing::info!(target: "a2ui::transport", %addr, "listening (GET /a2ui/ws, GET /a2ui/health)");
    eprintln!("LISTENING {addr}");
    axum::serve(listener, router(App::new(events, health, token)))
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await?;
    Ok(())
}

/// True when every address `listen` resolves to is loopback.
fn listen_is_loopback(listen: &str) -> Result<bool> {
    use std::net::ToSocketAddrs;
    let addrs: Vec<_> = listen.to_socket_addrs().map_err(|e| anyhow::anyhow!("--listen {listen}: {e}"))?.collect();
    Ok(!addrs.is_empty() && addrs.iter().all(|a| a.ip().is_loopback()))
}
