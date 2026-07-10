import { runWorkflow } from "./runWorkflow.js";

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const text = readArg("--text") ?? process.argv.slice(2).join(" ").trim();
  if (!text) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run dev -- --text "hello"');
    process.exit(2);
  }

  const out = await runWorkflow({ input_as_text: text });
  // eslint-disable-next-line no-console
  console.log(out.output_text);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

