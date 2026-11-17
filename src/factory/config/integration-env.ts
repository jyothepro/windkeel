export const INTEGRATION_VARIABLES: ReadonlyArray<{ name: string; purpose: string; integration: string }> = [
  { name: "WINDKEEL_CONNECT_SLACK", integration: "Slack", purpose: "optional: the Slack Connect connector uid; unset = Slack off" },
  { name: "WINDKEEL_CONNECT_LINEAR", integration: "Linear", purpose: "optional: the Linear Connect connector uid; unset = Linear off" },
  { name: "WINDKEEL_CONNECT_JIRA", integration: "Jira", purpose: "optional: the Jira Connect connector uid; unset = Jira off" },
  {
    name: "WINDKEEL_CONNECT_SENTRY",
    integration: "Sentry post-back",
    purpose: "optional: turns on the Sentry comments (flow function); unset = no comments on Sentry issues",
  },
  {
    name: "WINDKEEL_SENTRY_CLIENT_SECRET",
    integration: "Sentry intake",
    purpose: "optional: the Sentry integration's client secret, verifying /api/intake/sentry; unset = every Sentry delivery is a 503",
  },
];
