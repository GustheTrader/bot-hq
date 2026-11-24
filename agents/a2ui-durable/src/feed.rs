//! Real price feeds only: the public Kalshi REST API (no key), or a replay of
//! responses recorded from it. Nothing here invents a price.

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::Path;
use std::time::{Duration, Instant};

pub const KALSHI_BASE: &str = "https://api.elections.kalshi.com/trade-api/v2";

/// One observation of a Kalshi market's YES top of book.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub ticker: String,
    pub status: String,
    pub bid: f64,
    pub ask: f64,
    pub bid_size: f64,
    pub ask_size: f64,
    pub last_trade: f64,
    /// When the exchange data was observed (live: now; replay: when recorded).
    pub as_of: DateTime<Utc>,
    /// When this process received it (staleness is judged on this).
    pub observed_at: DateTime<Utc>,
    pub source: String,
}

impl Quote {
    /// Same market state (ignores observation times).
    pub fn same_book(&self, o: &Quote) -> bool {
        (self.ticker.as_str(), self.status.as_str(), self.bid, self.ask, self.bid_size, self.ask_size, self.last_trade)
            == (o.ticker.as_str(), o.status.as_str(), o.bid, o.ask, o.bid_size, o.ask_size, o.last_trade)
    }
    pub fn two_sided(&self) -> bool {
        self.bid > 0.0 && self.ask > self.bid && self.ask < 1.0
    }
    /// YES mid when two-sided, else the last trade.
    pub fn display_price(&self) -> f64 {
        if self.two_sided() { round4((self.bid + self.ask) / 2.0) } else { self.last_trade }
    }
    /// The `/market` data-model object (display values only).
    pub fn market_model(&self) -> Value {
        json!({
            "lastPrice": self.display_price(), "bid": self.bid, "ask": self.ask,
            "asOf": self.as_of.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "source": self.source,
        })
    }
}

pub fn round4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

fn dollars(m: &Value, key: &str) -> Result<f64> {
    match &m[key] {
        Value::String(s) => s.trim().parse::<f64>().map(round4).with_context(|| format!("{key}={s:?}")),
        Value::Null => Ok(0.0),
        other => bail!("{key} is not a *_dollars/_fp string: {other}"),
    }
}

/// Parses a `GET /markets/{ticker}` body (prices are `*_dollars` strings).
pub fn parse_market(body: &Value, as_of: DateTime<Utc>, source: &str) -> Result<Quote> {
    let m = body.get("market").ok_or_else(|| anyhow!("response has no `market`"))?;
    Ok(Quote {
        ticker: m["ticker"].as_str().ok_or_else(|| anyhow!("market has no ticker"))?.to_owned(),
        status: m["status"].as_str().unwrap_or("unknown").to_owned(),
        bid: dollars(m, "yes_bid_dollars")?,
        ask: dollars(m, "yes_ask_dollars")?,
        bid_size: dollars(m, "yes_bid_size_fp")?,
        ask_size: dollars(m, "yes_ask_size_fp")?,
        last_trade: dollars(m, "last_price_dollars")?,
        as_of,
        observed_at: Utc::now(),
        source: source.to_owned(),
    })
}

/// Chooses a currently tradable, liquid binary market from a
/// `GET /markets?status=open` page: two-sided, closing in more than an hour,
/// highest 24h volume.
pub fn pick_market(page: &Value, now: DateTime<Utc>) -> Option<String> {
    let markets = page["markets"].as_array()?;
    markets
        .iter()
        .filter(|m| m["status"] == "active" && m["market_type"] == "binary")
        .filter(|m| {
            let (b, a) = (dollars(m, "yes_bid_dollars").unwrap_or(0.0), dollars(m, "yes_ask_dollars").unwrap_or(0.0));
            b > 0.0 && a > b && a < 1.0
        })
        .filter(|m| {
            m["close_time"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                .is_some_and(|t| t.with_timezone(&Utc) > now + chrono::Duration::hours(1))
        })
        .max_by(|x, y| {
            let v = |m: &Value| dollars(m, "volume_24h_fp").unwrap_or(0.0);
            v(x).total_cmp(&v(y))
        })
        .and_then(|m| m["ticker"].as_str().map(str::to_owned))
}

pub struct Kalshi {
    http: reqwest::Client,
    base: String,
}

impl Kalshi {
    pub fn new(base: &str) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("bothq-a2ui-agent/0.1")
            .build()?;
        Ok(Self { http, base: base.trim_end_matches('/').to_owned() })
    }

    /// GET with a few retries (this API occasionally resets connections).
    pub async fn get(&self, path_and_query: &str) -> Result<Value> {
        let url = format!("{}{}", self.base, path_and_query);
        let mut last = None;
        for attempt in 0..4u64 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(250 * attempt)).await;
            }
            match self.http.get(&url).send().await {
                Ok(r) if r.status().is_success() => return Ok(r.json().await?),
                Ok(r) => last = Some(anyhow!("GET {url}: HTTP {}", r.status())),
                Err(e) => last = Some(anyhow!("GET {url}: {e}")),
            }
        }
        Err(last.unwrap())
    }

    pub async fn market(&self, ticker: &str) -> Result<Value> {
        self.get(&format!("/markets/{ticker}")).await
    }

    pub async fn pick(&self) -> Result<String> {
        let page = self.get("/markets?status=open&limit=1000&mve_filter=exclude").await?;
        pick_market(&page, Utc::now()).ok_or_else(|| anyhow!("no open, two-sided market found on Kalshi"))
    }
}

