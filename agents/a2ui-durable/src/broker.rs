//! Paper order adapter (FR-6). The only execution venue in this crate.
//!
//! Orders live in `paper_orders` in the agent's SQLite file, with a UNIQUE
//! `idempotency_key` = `<sessionId>:<frameSequence>`. Placing an order whose
//! key exists returns the stored order and `duplicate = true`; nothing is
//! inserted twice, whatever replays.
//!
//! Fill rule (immediate-or-cancel against the last real Kalshi quote):
//! - the quote must be for the order's ticker, `active`, and observed by this
//!   process within `STALE_QUOTE_SECS`;
//! - buy is marketable when `limit >= yes_ask`; it fills at the ask;
//!   sell is marketable when `limit <= yes_bid`; it fills at the bid;
//! - filled quantity = min(quantity, displayed size at that price, floored);
//!   any remainder is cancelled (no resting orders, no queue modelling,
//!   no fees, no market impact);
//! - buys need `filled * price <= buyingPower`; sells are long-only
//!   (`filled <= position`);
//! - anything else is rejected with a reason.

use crate::feed::{round4, Quote};
use anyhow::Result;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[cfg(feature = "live-routing")]
compile_error!("live-routing is not implemented: real order routing is gated on the live-trading readiness review (docs/a2ui/FOLLOW-UP-BACKLOG.md B13)");

pub const PAPER_STARTING_BUYING_POWER: f64 = 1000.0;
pub const STALE_QUOTE_SECS: i64 = 30;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderRequest {
    pub symbol: String,
    pub side: String,
    pub quantity: i64,
    pub limit_price: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub order_id: String,
    pub idempotency_key: String,
    pub symbol: String,
    pub side: String,
    pub quantity: i64,
    pub limit_price: f64,
    /// "filled" | "partially_filled" | "rejected"
    pub state: String,
    pub filled_qty: i64,
    pub avg_price: Option<f64>,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub buying_power: f64,
    pub position: i64,
}

pub struct PaperBroker {
    conn: Connection,
    /// Internal paper account id. Server-side only; never put in a client frame.
    account_id: String,
}

impl PaperBroker {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS paper_account (
                 account_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS paper_orders (
                 order_id TEXT PRIMARY KEY,
                 idempotency_key TEXT NOT NULL,
                 account_id TEXT NOT NULL,
                 function_call_id TEXT NOT NULL,
                 symbol TEXT NOT NULL, side TEXT NOT NULL,
                 quantity INTEGER NOT NULL, limit_price REAL NOT NULL,
                 state TEXT NOT NULL, filled_qty INTEGER NOT NULL,
                 avg_price REAL, reason TEXT NOT NULL,
                 quote_json TEXT, created_at TEXT NOT NULL);
             CREATE UNIQUE INDEX IF NOT EXISTS paper_orders_idempotency_key
                 ON paper_orders(idempotency_key);",
        )?;
        let existing: Option<String> =
            conn.query_row("SELECT account_id FROM paper_account LIMIT 1", [], |r| r.get(0)).optional()?;
        let account_id = match existing {
            Some(id) => id,
            None => {
                let id = format!("paper-acct-{}", uuid::Uuid::new_v4());
                conn.execute("INSERT INTO paper_account VALUES (?1, ?2)", params![id, Utc::now().to_rfc3339()])?;
                id
            }
        };
        Ok(Self { conn, account_id })
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn synchronous(&self) -> Result<i64> {
        Ok(self.conn.query_row("PRAGMA synchronous", [], |r| r.get(0))?)
    }

