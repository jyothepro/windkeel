import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "@ui-sdk/react/accordion";
import { PlusIcon } from "./icons.tsx";
import { Todo } from "./todo.tsx";

const QUESTIONS: { value: string; question: string; answer: React.ReactNode }[] = [
  {
    value: "agents",
    question: "Which agents and models does it use?",
    answer: (
      <p>
        The maker is Codex, Claude Code or OpenCode, running the model you choose. The verifier uses a model from a
        different vendor than the maker, so the agent that wrote the code is never the one grading it.
      </p>
    ),
  },
  {
    value: "merge",
    question: "Do you merge pull requests for me?",
    answer: (
      <p>
        No. Windkeel opens a draft pull request with its evidence package. A person reviews it and merges as
        themselves. Windkeel never approves or merges on its own.
      </p>
    ),
  },
  {
    value: "fails",
    question: "What happens if verification fails?",
    answer: (
      <p>
        The maker gets the verifier&apos;s findings and repairs the change, then the verifier checks it again in a fresh
        sandbox. This repeats within caps on attempts, spend and time. <Todo>confirm what you see when the caps run out</Todo>
      </p>
    ),
  },
  {
    value: "keys",
    question: "Can I use my own model keys?",
    answer: (
      <p>
        Yes. On Windkeel Cloud, bring your own model key and you pay for compute only. Windkeel Gate always runs in your
        own CI with your own keys.
      </p>
    ),
  },
  {
    value: "training",
    question: "Is my code used to train models?",
    answer: (
      <p>
        <Todo>needs an answer from the owner</Todo>
      </p>
    ),
  },
  {
    value: "source-available",
    question: "Is it open source?",
    answer: (
      <p>
        The source is public under PolyForm Noncommercial 1.0.0, so it is source-available rather than open source.
        Windkeel Gate, a CLI and GitHub Action that verifies any pull request and writes the evidence package with no
        servers, is free for personal and other noncommercial use. Commercial use needs a Cloud plan or a commercial
        license. Windkeel Cloud, the managed factory and console, is a paid service.
      </p>
    ),
  },
  {
    value: "credit",
    question: "What does a credit buy?",
    answer: (
      <p>
        One credit is US$0.01. Sandbox compute costs 2 credits a minute, for the maker and the verifier alike. AI on
        Windkeel&apos;s models is billed at cost. Verification is metered like everything else and is never skipped to
        save money.
      </p>
    ),
  },
  {
    value: "name",
    question: "Why do the commands say windkeel?",
    answer: (
      <p>
        The CLI and the GitHub Action still carry the project&apos;s earlier name. The commands on this page are the real
        ones, exactly as they are today.
      </p>
    ),
  },
];

export function Faq() {
  return (
    <Accordion aria-label="Frequently asked questions" className="border-t border-line">
      {QUESTIONS.map((item) => (
        <AccordionItem key={item.value} value={item.value}>
          <AccordionHeader className="m-0">
            <AccordionTrigger>
              {item.question}
              <PlusIcon size={18} />
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionPanel>
            <div className="max-w-2xl pb-5 leading-relaxed text-muted">{item.answer}</div>
          </AccordionPanel>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
