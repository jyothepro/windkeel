export const redact = (text) => text.replace(/token=[^&\s]+/g, "token=REDACTED");