/// One recorded response line of a replay file.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recorded {
    pub received_at: DateTime<Utc>,
    pub request: String,
    pub body: Value,
}

pub fn read_replay(path: &Path) -> Result<Vec<Recorded>> {
    let file = std::fs::File::open(path).with_context(|| format!("open replay {}", path.display()))?;
    let mut out = Vec::new();
    for (n, line) in std::io::BufReader::new(file).lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        out.push(serde_json::from_str(&line).with_context(|| format!("{}:{}", path.display(), n + 1))?);
    }
    if out.is_empty() {
        bail!("replay file {} is empty", path.display());
    }
    Ok(out)
}

/// A feed tick handed to the agent, with the local receive instant for latency.
pub struct Tick {
    pub quote: Quote,
    pub received: Instant,
}

pub async fn run_kalshi(client: Kalshi, ticker: String, every: Duration, tx: tokio::sync::mpsc::UnboundedSender<Tick>) {
    let mut interval = tokio::time::interval(every);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let started = Instant::now();
        match client.market(&ticker).await.and_then(|b| parse_market(&b, Utc::now(), "kalshi")) {
            Ok(quote) => {
                tracing::debug!(target: "a2ui::feed", ticker = %quote.ticker, bid = quote.bid, ask = quote.ask, http_ms = started.elapsed().as_millis() as u64, "kalshi quote");
                if tx.send(Tick { quote, received: Instant::now() }).is_err() {
                    return;
                }
            }
            Err(e) => tracing::warn!(target: "a2ui::feed", error = %e, "kalshi poll failed"),
        }
    }
}

pub async fn run_replay(lines: Vec<Recorded>, every: Duration, tx: tokio::sync::mpsc::UnboundedSender<Tick>) {
    for rec in lines.iter().filter(|r| r.body.get("market").is_some()) {
        match parse_market(&rec.body, rec.received_at, "kalshi-replay") {
            Ok(quote) => {
                if tx.send(Tick { quote, received: Instant::now() }).is_err() {
                    return;
                }
            }
            Err(e) => tracing::warn!(target: "a2ui::feed", error = %e, "bad replay line"),
        }
        tokio::time::sleep(every).await;
    }
    tracing::info!(target: "a2ui::feed", "replay finished; holding the last quote");
}

/// Records `count` real `GET /markets/{ticker}` responses to a JSONL file.
pub async fn record(client: &Kalshi, ticker: Option<String>, count: usize, every: Duration, out: &Path) -> Result<String> {
    let ticker = match ticker {
        Some(t) => t,
        None => client.pick().await?,
    };
    let mut file = std::fs::File::create(out).with_context(|| format!("create {}", out.display()))?;
    for i in 0..count {
        if i > 0 {
            tokio::time::sleep(every).await;
        }
        let request = format!("GET /markets/{ticker}");
        let body = client.market(&ticker).await?;
        let rec = Recorded { received_at: Utc::now(), request, body };
        writeln!(file, "{}", serde_json::to_string(&rec)?)?;
        let q = parse_market(&rec.body, rec.received_at, "kalshi")?;
        eprintln!("[{}/{count}] {} bid={} ask={} last={} status={}", i + 1, q.ticker, q.bid, q.ask, q.last_trade, q.status);
    }
    Ok(ticker)
}
