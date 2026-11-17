import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#21242a" }}>
        <svg width="180" height="180" viewBox="0 0 32 32">
          <path d="M5 16h22" stroke="#fcfdfe" strokeWidth="2.25" strokeLinecap="round" />
          <path d="M6.5 10h11M10 5.5h9" stroke="#fcfdfe" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 16h8l-3 10.8a1 1 0 0 1-2 0L12 16Z" fill="#8f87ff" />
        </svg>
      </div>
    ),
    size,
  );
}
