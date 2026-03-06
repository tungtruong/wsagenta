import {
  attachAgentLogs,
  buildRuntimeConfig,
  createWorkspaceAgent,
  loadEnv,
  runTask,
} from "./agent-runtime.js";

async function main() {
  await loadEnv();

  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    console.error('Please provide a task. Example: npm start -- "Analyze this project"');
    process.exit(1);
  }

  const runtimeConfig = buildRuntimeConfig();
  const agent = createWorkspaceAgent(runtimeConfig);
  attachAgentLogs(agent, runtimeConfig);

  console.log(`Model: ${runtimeConfig.model}`);
  console.log(`Workspace: ${runtimeConfig.workspaceDir}`);
  console.log(`Task: ${task}`);
  console.log("---");

  const result = await runTask(agent, task, runtimeConfig);

  console.log("\nFinal answer:\n");
  console.log(result.finalOutput ?? "(No text output)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
