import type { Metadata } from "next";
import { listAllRepositories, loadModelPicker, loadPlaybooks, takeoverEnabled } from "../../../../lib/api.ts";
import { pickerOptions } from "../../../../lib/playbooks.ts";
import { FileTaskForm } from "./form.tsx";

export const metadata: Metadata = { title: "New task" };

export default async function NewTaskPage() {
  const [repos, picker, pair, playbooks] = await Promise.all([listAllRepositories(), loadModelPicker(), takeoverEnabled(), loadPlaybooks()]);
  return (
    <main className="console-main">
      <header className="console-header">
        <h1>New task</h1>
      </header>
      <FileTaskForm repositories={repos.items.map((r) => ({ id: r.id, fullName: r.fullName }))} picker={picker} pairMode={pair} playbooks={playbooks ? pickerOptions(playbooks) : null} />
    </main>
  );
}
