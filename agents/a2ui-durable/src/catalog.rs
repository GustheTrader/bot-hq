//! The `bothq.trading.v0` catalog: the OrderTicket component tree the agent
//! authors, and agent-side enforcement of the catalog's function rules
//! (`allowedCallers`, `requiresUserActivation`).

use crate::schema::schemas;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

pub const CATALOG_ID: &str = "bothq.trading.v0";
pub const SUBMIT_ORDER: &str = "submitOrder";
/// How old a user-activation timestamp may be when the call first arrives.
pub const ACTIVATION_MAX_AGE_SECS: i64 = 120;
/// Tolerated renderer clock lead.
pub const ACTIVATION_MAX_FUTURE_SECS: i64 = 30;

/// The single-component tree of an OrderTicket surface (CONTRACT.md).
pub fn order_ticket_components() -> Vec<Value> {
    let p = |path: &str| json!({ "@path": path });
    vec![json!({
        "id": "root",
        "component": "OrderTicket",
        "symbol": p("/ticket/symbol"),
        "side": p("/ticket/side"),
        "quantity": p("/ticket/quantity"),
        "limitPrice": p("/ticket/limitPrice"),
        "livePrice": p("/market/lastPrice"),
        "buyingPower": p("/account/buyingPower"),
        "position": p("/account/position"),
        "status": p("/ticket/status"),
        "submit": {"functionCall": {"@call": SUBMIT_ORDER, "args": {
            "symbol": p("/ticket/symbol"),
            "side": p("/ticket/side"),
            "quantity": p("/ticket/quantity"),
            "limitPrice": p("/ticket/limitPrice"),
        }}}
    })]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    Renderer,
    Agent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FunctionPolicy {
    pub allowed_callers: String,
    pub requires_user_activation: bool,
}

/// The catalog's declared rules for `name`, with the schema defaults
/// (`allowedCallers: rendererOnly`, `requiresUserActivation: false`).
pub fn function_policy(name: &str) -> Option<FunctionPolicy> {
    let def = schemas().catalog.get("functions")?.get(name)?;
    Some(FunctionPolicy {
        allowed_callers: def["allowedCallers"].as_str().unwrap_or("rendererOnly").to_owned(),
        requires_user_activation: def["requiresUserActivation"].as_bool().unwrap_or(false),
    })
}

/// A function-call rejection, sent back as `agentFunctionResponse.error`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FnError {
    pub code: &'static str,
    pub message: String,
}

impl FnError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// Enforces the catalog's caller and user-activation rules for one call.
///
/// User activation over a WebSocket cannot be observed by the agent, so the
/// renderer attaches what it saw of the DOM event that fired the call
/// (`args.userActivation = {type, isTrusted, timestamp}`, see CONTRACT.md). The
/// agent requires it to be present, `isTrusted: true`, and recent.
///
/// This is client-supplied evidence, not proof of a real click: any client
/// that can reach the socket can write these fields. It is a hint that stops
/// accidental calls (agent-originated ones, or a renderer path that fires
/// without a user event) and re-sent stale frames. It does not stop a client
/// that fabricates fresh evidence, and a re-sent call under a new
/// `functionCallId` within the window passes it. Access to the socket is
/// controlled by the transport token (`BOTHQ_A2UI_TOKEN`), not by this check.
pub fn authorize(
    caller: Caller,
    name: &str,
    args: &Value,
    now: DateTime<Utc>,
) -> Result<FunctionPolicy, FnError> {
    let policy = function_policy(name)
        .ok_or_else(|| FnError::new("UNKNOWN_FUNCTION", format!("{name} is not in {CATALOG_ID}")))?;
    let allowed = matches!(
        (caller, policy.allowed_callers.as_str()),
        (Caller::Renderer, "rendererOnly" | "rendererOrAgent") | (Caller::Agent, "agentOnly" | "rendererOrAgent")
    );
    if !allowed {
        return Err(FnError::new(
            "CALLER_NOT_ALLOWED",
            format!("{name} allows {} callers only", policy.allowed_callers),
        ));
    }
    if policy.requires_user_activation {
        let ua = args
            .get("userActivation")
            .ok_or_else(|| FnError::new("USER_ACTIVATION_REQUIRED", format!("{name} requires a user activation (args.userActivation)")))?;
        if ua["isTrusted"].as_bool() != Some(true) {
            return Err(FnError::new("USER_ACTIVATION_REQUIRED", "user activation is not a trusted event"));
        }
        let at = ua["timestamp"]
            .as_str()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .ok_or_else(|| FnError::new("USER_ACTIVATION_REQUIRED", "user activation timestamp is not RFC 3339"))?;
        // Full-precision comparison: no truncation to whole seconds.
        let age = now.signed_duration_since(at.with_timezone(&Utc));
        if age > chrono::Duration::seconds(ACTIVATION_MAX_AGE_SECS) || age < -chrono::Duration::seconds(ACTIVATION_MAX_FUTURE_SECS) {
            return Err(FnError::new(
                "USER_ACTIVATION_REQUIRED",
                format!(
                    "user activation is {:.3}s old (allowed -{ACTIVATION_MAX_FUTURE_SECS}..{ACTIVATION_MAX_AGE_SECS}s)",
                    age.num_milliseconds() as f64 / 1000.0
                ),
            ));
        }
    }
    Ok(policy)
}