    pub fn count(&self) -> Result<u64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM paper_orders", [], |r| r.get::<_, i64>(0))? as u64)
    }

    pub fn get(&self, key: &str) -> Result<Option<Order>> {
        Ok(self
            .conn
            .query_row(
                "SELECT order_id, idempotency_key, symbol, side, quantity, limit_price, state, filled_qty, avg_price, reason
                 FROM paper_orders WHERE idempotency_key = ?1",
                [key],
                |r| {
                    Ok(Order {
                        order_id: r.get(0)?, idempotency_key: r.get(1)?, symbol: r.get(2)?, side: r.get(3)?,
                        quantity: r.get(4)?, limit_price: r.get(5)?, state: r.get(6)?, filled_qty: r.get(7)?,
                        avg_price: r.get(8)?, reason: r.get(9)?,
                    })
                },
            )
            .optional()?)
    }

    /// Paper account derived from filled orders. `position` is for `symbol`.
    pub fn account(&self, symbol: &str) -> Result<Account> {
        let (spent, received): (f64, f64) = self.conn.query_row(
            "SELECT COALESCE(SUM(CASE WHEN side='buy' THEN filled_qty*avg_price END),0),
                    COALESCE(SUM(CASE WHEN side='sell' THEN filled_qty*avg_price END),0)
             FROM paper_orders WHERE account_id=?1 AND filled_qty > 0",
            [&self.account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let position: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(CASE WHEN side='buy' THEN filled_qty ELSE -filled_qty END),0)
             FROM paper_orders WHERE account_id=?1 AND symbol=?2 AND filled_qty > 0",
            params![self.account_id, symbol],
            |r| r.get(0),
        )?;
        Ok(Account { buying_power: round4(PAPER_STARTING_BUYING_POWER - spent + received), position })
    }

    /// Places (or finds) the order for `key`. Returns `(order, duplicate)`.
    pub fn place(
        &mut self,
        key: &str,
        function_call_id: &str,
        req: &OrderRequest,
        quote: Option<&Quote>,
        now: DateTime<Utc>,
    ) -> Result<(Order, bool)> {
        if let Some(existing) = self.get(key)? {
            return Ok((existing, true));
        }
        let account = self.account(&req.symbol)?;
        let (state, filled_qty, avg_price, reason) = fill(req, quote, account, now);
        let order = Order {
            order_id: format!("paper-{}", uuid::Uuid::new_v4()),
            idempotency_key: key.to_owned(),
            symbol: req.symbol.clone(),
            side: req.side.clone(),
            quantity: req.quantity,
            limit_price: req.limit_price,
            state: state.into(),
            filled_qty,
            avg_price,
            reason,
        };
        let inserted = self.conn.execute(
            "INSERT INTO paper_orders (order_id, idempotency_key, account_id, function_call_id, symbol, side, quantity,
                 limit_price, state, filled_qty, avg_price, reason, quote_json, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(idempotency_key) DO NOTHING",
            params![
                order.order_id, key, self.account_id, function_call_id, order.symbol, order.side, order.quantity,
                order.limit_price, order.state, order.filled_qty, order.avg_price, order.reason,
                quote.map(|q| serde_json::to_string(q).unwrap_or_default()), now.to_rfc3339()
            ],
        )?;
        if inserted == 0 {
            // Another writer won the UNIQUE key between our read and insert.
            return Ok((self.get(key)?.expect("row exists after conflict"), true));
        }
        tracing::info!(target: "a2ui::orders", order_id = %order.order_id, key, state = %order.state,
            filled = order.filled_qty, avg_price = ?order.avg_price, "paper order placed");
        Ok((order, false))
    }
}

/// The paper fill rule (see module docs). Returns (state, filled, avg, reason).
pub fn fill(req: &OrderRequest, quote: Option<&Quote>, acct: Account, now: DateTime<Utc>) -> (&'static str, i64, Option<f64>, String) {
    let reject = |why: String| ("rejected", 0, None, why);
    let Some(q) = quote.filter(|q| q.ticker == req.symbol) else {
        return reject(format!("no quote for {}", req.symbol));
    };
    let age = now.signed_duration_since(q.observed_at).num_seconds();
    if age > STALE_QUOTE_SECS {
        return reject(format!("quote is {age}s old (max {STALE_QUOTE_SECS}s)"));
    }
    if q.status != "active" {
        return reject(format!("market is {}", q.status));
    }
    let (px, size) = match req.side.as_str() {
        "buy" if q.ask > 0.0 && q.ask < 1.0 && req.limit_price + 1e-9 >= q.ask => (q.ask, q.ask_size),
        "sell" if q.bid > 0.0 && req.limit_price <= q.bid + 1e-9 => (q.bid, q.bid_size),
        "buy" => return reject(format!("not marketable: limit {:.2} < ask {:.2} (IOC)", req.limit_price, q.ask)),
        _ => return reject(format!("not marketable: limit {:.2} > bid {:.2} (IOC)", req.limit_price, q.bid)),
    };
    let mut filled = req.quantity.min(size.floor() as i64);
    if filled <= 0 {
        return reject(format!("displayed size {size} at {px:.2} is below one whole contract"));
    }
    if req.side == "buy" && filled as f64 * px > acct.buying_power + 1e-9 {
        return reject(format!("insufficient paper buying power ({:.2})", acct.buying_power));
    }
    if req.side == "sell" {
        if acct.position <= 0 {
            return reject("no position to sell (paper account is long-only)".into());
        }
        filled = filled.min(acct.position);
    }
    if filled < req.quantity {
        ("partially_filled", filled, Some(px), format!("filled {filled} of {} at {px:.2}; remainder cancelled (IOC)", req.quantity))
    } else {
        ("filled", filled, Some(px), format!("filled {filled} at {px:.2}"))
    }
}
