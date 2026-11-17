export type ActionResult =
  | {
      ok: true;
      secret?: string;
      sample?: boolean;
      message?: string;
      href?: string;
      hrefLabel?: string;
    }
  | { ok: false; message: string };

export type PreviewResult = { ok: true; times: string[] } | { ok: false; message: string };
