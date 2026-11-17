import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { CodeBlock } from "./code-block.tsx";
import { ACTION_SNIPPET, CLI_SNIPPET } from "./snippets.ts";

export function GateTabs() {
  return (
    <Tabs defaultValue="action">
      <TabsList aria-label="Ways to run Gate">
        <TabsTab value="action">GitHub Action</TabsTab>
        <TabsTab value="cli">CLI</TabsTab>
        <TabsIndicator />
      </TabsList>
      <TabsPanel value="action" className="pt-4">
        <CodeBlock code={ACTION_SNIPPET} label="GitHub Action workflow step" copyLabel="Copy the GitHub Action step" />
        <p className="mt-3 text-sm text-muted">
          Pin the action to a commit SHA. Your model key stays in your repository secrets.
        </p>
      </TabsPanel>
      <TabsPanel value="cli" className="pt-4">
        <CodeBlock code={CLI_SNIPPET} label="Gate CLI commands" copyLabel="Copy the CLI commands" />
        <p className="mt-3 text-sm text-muted">Runs on any checkout, on your machine or in any CI.</p>
      </TabsPanel>
    </Tabs>
  );
}
