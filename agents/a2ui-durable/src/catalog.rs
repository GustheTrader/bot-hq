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
/// renderer must attach evidence of the trusted DOM event that fired the call
/// (`args.userActivation = {type, isTrusted, timestamp}`, see CONTRACT.md). The
/// agent requires it to be present, `isTrusted: true`, and recent. This is
/// renderer-asserted evidence: it stops agent-originated, scripted-replay and
/// programmatic calls that follow the contract, not a compromised renderer.
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
        let age = now.signed_duration_since(at.with_timezone(&Utc)).num_seconds();
        if !(-ACTIVATION_MAX_FUTURE_SECS..=ACTIVATION_MAX_AGE_SECS).contains(&age) {
            return Err(FnError::new(
                "USER_ACTIVATION_REQUIRED",
                format!("user activation is {age}s old (allowed -{ACTIVATION_MAX_FUTURE_SECS}..{ACTIVATION_MAX_AGE_SECS}s)"),
            ));
        }
    }
    Ok(policy)
}
