// T6.2 — Pipeline version marker. Bump whenever topology generation semantics
// change: graph_cache rows and dedup lookups are scoped to this version, so
// topologies produced by an older pipeline can never be served to clients.
export const PIPELINE_VERSION = "fidelity-v3";
