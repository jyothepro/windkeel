export function KeelMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 12h18" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M4 7.5h9M7 4h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.45" />
      <path d="M9 12h6l-2.2 8.2a.8.8 0 0 1-1.6 0L9 12Z" fill="var(--color-accent-solid)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-[1.0625rem] font-semibold tracking-tight text-fg">
      <KeelMark />
      Windkeel
    </span>
  );
}
