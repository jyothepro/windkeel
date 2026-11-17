import localFont from "next/font/local";

export const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

export const geistMono = localFont({
  src: [
    { path: "./fonts/GeistMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/GeistMono-Medium.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-geist-mono",
  display: "swap",
  preload: false,
});
