export const redact = (text) =>
  text.replace(/(token|password)=[^&\s]+/g, (_match, key) => `${key}=REDACTED`);
