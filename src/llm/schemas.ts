// JSON schemas for every structured LLM output (docs/architecture.md section 3.4,
// agent.md section 6). Every LLM response is validated against its schema; on
// failure, retry once with a correction instruction, then throw and log the raw response.
// Placeholder: schemas are written in the LLM-layer phase of build_plan.md.

export {};
