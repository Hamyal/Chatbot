import { Agent, type AgentInputItem, Runner, withTrace } from "@openai/agents";

export type WorkflowInput = { input_as_text: string };
export type WorkflowOutput = { output_text: string };

function getEnv(name: string, fallback = ""): string {
  return process.env[name] ? String(process.env[name]) : fallback;
}

const myAgent = new Agent({
  name: "My agent",
  instructions: "You are a helpful assistant.",
  model: getEnv("OPENAI_MODEL", "gpt-4.1-mini"),
  modelSettings: {
    reasoning: { effort: "low", summary: "auto" },
    store: true,
  },
});

export const runWorkflow = async (
  workflow: WorkflowInput
): Promise<WorkflowOutput> => {
  return await withTrace("New agent", async () => {
    const conversationHistory: AgentInputItem[] = [
      {
        role: "user",
        content: [{ type: "input_text", text: workflow.input_as_text }],
      },
    ];

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: getEnv("WORKFLOW_ID", ""),
      },
    });

    const result = await runner.run(myAgent, [...conversationHistory]);

    if (!result.finalOutput) {
      throw new Error("Agent result is undefined");
    }

    return { output_text: result.finalOutput };
  });
};

