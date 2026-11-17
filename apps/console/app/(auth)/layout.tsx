export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-frame">
      <div className="auth-brand">
        <span className="console-mark" aria-hidden="true" />
        Windkeel
      </div>
      <main className="auth-main">{children}</main>
    </div>
  );
}
