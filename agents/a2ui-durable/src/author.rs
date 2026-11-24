//! A2UI v1.0 authoring layer behind one trait (ADR-001), so the hand-rolled
//! emitter can be swapped for a crate later without touching the agent.

use crate::catalog::FnError;
use serde_json::{json, Value};

pub const VERSION: &str = "1.0";

/// Builds agent_to_renderer messages. Implementations must emit messages that
/// validate against `schemas/v1_0/agent_to_renderer.json` with our catalog.
pub trait A2uiAuthoring: Send {
    fn create_surface(&self, surface_id: &str, catalog_id: &str, components: &[Value], data_model: &Value) -> Value;
    fn update_components(&self, surface_id: &str, components: &[Value]) -> Value;
    fn update_data_model(&self, surface_id: &str, path: &str, value: Value) -> Value;
    fn delete_surface(&self, surface_id: &str) -> Value;
    fn function_response(&self, function_call_id: &str, result: Result<Value, FnError>) -> Value;
}

/// Hand-rolled serde_json emitter (the Day-1 spike outcome).
#[derive(Default, Clone, Copy)]
pub struct JsonAuthor;

impl A2uiAuthoring for JsonAuthor {
    fn create_surface(&self, surface_id: &str, catalog_id: &str, components: &[Value], data_model: &Value) -> Value {
        json!({"version": VERSION, "createSurface": {
            "surfaceId": surface_id, "catalogId": catalog_id,
            "components": components, "dataModel": data_model
        }})
    }
    fn update_components(&self, surface_id: &str, components: &[Value]) -> Value {
        json!({"version": VERSION, "updateComponents": {"surfaceId": surface_id, "components": components}})
    }
    fn update_data_model(&self, surface_id: &str, path: &str, value: Value) -> Value {
        json!({"version": VERSION, "updateDataModel": {"surfaceId": surface_id, "path": path, "value": value}})
    }
    fn delete_surface(&self, surface_id: &str) -> Value {
        json!({"version": VERSION, "deleteSurface": {"surfaceId": surface_id}})
    }
    fn function_response(&self, function_call_id: &str, result: Result<Value, FnError>) -> Value {
        let body = match result {
            Ok(value) => json!({"functionCallId": function_call_id, "value": value}),
            Err(e) => json!({"functionCallId": function_call_id, "error": {"code": e.code, "message": e.message}}),
        };
        json!({"version": VERSION, "agentFunctionResponse": body})
    }
}

/// Applies one agent_to_renderer message to a surface store. This is the
/// single fold used both live and when replaying the journal, so a resumed
/// store is exactly what was committed.
pub fn apply_to_store(store: &mut std::collections::BTreeMap<String, Surface>, msg: &Value) {
    if let Some(c) = msg.get("createSurface") {
        let id = c["surfaceId"].as_str().unwrap_or_default().to_owned();
        store.insert(id, Surface {
            catalog_id: c["catalogId"].as_str().unwrap_or_default().to_owned(),
            components: c["components"].as_array().cloned().unwrap_or_default(),
            data_model: c.get("dataModel").cloned().unwrap_or_else(|| json!({})),
        });
    } else if let Some(u) = msg.get("updateComponents") {
        if let Some(s) = u["surfaceId"].as_str().and_then(|id| store.get_mut(id)) {
            for comp in u["components"].as_array().into_iter().flatten() {
                match s.components.iter_mut().find(|c| c["id"] == comp["id"]) {
                    Some(slot) => *slot = comp.clone(),
                    None => s.components.push(comp.clone()),
                }
            }
        }
    } else if let Some(u) = msg.get("updateDataModel") {
        if let Some(s) = u["surfaceId"].as_str().and_then(|id| store.get_mut(id)) {
            set_pointer(&mut s.data_model, u["path"].as_str().unwrap_or("/"), u["value"].clone());
        }
    } else if let Some(d) = msg.get("deleteSurface") {
        if let Some(id) = d["surfaceId"].as_str() {
            store.remove(id);
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Surface {
    pub catalog_id: String,
    pub components: Vec<Value>,
    pub data_model: Value,
}

/// A2UI updateDataModel semantics on a JSON Pointer: "/" or "" replaces the
/// root, `null` deletes the key, missing parents are created as objects.
pub fn set_pointer(root: &mut Value, path: &str, value: Value) {
    let tokens: Vec<String> = path
        .split('/')
        .skip(1)
        .filter(|t| !t.is_empty())
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect();
    let Some((last, parents)) = tokens.split_last() else {
        *root = value;
        return;
    };
    let mut node = root;
    for t in parents {
        if !node.is_object() {
            *node = json!({});
        }
        node = node.as_object_mut().unwrap().entry(t.clone()).or_insert_with(|| json!({}));
    }
    if !node.is_object() {
        *node = json!({});
    }
    let obj = node.as_object_mut().unwrap();
    if value.is_null() {
        obj.remove(last);
    } else {
        obj.insert(last.clone(), value);
    }
}
