//! The durable journal: rpi-durable's `DurableService<SqliteBackend>`, with
//! the database put into WAL mode and synchronous=FULL verified.
//!
//! `SqliteBackend::open` owns a private connection and sets no pragmas.
//! `journal_mode=WAL` is persistent (stored in the database header), so we set
//! it on our own connection before the backend opens the file. `synchronous` is
//! per-connection and cannot be set on the backend's connection from outside;
//! bundled SQLite (libsqlite3-sys 0.28, SQLite 3.45.0, the only SQLite in this
//! binary because the crate `links = "sqlite3"`) is compiled with
//! SQLITE_DEFAULT_SYNCHRONOUS=2 (FULL) and SQLITE_DEFAULT_WAL_SYNCHRONOUS
//! defaulting to it. `prepare_sqlite` proves that on a fresh connection, which
//! has exactly the backend connection's defaults, and refuses to start
//! otherwise.

use anyhow::{bail, Context, Result};
use rpi_durable::runtime::DurableService;
use rpi_durable::storage::sqlite::SqliteBackend;
use rpi_durable::storage::{JournalFrame, JournalMutation};
use rusqlite::Connection;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const SYNCHRONOUS_FULL: i64 = 2;

pub struct Journal {
    service: DurableService<SqliteBackend>,
    path: PathBuf,
}

/// Puts the database in WAL mode and checks that an unconfigured connection
/// (what `SqliteBackend` uses) runs with synchronous=FULL.
pub fn prepare_sqlite(path: &Path) -> Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let conn = Connection::open(path)?;
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        bail!("could not enable WAL on {} (journal_mode={mode})", path.display());
    }
    let (mode, sync) = pragmas(path)?;
    if mode != "wal" || sync != SYNCHRONOUS_FULL {
        bail!("{}: journal_mode={mode} synchronous={sync}; need wal and FULL(2)", path.display());
    }
    Ok(())
}

/// `(journal_mode, synchronous)` as seen by a fresh, unconfigured connection.
pub fn pragmas(path: &Path) -> Result<(String, i64)> {
    let conn = Connection::open(path)?;
    let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    let sync: i64 = conn.query_row("PRAGMA synchronous", [], |r| r.get(0))?;
    Ok((mode.to_ascii_lowercase(), sync))
}

impl Journal {
    /// Opens (or creates) the journal and returns every committed frame.
    pub fn open(path: &Path) -> Result<(Self, Vec<JournalFrame>)> {
        prepare_sqlite(path)?;
        let backend = SqliteBackend::open(path).map_err(|e| anyhow::anyhow!("open journal: {e}"))?;
        let mut service = DurableService::open(backend).map_err(|e| anyhow::anyhow!("open journal: {e}"))?;
        let frames = service.load().map_err(|e| anyhow::anyhow!("load journal: {e}"))?;
        Ok((Self { service, path: path.to_owned() }, frames))
    }

    /// Commits one frame (an IMMEDIATE SQLite transaction) and returns it.
    pub fn commit(&mut self, kind: &str, payload: Value) -> Result<JournalFrame> {
        let mutation = JournalMutation { timestamp: chrono::Utc::now().timestamp_millis(), kind: kind.into(), payload };
        let frame = self.service.append(mutation).map_err(|e| anyhow::anyhow!("journal append {kind}: {e}"))?;
        tracing::info!(target: "a2ui::journal", seq = frame.sequence, kind = %frame.kind, "frame committed");
        Ok(frame)
    }

    pub fn head(&self) -> u64 {
        self.service.expected_sequence().unwrap_or(0)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}
