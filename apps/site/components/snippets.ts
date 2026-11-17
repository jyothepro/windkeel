export const CLI_SNIPPET = `npx windkeel verify          # verify a checkout, write an evidence package
npx windkeel verify-package  # re-check an existing package offline`;

export const VERIFY_PACKAGE_SNIPPET = `npx windkeel verify-package  # re-check an existing package offline`;

export const ACTION_SNIPPET = `- uses: jyothepro/windkeel@<pinned-sha>
  with:
    mode: verify
    anthropic-api-key: \${{ secrets.ANTHROPIC_API_KEY }}`;
