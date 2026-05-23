import Anthropic from "@anthropic-ai/sdk";
// my first edit
import { allTools, toolsByName } from "./tools.js";
import { rl } from "./io.js";

const client = new Anthropic();
const messages: Anthropic.MessageParam[] = [];

const toolDefinitions = allTools.map((t) => t.definition);

// TODO(human): Write the system prompt text below.
// What should the agent know about itself? What rules should it always follow?
// What tone/style? What are its capabilities and limits?
const SYSTEM_PROMPT: Anthropic.TextBlockParam[] = [
  {
    type: "text",
    text: ``,
    cache_control: { type: "ephemeral" },
  },
];

/**
 * Given the assistant's response content (which may contain tool_use blocks),
 * run each requested tool and return an array of tool_result blocks suitable
 * for the next user-role message.
 *
 * If there are no tool_use blocks, return an empty array — the caller uses
 * that as the signal that the model is done and it's the user's turn again.
 */
async function executeTools(
  responseContent: Anthropic.ContentBlock[],
): Promise<Anthropic.ToolResultBlockParam[]> {
  // TODO(human): implement the tool dispatcher.
  // - Iterate over responseContent.
  // - For each block where block.type === "tool_use":
  //     * Look up the Tool in toolsByName by block.name.
  //     * Call its handler with block.input.
  //     * Build a tool_result block: { type, tool_use_id, content }.
  //     * If the handler throws, return the error as content and set is_error: true.
  // - Return the collected tool_result blocks.
  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  for (const block of responseContent) {
    if (block.type === "tool_use") {
      const tool = toolsByName[block.name];
      if (!tool) {
        throw new Error(`Tool ${block.name} not found`);
      }
      try {
        const result = await tool.handler(block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      } catch (error) {
        if (error instanceof Error) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: error.message,
            is_error: true,
          });
        } else {
          throw error;
        }
      }
    }
  }
  return toolResults;
}

async function runTurn(userText: string) {
  messages.push({ role: "user", content: userText });

  // Inner loop: keep calling the model as long as it wants to use tools.
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions,
      messages,
    });

    // Persist whatever the model said (text + any tool_use blocks).
    messages.push({ role: "assistant", content: response.content });

    // Print any text the model produced this step.
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`\nClaude: ${block.text}`);
      } else if (block.type === "tool_use") {
        console.log(`  → tool: ${block.name}(${JSON.stringify(block.input)})`);
      }
    }

    // If the model stopped for a reason other than tool_use, we're done.
    if (response.stop_reason !== "tool_use") return;

    // Otherwise, run the tools and feed results back as the next user message.
    const toolResults = await executeTools(response.content);
    if (toolResults.length === 0) return; // safety: nothing to do
    messages.push({ role: "user", content: toolResults });
  }
}

async function main() {
  console.log("Agent ready. Type a message (Ctrl+C to quit).");
  while (true) {
    const user = await rl.question("\nYou: ");
    if (!user.trim()) continue;
    await runTurn(user);
  }
}

main();
