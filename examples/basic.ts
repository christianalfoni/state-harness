import { z } from "zod";
import { createAgent, defineTool, anthropicProvider } from "../src/index.js";

/**
 * The agent's state, as a schema. The model reads/writes it with the built-in
 * `getState` / `setState` tools; you bring effect tools (here, `get_weather`).
 */
const StateSchema = z.object({
  notes: z.array(z.string()),
  answer: z.string().optional(),
});
type State = z.infer<typeof StateSchema>;

const getWeather = defineTool<z.ZodObject<{ city: z.ZodString }>, State>({
  name: "get_weather",
  description: "Look up the current weather for a city.",
  input: z.object({ city: z.string().describe("City name, e.g. 'Oslo'.") }),
  handler: ({ city }) => ({ city, tempC: 14, conditions: "partly cloudy" }),
});

const agent = createAgent({
  provider: anthropicProvider({ model: "claude-opus-4-8" }),
  state: StateSchema,
  tools: [getWeather],
  system:
    "You are a concise travel assistant. Look things up first, then setState the `answer` " +
    "field with your final answer — setState ends your turn and hands control back.",
  maxTurns: 10,
  hooks: {
    onToolCall({ call }) {
      console.log(`→ ${call.name}(${JSON.stringify(call.input)})`);
    },
  },
});

const session = agent.createSession({ state: { notes: [] } });
const result = await session.send("What's the weather in Oslo, and should I pack a coat?");

console.log("\nstoppedBy:", result.stoppedBy, "  steps:", result.steps);
console.log("final state:", JSON.stringify(session.getState(), null, 2));
