import { z } from "zod";
import { createAgent, defineTool, anthropicProvider } from "../src/index.js";

/**
 * The agent has no state schema — it pursues GOALS you set, thinks in structured
 * mental notes, and either completes its goals or declares itself blocked. You
 * bring effect tools (here, `get_weather`).
 */
const getWeather = defineTool({
  name: "get_weather",
  description: "Look up the current weather for a city.",
  input: z.object({ city: z.string().describe("City name, e.g. 'Oslo'.") }),
  handler: ({ city }) => ({ city, tempC: 14, conditions: "partly cloudy" }),
});

const agent = createAgent({
  provider: anthropicProvider({ model: "claude-opus-4-8" }),
  tools: [getWeather],
  system:
    "You are a concise travel assistant. Look things up, reason in mental notes, and complete " +
    "the goal. If you need something only the user can provide, setBlockedBy.",
  hooks: {
    onToolCall({ call }) {
      console.log(`→ ${call.name}(${JSON.stringify(call.input)})`);
    },
  },
});

const session = agent.createSession(
  "Tell me the weather in Oslo and whether I should pack a coat.",
);
const result = await session.run();

console.log("\nstoppedBy:", result.stoppedBy, "  steps:", result.steps);
console.log("\ngoal:", JSON.stringify(session.getState().goal, null, 2));
console.log("\nmental notes:", JSON.stringify(session.getState().notes, null, 2));
