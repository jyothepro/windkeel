export const SCANNER_ASSET_PREFIX = "windkeel-scanners-";

export interface ScannerAssets {
  dir: string;
  semgrepRules: string;
  osvMarker: string;
}

export function scannerAssets(dir: string): ScannerAssets {
  return {
    dir,
    semgrepRules: `${dir}/semgrep-p-ci.yaml`,
    osvMarker: `${dir}/osv-offline-db.ready`,
  };
}
