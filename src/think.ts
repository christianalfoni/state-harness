import { z } from "zod";
import { defineTool } from "./tool.js";
import type { Tool } from "./types.js";

const DEFAULT_DESCRIPTION =
  "Think privately before acting. Use this as a scratchpad to reason through the " +
  "problem, weigh options, or plan your next steps. Your thoughts here are NOT shown " +
  "to the user. Call it whenever a step needs reasoning, then call the tools that " +
  "actually do the work.";

export interface ThinkToolOptions {
  /** Override the default description / guidance shown to the model. */
  description?: string;
}

/**
 * A reasoning scratchpad, as a tool.
 *
 * Under forced tool use the model has no native thinking channel, so this gives
 * it one: it writes its reasoning into `thoughts`, which stays in the transcript
 * for later steps but is never surfaced to the user.
 */
export function thinkTool<State = unknown>(options: ThinkToolOptions = {}): Tool<State> {
  return defineTool<z.ZodObject<{ thoughts: z.ZodString }>, State>({
    name: "think",
    description: options.description ?? DEFAULT_DESCRIPTION,
    input: z.object({
      thoughts: z.string().describe("Your private reasoning. Not shown to the user."),
    }),
    handler: () => "ok",
  });
}
