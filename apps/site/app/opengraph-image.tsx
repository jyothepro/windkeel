import { ImageResponse } from "next/og";

export const alt = "Windkeel: agents write the code, Windkeel proves it.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background: "#0f1116",
          color: "#f1f2f6",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 40, fontWeight: 600 }}>
          <svg width="56" height="56" viewBox="0 0 24 24">
            <path d="M3 12h18" stroke="#f1f2f6" strokeWidth="1.75" strokeLinecap="round" />
            <path d="M4 7.5h9M7 4h7" stroke="#f1f2f6" strokeOpacity="0.45" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M9 12h6l-2.2 8.2a.8.8 0 0 1-1.6 0L9 12Z" fill="#8f87ff" />
          </svg>
          Windkeel
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>
            Agents write the code. Windkeel proves it.
          </div>
          <div style={{ fontSize: 30, color: "#a9adb6", lineHeight: 1.4 }}>
            A maker agent writes the change. An independent verifier, in a fresh sandbox, decides whether it passes.
          </div>
        </div>
        <div style={{ display: "flex", height: 2, background: "linear-gradient(90deg, #6159e1, transparent)" }} />
      </div>
    ),
    size,
  );
}
