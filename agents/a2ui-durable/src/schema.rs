//! Official A2UI v1.0 JSON Schema validation (Draft 2020-12, `jsonschema` crate).
//!
//! The envelope `agent_to_renderer.json` refers to its catalog by the relative
//! reference `catalog.json#/$defs/anyComponent`, and `common_types.json` reaches
//! functions through `catalog.json#/$defs/anyFunction`. We register our custom
//! catalog (`bothq.trading.v0`) under that sibling URI, in place of the basic
//! catalog, so `OrderTicket` and `submitOrder` validate. All documents are
//! compiled into the binary; no network or filesystem retrieval is possible.

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::sync::OnceLock;

pub const AGENT_TO_RENDERER: &str = include_str!("../schemas/v1_0/agent_to_renderer.json");
pub const RENDERER_TO_AGENT: &str = include_str!("../schemas/v1_0/renderer_to_agent.json");
pub const COMMON_TYPES: &str = include_str!("../schemas/v1_0/common_types.json");
pub const CATALOG_DEFINITION: &str = include_str!("../schemas/v1_0/catalog_definition.json");
pub const CATALOG: &str = include_str!("../catalog/bothq.trading.v0.json");

/// Where the envelope looks for its catalog (sibling of agent_to_renderer.json).
pub const CATALOG_URI: &str = "https://a2ui.org/specification/v1_0/catalog.json";

#[derive(Debug)]
struct NoRetrieval;
impl jsonschema::Retrieve for NoRetrieval {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<String>,
    ) -> std::result::Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err(format!("unregistered schema resource {uri} (retrieval disabled)").into())
    }
}

pub struct Schemas {
    outbound: jsonschema::Validator,
    inbound: jsonschema::Validator,
    catalog_definition: jsonschema::Validator,
    pub catalog: Value,
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("bundled schema is valid JSON")
}

fn id_of(doc: &Value) -> Result<String> {
    doc["$id"].as_str().map(str::to_owned).ok_or_else(|| anyhow!("schema has no $id"))
}

impl Schemas {
    pub fn load() -> Result<Self> {
        let a2r = parse(AGENT_TO_RENDERER);
        let r2a = parse(RENDERER_TO_AGENT);
        let common = parse(COMMON_TYPES);
        let def = parse(CATALOG_DEFINITION);
        let catalog = parse(CATALOG);
        let docs = [
            (id_of(&a2r)?, a2r.clone()),
            (id_of(&r2a)?, r2a.clone()),
            (id_of(&common)?, common),
            (id_of(&def)?, def.clone()),
            (CATALOG_URI.to_owned(), catalog.clone()),
        ];
        let registry = jsonschema::Registry::new()
            .retriever(NoRetrieval)
            .extend(docs.iter().map(|(id, d)| (id.as_str(), jsonschema::Resource::from_contents(d.clone()))))
            .and_then(jsonschema::RegistryBuilder::prepare)
            .map_err(|e| anyhow!("schema registry: {e}"))?;
        let build = |schema: &Value| {
            jsonschema::options()
                .with_draft(jsonschema::Draft::Draft202012)
                .should_validate_formats(true)
                .with_retriever(NoRetrieval)
                .with_registry(&registry)
                .build(schema)
                .map_err(|e| anyhow!("compile schema: {e}"))
        };
        let schemas = Self {
            outbound: build(&a2r).context("agent_to_renderer.json")?,
            inbound: build(&r2a).context("renderer_to_agent.json")?,
            catalog_definition: build(&def).context("catalog_definition.json")?,
            catalog,
        };
        schemas
            .validate_catalog(&schemas.catalog)
            .map_err(|e| anyhow!("catalog/bothq.trading.v0.json does not conform to catalog_definition.json: {e}"))?;
        Ok(schemas)
    }

    pub fn validate_outbound(&self, msg: &Value) -> Result<(), String> {
        collect(&self.outbound, msg)
    }
    pub fn validate_inbound(&self, msg: &Value) -> Result<(), String> {
        collect(&self.inbound, msg)
    }
    pub fn validate_catalog(&self, catalog: &Value) -> Result<(), String> {
        collect(&self.catalog_definition, catalog)
    }
}

fn collect(v: &jsonschema::Validator, instance: &Value) -> Result<(), String> {
    let errors: Vec<String> = v
        .iter_errors(instance)
        .take(8)
        .map(|e| format!("{}: {}", e.instance_path(), e))
        .collect();
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

/// Process-wide compiled schemas (compiled once; compile errors are fatal).
pub fn schemas() -> &'static Schemas {
    static S: OnceLock<Schemas> = OnceLock::new();
    S.get_or_init(|| Schemas::load().expect("bundled A2UI schemas compile"))
}
