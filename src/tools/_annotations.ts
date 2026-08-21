/**
 * MCP tool annotations.
 *
 * `readOnlyHint` is stated explicitly on every constant, including the write ones. The read-only
 * filter derives from it, and `undefined` would make "this tool does not write" and "nobody said"
 * indistinguishable — which is the ambiguity that let ten read-only tools be dropped when the filter
 * inferred safety from the tool's name instead.
 */

export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
  idempotentHint: true,
} as const;

export const WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true } as const;
export const UPDATE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, idempotentHint: true } as const;
export const DELETE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;

/** Every annotation set a tool may carry. `defineTool` requires one, so tsc rejects an unannotated tool. */
export type ToolAnnotations =
  | typeof READ_ANNOTATIONS
  | typeof WRITE_ANNOTATIONS
  | typeof UPDATE_ANNOTATIONS
  | typeof DELETE_ANNOTATIONS;
