import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool, ToolContext } from "./types.js";

export interface ToolDefinition<Schema extends z.ZodType, State> {
  /** Unique tool name the model calls. Keep it specific: `run_tests`, not `test`. */
  name: string;
  /**
   * What the tool does and — importantly — *when* to use it. The model relies
   * on this to decide whether to call it.
   */
  description: string;
  /** Zod schema for the input. Drives both validation and the JSON Schema. */
  input: Schema;
  /**
   * Mark this tool as terminal: running it ends the session and its return
   * value becomes the run result.
   */
  final?: boolean;
  handler: (
    input: z.infer<Schema>,
    ctx: ToolContext<State>,
  ) => unknown | Promise<unknown>;
}

/**
 * Define an effect tool. Input type is inferred from the Zod schema, so handlers
 * are fully typed:
 *
 * ```ts
 * const runTests = defineTool({
 *   name: "run_tests",
 *   description: "Run the test suite.",
 *   input: z.object({ path: z.string() }),
 *   handler: ({ path }, ctx) => exec(`npm test ${path}`),
 * });
 * ```
 */
export function defineTool<Schema extends z.ZodType, State = unknown>(
  def: ToolDefinition<Schema, State>,
): Tool<State> {
  const jsonSchema = zodToJsonSchema(def.input, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  // Providers want a bare schema object, not a $schema-wrapped document.
  delete jsonSchema.$schema;

  return {
    name: def.name,
    description: def.description,
    inputSchema: def.input,
    jsonSchema,
    final: def.final ?? false,
    handler: def.handler as Tool<State>["handler"],
  };
}
