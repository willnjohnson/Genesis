// Kept in sync with the backend default (venice.rs's DEFAULT_VENICE_MODEL / schema.rs's
// "venice_model" seed value). Venice renames/deprecates models over time (e.g. "GLM 5.1" vs
// "GLM 5.2"), which is exactly why this is a free-text field rather than a hardcoded dropdown —
// the user can switch models the moment Venice changes its lineup, without waiting on an app
// update.
export const DEFAULT_VENICE_MODEL = "zai-org-glm-5";
