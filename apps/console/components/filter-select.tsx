"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function FilterSelect({
  name,
  label,
  all,
  options,
}: {
  name: string;
  label: string;
  all: string;
  options: Array<{ value: string; label: string }>;
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const value = params.get(name) ?? "";
  return (
    <form className="console-filter" method="get" action={path}>
      {[...params.entries()]
        .filter(([k]) => k !== name)
        .map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
      <label className="oq-sr-only" htmlFor={`filter-${name}`}>
        {label}
      </label>
      <select
        id={`filter-${name}`}
        name={name}
        className="oq-input console-filter__select"
        value={value}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          if (e.target.value) next.set(name, e.target.value);
          else next.delete(name);
          const q = next.toString();
          router.push(q ? `${path}?${q}` : path);
        }}
      >
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="oq-button oq-button--sm">
          Filter
        </button>
      </noscript>
    </form>
  );
}
