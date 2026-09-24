// Permission gate: checks every action against config/permissions.json before execution.
// No action routed L1 or L2 may execute without an approval record. BLOCK_CARD's
// route is conditional on exposure_usd, so routes are resolved, not looked up.
// Placeholder: enforcement is implemented in the orchestrator phase of build_plan.md.

export {};
