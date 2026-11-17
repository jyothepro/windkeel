export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-frame">
      <div className="auth-brand">
        <span className="console-mark" aria-hidden="true" />
        Windkeel
      </div>
      <main className="auth-main" style={{ maxWidth: 720 }}>
        {children}
      </main>
    </div>
  );
}
