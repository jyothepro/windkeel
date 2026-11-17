export type LessonRisk = "low" | "high";

export interface LessonText {
  title: string;
  body: string;
  pathGlobs?: readonly string[];
}

export interface RiskVerdict {
  risk: LessonRisk;
  reasons: string[];
}

export const MAX_CLASSIFIABLE_CHARS = 600;

interface Rule {
  reason: string;
  text?: RegExp[];
  squashed?: string[];
  raw?: RegExp[];
}

const HIGH_RISK_RULES: readonly Rule[] = [
  {
    reason: "names a command to run",
    text: [
      /```/,
      /(^|\n)\s*[$#>]\s+\S/,
      /&&|\|\||\$\(|\$\{|;\s*\w|\|\s*\w|>\s*\/|<\s*\//,
      /`/,
      /(^|[\s(])--?[a-z][\w-]*/,
      /\b(run|runs|running|execute|executes|executed|exec|invoke|invokes|invoked|call|calls|called|launch|launched|spawn|spawned|install|installs|installed|reinstall|uninstall|rerun|re-run|type|enter|use the command|use command|start|starts|started|perform|performs|trigger|triggers|triggered|pipe|piped|kick off)\b/,
      /\b(npm|npx|pnpm|yarn|bun|deno|node|pip|pipx|poetry|uv|python3?|ruby|gem|bundle|cargo|cmake|gradle|gradlew|mvn|dotnet|docker|podman|kubectl|helm|terraform|bash|sh|zsh|fish|powershell|pwsh|cmd|sudo|su|chmod|chown|rm|mv|cp|dd|kill|pkill|eval|exec|git|gh|curl|wget|nc|ncat|netcat|ssh|scp|rsync|ftp|telnet|tar|unzip|crontab|systemctl|apt|apt-get|brew|yum|dnf|apk|printenv|env|echo|cat|sed|awk|xargs|find|tee|nohup|base64|openssl|gpg|tsc|jest|vitest|mocha|pytest|tox|nox|eslint|prettier|webpack|vite|turbo|nx|lerna|rake|rails|php|composer|java|javac|perl|lua|make|ping|dig|nslookup|socat|nmap|ngrok|osascript|chroot|mount)\b/,
      /(^|\s)\.{1,2}\/\S/,
      /\.(sh|bash|ps1|bat|cmd|exe)\b/,
      /\b(go (test|build|run|get|install|generate|vet)|make \w)/,
    ],
    squashed: ["sudo", "chmod", "curl", "wget", "rmrf", "npmrun", "npminstall", "pipinstall", "bashc", "printenv"],
  },
  {
    reason: "touches secrets or credentials",
    text: [
      /\b(secrets?|tokens?|passwords?|passwd|passphrases?|credentials?|creds|api[\s_-]?keys?|private[\s_-]?keys?|ssh[\s_-]?keys?|access[\s_-]?keys?|keys?\s*file|keychain|vault|bearer|oauth|auth|authorization|authenticate|cookies?|sessions?\s*ids?|jwt|pat|keys?|logins?|log in|sign in|signing|netrc|npmrc|pypirc|pgpass|htpasswd|kubeconfig|id_rsa|id_ed25519|id_ecdsa|id_dsa|pem|p12|pfx|keystore|jks|certs?|certificates?|gpg|pgp|wallets?|mnemonic|seed phrase|encrypt\w*|decrypt\w*|environ|printenv)\b/,
      /(^|[\s/`'"])\.env\b|\bdotenv\b|\benv(ironment)?\s*var(iable)?s?\b|\bprocess\.env\b|\$[A-Z_]{3,}/i,
      /\b(akia[0-9a-z]{12,}|gh[pousr]_[a-z0-9]{10,}|github_pat_|sk-[a-z0-9-]{8,}|xox[a-z]-|-----begin)/,
    ],
    squashed: ["secret", "password", "passwd", "credential", "apikey", "privatekey", "accesskey", "sshkey", "token", "bearer", "dotenv", "netrc", "npmrc", "idrsa", "kubeconfig", "printenv"],
  },
  {
    reason: "points outside the repository",
    text: [
      /~\/|(^|\s)~(\s|$)|\$home|home director|\/(etc|root|home|var|proc|sys|dev|tmp|users|opt|usr|private)(\/|\b)|\b[a-z]:\\/,
      /(^|[\s(\["'=])\/[a-z]/,
    ],
  },
  {
    reason: "touches the network or egress",
    text: [
      /\b(https?|ftp|wss?|file|data|javascript):/,
      /\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|dev|app|ai|co|xyz|sh|me|info|biz|ru|cn)\b/,
      /\b\d{1,3}(\.\d{1,3}){3}\b|\blocalhost\b|\b0\.0\.0\.0\b/,
      /\b(network|networking|egress|ingress|internet|online|offline|proxy|proxies|firewall|allowlist|whitelist|denylist|blocklist|dns|domain|domains|hostname|host|hosts|url|urls|uri|endpoint|endpoints|webhook|webhooks|socket|sockets|port|ports|upload|uploads|download|downloads|fetch|fetches|exfiltrate|exfil|send to|post to|request to|external service|third[- ]party service|registry|registries|mirror\w*|report to|reports to|reported to|beacon\w*|telemetry|analytics|connect\w*|listen\w*|send|sends|sent|transmit\w*|smtp|e-?mail\w*|mail|bucket|s3|api|apis|ngrok|pastebin)\b/,
      /\[\.\]|\(\.\)|\[dot\]|\(dot\)|\{dot\}/,
    ],
    squashed: ["egress", "exfil", "webhook", "http", "proxy", "download", "upload", "telemetry"],
  },
  {
    reason: "skips or weakens tests",
    text: [
      /\b(skip|skips|skipped|skipping|disable|disables|disabled|disabling|ignore|ignores|ignored|ignoring|bypass|bypasses|bypassing|xfail|xit|xdescribe|todo|pending|quarantine|mute|silence|suppress|suppresses|comment out|commented out|delete|deletes|deleting|remove|removes|removing|weaken|weakens|loosen|loosens|relax|relaxes|lower|lowers|reduce|reduces|stub out|mock out|hollow|shortcut|work ?around|workaround|force|forces|override|overrides|monkey[- ]?patch|optional|not required|unnecessary|no longer|empty|emptied|stub\w*|mock\w*|fake\w*|hard-?cod\w*|assert\w*|expect\w*|golden|updat\w*|rewrit\w*|renam\w*|eras\w*|drop\w*|exclud\w*|omit\w*|regenerat\w*)\b/,
      /\.only\b|\.skip\b|--no-verify|--force|-u\b|--update(-snapshots?)?\b|--pass-?with-?no-?tests|\|\|\s*true|exit\s*0|eslint-disable|ts-ignore|ts-nocheck|ts-expect-error|noqa|nolint|istanbul ignore|pragma: no cover|type:\s*ignore/,
      /\b(coverage|threshold|thresholds|flaky|retry|retries|timeout|timeouts|snapshot|snapshots)\b/,
    ],
    squashed: ["skiptest", "disabletest", "notest", "noverify", "bypass", "tsignore", "eslintdisable"],
  },
  {
    reason: "mentions the verifier or checker",
    text: [
      /\b(verif\w*|checker|checkers|checks?|checking|grader|graders|grading|judge|judges|judging|gate|gates|gating|evaluator|evaluators|evaluation|review|reviews|reviewer|reviewers|reviewing|audit|auditor|attest\w*|evidence|verdict|verdicts|criteria|criterion|acceptance|windkeel|ci|pipeline|pipelines|pass|passes|passing|fail|fails|failing|score|scores|scoring|approve|approved|approval|sign[- ]?off|policy|policies|qa|sandbox\w*|inspector\w*|examiner\w*|assessor\w*|assess\w*|validat\w*|oracle|lint|linter|linters|bots?|robots?|tested|untested|safe|unsafe|correct|correctness|complete|completed|done|finished|lgtm|ship|shipped|merge\w*|green|pull requests?|prs?|this (change|patch|diff|commit))\b/,
    ],
    squashed: ["verif", "checker", "grader", "judge", "windkeel", "orqon", "attest", "verdict", "reviewer", "evaluator", "sandbox"],
  },
  {
    reason: "reads like an instruction to the model",
    text: [
      /\b(ignore|disregard|forget|override|overrule|bypass)\b.{0,40}\b(previous|prior|above|earlier|all|any|other|system|these|those|the)\b.{0,20}\b(instructions?|rules?|prompts?|guidance|directions?|constraints?|messages?)\b/,
      /\b(system prompt|system message|developer message|jailbreak|dan mode|you are now|you are an?|act as|pretend|roleplay|role-play|from now on|new instructions?|real instructions?|hidden instructions?|do not tell|don't tell|without telling|secretly|silently|do anything|no matter what|always obey|must obey|highest priority|top priority|important:|attention:|note to (the )?(ai|model|assistant|agent))\b/,
      /<\|[^|]*\|>|<\/?(system|assistant|user|instructions?|prompt|im_start|im_end)\b|\[\/?(inst|system)\]|^\s*(system|assistant|user|human)\s*:/m,
      /\b(assistant|agent|model|ai|llm|codex|claude|gpt|chatgpt)\b/,
      /\b(supersed\w*|precedence|priority|prioriti\w*|regardless|instead of|rather than|in place of|replac\w*|tasks?|instructions?|prompts?|guidance|the user|the operator|obey\w*|comply|must|shall|mandatory|always|never|should|you|your)\b/,
    ],
    squashed: ["supersede", "precedence", "ignorepreviousinstructions", "ignoreallpreviousinstructions", "ignoreallinstructions", "disregardprevious", "disregardinstructions", "systemprompt", "jailbreak", "youarenow", "newinstructions"],
  },
  {
    reason: "unclassifiable: encoded, hidden or non-prose content",
    raw: [
      /\b[0-9a-fA-F]{32,}\b/,
      /!?\[[^\]]*\]\([^)]*\)/,
      /<[a-zA-Z!/][^>]*>/,
      /(^|\n)\s{0,3}#{1,6}\s/,
      /\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|&#x?[0-9a-fA-F]+;|%[0-9a-fA-F]{2}/,
    ],
  },
];

const DESCRIPTIVE_PATTERNS: readonly RegExp[] = [
  /\b(lives?|is|are|sits?|kept|stored|located|found|placed|organi[sz]ed|grouped|defined|declared)\s+(in|under|inside|within|beside|next to|alongside)\b/,
  /\b(directory|directories|folder|folders|module|modules|package|packages|file|files|layout|structure|subdirectory|monorepo|workspace)\b/,
  /\b(convention|conventions|naming|named|style|styled|format|formatted|formatting|indent|indented|indentation|camelcase|snake_case|kebab-case|pascalcase|prefer|prefers|preferred|uses|use|written in|import|imports|export|exports|typed|types|interface|interfaces|comment|comments|documented|docs|changelog|license|header)\b/,
  /\b(tests?|specs?|fixtures?)\s+(live|lives|are|is|sit|go|belong|reside)\b/,
  /\b(test|tests|spec|specs|fixture|fixtures)\s+(directory|folder|files?|framework|runner|suite|helpers?)\b/,
];

function encodedRun(text: string): boolean {
  for (const [run] of text.matchAll(/[A-Za-z0-9+/=_-]{40,}/g)) {
    if (run.length >= 80) return true;
    if (/[0-9]/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run)) return true;
  }
  return false;
}

const INVISIBLE_TEST = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{E0000}-\u{E007F}]/u;
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{E0000}-\u{E007F}]/gu;

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

const LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "2": "z", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s", "!": "i", "|": "l", "+": "t" };

const FILE_EXTENSIONS = new Set(
  (
    "js ts tsx jsx mjs cjs mts cts json jsonc json5 md mdx markdown txt rst adoc sql css scss sass less html htm xml svg " +
    "png jpg jpeg gif webp ico yml yaml toml ini cfg conf lock log csv tsv py pyi rb go rs java kt kts scala c h cc cpp " +
    "hpp cxx cs fs swift m mm pl lua r dart ex exs erl hs ml elm vue svelte astro graphql gql proto tf hcl gradle " +
    "properties map snap tmpl tpl hbs ejs njk pug wasm"
  ).split(" "),
);

function hostLike(lower: string): boolean {
  for (const [token] of lower.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g)) {
    const last = token.slice(token.lastIndexOf(".") + 1);
    if (/^[a-z]{2,}$/.test(last) && !FILE_EXTENSIONS.has(last)) return true;
  }
  return false;
}

const VOCABULARY = new Set(
  (
    "a an the and or but nor not no of in on at to from by with within inside outside under over above below beside " +
    "besides next near into onto out up down off about as than then so if when where while which who whose what that " +
    "this these those there here it its they them their we our each every all any some both either neither one two three " +
    "four five first second third last other another same such only also just even more most less least many much few " +
    "several very too before after between among per via etc eg ie is are was were be been being has have had do does " +
    "did can may will would whether because since like unlike usually generally typically mostly mainly otherwise " +
    "file folder directory directories module package component function method class type interface variable constant " +
    "field property name naming convention style format code source test spec fixture helper util utility utilities " +
    "library app application service config configuration setting option migration schema table column database row " +
    "query view page route handler controller middleware hook state store reducer event error exception message string " +
    "number boolean array list map object value id index entry root repo repository project workspace monorepo layout " +
    "structure tree path extension dependency dependencies version changelog license readme doc docs documentation " +
    "comment header footer title description example sample template asset image icon font css html sql json yaml toml " +
    "xml markdown javascript typescript python ruby rust kotlin swift language framework react vue svelte angular next " +
    "nextjs esm commonjs plain text line character tab space indentation case camelcase pascalcase kebab snake prefix " +
    "suffix pattern unit integration suite runner data input output result argument parameter param default generic " +
    "enum alias wrapper adapter factory provider client job queue cache shared common core internal public local global " +
    "top level nested sub subdirectory subfolder separate single multiple barrel utils lib dist generated legacy " +
    "old new main entry point quote semicolon comma bracket brace parenthesis import export declaration definition " +
    "decorator annotation attribute prop props hooks context provider layer domain model view controller ui frontend " +
    "backend shell storybook story stories locale translation string asset static public binary image " +
    "live sit hold contain keep kept store locate find found place organize organise group define declare use write " +
    "written name follow belong reside wrap extend implement return take handle prefer number sort order describe " +
    "document generate indent mirror lowercase uppercase capital capitalize capitalise plural singular double explicit " +
    "implicit consistent current existing related corresponding matching different own small large short long simple " +
    "alphabetical alphabetically numbered dated grouped split separated paired colocated co-located beside alongside " +
    "per-file named-export default-export top-level one-line multi-line"
  ).split(" "),
);

function knownWord(word: string): boolean {
  if (VOCABULARY.has(word)) return true;
  const stems = [
    word.replace(/ies$/, "y"),
    word.replace(/es$/, ""),
    word.replace(/s$/, ""),
    word.replace(/ed$/, ""),
    word.replace(/d$/, ""),
    word.replace(/ing$/, ""),
    word.replace(/ing$/, "e"),
    word.replace(/ly$/, ""),
    word.replace(/([a-z])\1ed$/, "$1"),
    word.replace(/([a-z])\1ing$/, "$1"),
  ];
  return stems.some((stem) => stem !== word && VOCABULARY.has(stem));
}

const MAX_NAMES = 6;

const MAX_UNKNOWN_PATH_WORDS = 2;

function unknownProse(raw: string): { unknown: string[]; tooManyNames: boolean } {
  const unknown: string[] = [];
  let names = 0;
  let unknownPathWords = 0;
  for (const token of raw.split(/\s+/)) {
    const bare = token.replace(/^[("'*]+|[)"'*:;,.!?]+$/g, "");
    if (bare === "") continue;
    if (/[/_0-9.]/.test(bare)) {
      names += 1;
      for (const [part] of bare.toLowerCase().matchAll(/[a-z]{4,}/g)) if (!knownWord(part)) unknownPathWords += 1;
      continue;
    }
    for (const [word] of bare.matchAll(/[A-Za-z]+(?:-[A-Za-z]+)*/g)) {
      const prose = word.split("-").every((part) => /^[A-Za-z][a-z]*$/.test(part) || (part.length > 5 && /^[A-Z]+$/.test(part)));
      if (!prose) {
        names += 1;
        continue;
      }
      const lowerWord = word.toLowerCase();
      if (!knownWord(lowerWord) && !lowerWord.split("-").every(knownWord)) unknown.push(lowerWord);
    }
  }
  return { unknown, tooManyNames: names > MAX_NAMES || unknownPathWords > MAX_UNKNOWN_PATH_WORDS };
}

export function classifyLesson(lesson: LessonText): RiskVerdict {
  const globs = lesson.pathGlobs ?? [];
  const joined = [lesson.title, lesson.body, ...globs].join("\n");
  const reasons = new Set<string>();

  if (joined.trim() === "" || lesson.title.trim() === "" || lesson.body.trim() === "") {
    reasons.add("unclassifiable: empty");
  }
  if (joined.length > MAX_CLASSIFIABLE_CHARS) {
    reasons.add(`unclassifiable: longer than ${MAX_CLASSIFIABLE_CHARS} characters`);
  }
  if (CONTROL.test(joined)) reasons.add("unclassifiable: control characters");

  const nfkc = joined.normalize("NFKC");
  if (nfkc !== joined.normalize("NFC")) reasons.add("unclassifiable: compatibility characters (look-alike letters)");
  if (INVISIBLE_TEST.test(nfkc)) reasons.add("unclassifiable: invisible or direction-changing characters");
  if (encodedRun(nfkc)) reasons.add("unclassifiable: encoded, hidden or non-prose content");
  if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(nfkc)) {
    reasons.add("unclassifiable: text in a script the classifier cannot read");
  }

  if (/[^\t\n\x20-\x7E]/.test(nfkc.replace(INVISIBLE, "").normalize("NFKD").replace(/\p{M}/gu, ""))) {
    reasons.add("unclassifiable: characters outside plain ASCII");
  }

  const raw = nfkc.replace(INVISIBLE, "");
  const lower = raw.toLowerCase();
  const deobfuscated = lower.replace(/[0-9@$!|+]/g, (c) => LEET[c] ?? c);
  const split = raw
    .replace(/\b[a-z][A-Za-z0-9]*/g, (token) => token.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
    .replace(/_/g, " ")
    .toLowerCase();
  const squashed = deobfuscated.normalize("NFKD").replace(/[^a-z]/g, "");
  const squashedRaw = lower.normalize("NFKD").replace(/[^a-z]/g, "");

  if (hostLike(lower)) reasons.add("touches the network or egress");

  for (const rule of HIGH_RISK_RULES) {
    const hit =
      (rule.text ?? []).some((re) => re.test(lower) || re.test(deobfuscated) || re.test(split)) ||
      (rule.squashed ?? []).some((word) => squashed.includes(word) || squashedRaw.includes(word)) ||
      (rule.raw ?? []).some((re) => re.test(raw));
    if (hit) reasons.add(rule.reason);
  }

  for (const glob of globs) {
    if (!/^[A-Za-z0-9_./*?{},-]+$/.test(glob) || glob.includes("..") || glob.startsWith("/")) {
      reasons.add("unclassifiable: a path glob outside the repository-relative form");
    }
  }

  if (reasons.size === 0 && !DESCRIPTIVE_PATTERNS.some((re) => re.test(lower))) {
    reasons.add("unclassifiable: not recognisably a description of the repository");
  }
  if (reasons.size === 0) {
    const prose = unknownProse(raw);
    if (prose.unknown.length > 0) {
      reasons.add(`unclassifiable: words the classifier does not know (${[...new Set(prose.unknown)].slice(0, 5).join(", ")})`);
    }
    if (prose.tooManyNames) reasons.add(`unclassifiable: more than ${MAX_NAMES} paths or names, or prose hidden in paths`);
  }

  return reasons.size === 0 ? { risk: "low", reasons: [] } : { risk: "high", reasons: [...reasons].sort() };
}
