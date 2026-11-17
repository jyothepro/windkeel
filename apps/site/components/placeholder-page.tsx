import { Todo } from "./todo.tsx";

export function PlaceholderPage({ title, what }: { title: string; what: string }) {
  return (
    <div className="container-page py-16 md:py-24">
      <article className="max-w-2xl">
        <h1 className="text-[clamp(2rem,1.4rem+2.4vw,3rem)] font-semibold leading-tight tracking-tight">{title}</h1>
        <p className="mt-6 rounded-lg border border-dashed border-line-strong bg-sunken p-5 text-muted">
          This page is a placeholder. <Todo>{what}</Todo>
        </p>
      </article>
    </div>
  );
}
