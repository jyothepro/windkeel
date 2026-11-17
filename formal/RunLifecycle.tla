---------------------------- MODULE RunLifecycle ----------------------------
(***************************************************************************)
(* The lifecycle of one engineering run, as a model the TLC model checker  *)
(* explores exhaustively. See formal/README.md.                            *)
(*                                                                         *)
(* What is modelled, and where it lives in the code:                       *)
(*  - The transition table: src/factory/run-state-machine.ts. The sets     *)
(*    below are held equal to the code by test/formal-model-sync.test.js.  *)
(*  - Commits are serialised by a row lock and re-checked against the      *)
(*    table (src/factory/stores/run-store.ts), so every execution, stale   *)
(*    or current, can only make a move legal from the current state.       *)
(*  - The verifier gate: a run leaves VERIFYING for a PR only on a pass    *)
(*    for the code as it stands; new code (entering VERIFYING again)       *)
(*    voids the previous verdict (ADR-0032/0033).                          *)
(*  - The stalled-run sweep (src/factory/sweeps/stalled-runs.ts and        *)
(*    src/factory/workflow/vercel-provider-core.ts): a stalled driving     *)
(*    execution is re-dispatched at most MaxReclaims times, then the run   *)
(*    is failed, or left as it is when FAILED is not legal from its state. *)
(*  - Repairs are bounded by MaxRepairs.                                   *)
(*                                                                         *)
(* Not modelled: model calls, sandboxes, GitHub, tenancy, costs.           *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS MaxRepairs, MaxReclaims

States == {
  "CREATED", "CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL",
  "PROVISIONING", "IMPLEMENTING", "VERIFYING", "REPAIRING",
  "PR_CREATING", "PR_READY", "WAITING_FOR_HUMAN", "HUMAN_EDITING",
  "COMPLETED", "CANCELLED", "BLOCKED", "FAILED",
  "MAX_REPAIR_ATTEMPTS_REACHED"
}

Terminal == {"COMPLETED", "CANCELLED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"}

FailedEligible == {
  "CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL", "PROVISIONING",
  "IMPLEMENTING", "VERIFYING", "REPAIRING", "PR_CREATING"
}

NamedPairs == {
  <<"CREATED", "CLASSIFYING">>,
  <<"CLASSIFYING", "PLANNING">>,
  <<"PLANNING", "PROVISIONING">>,
  <<"PLANNING", "WAITING_FOR_APPROVAL">>,
  <<"WAITING_FOR_APPROVAL", "PROVISIONING">>,
  <<"PROVISIONING", "IMPLEMENTING">>,
  <<"IMPLEMENTING", "VERIFYING">>,
  <<"VERIFYING", "PR_CREATING">>,
  <<"VERIFYING", "REPAIRING">>,
  <<"VERIFYING", "MAX_REPAIR_ATTEMPTS_REACHED">>,
  <<"REPAIRING", "VERIFYING">>,
  <<"PR_CREATING", "PR_READY">>,
  <<"PR_READY", "WAITING_FOR_HUMAN">>,
  <<"WAITING_FOR_HUMAN", "COMPLETED">>,
  <<"WAITING_FOR_HUMAN", "CANCELLED">>,
  <<"BLOCKED", "CANCELLED">>,
  <<"IMPLEMENTING", "HUMAN_EDITING">>,
  <<"REPAIRING", "HUMAN_EDITING">>,
  <<"WAITING_FOR_HUMAN", "HUMAN_EDITING">>,
  <<"HUMAN_EDITING", "VERIFYING">>,
  <<"HUMAN_EDITING", "IMPLEMENTING">>
}

NonTerminalExcludingBlocked == States \ (Terminal \cup {"BLOCKED"})

Legal(from, to, bf) ==
  \/ <<from, to>> \in NamedPairs
  \/ (from \in NonTerminalExcludingBlocked /\ to \in {"BLOCKED", "CANCELLED"})
  \/ (from \in FailedEligible /\ to = "FAILED")
  \/ (from = "BLOCKED" /\ to = bf)

HumanWait == {"WAITING_FOR_APPROVAL", "WAITING_FOR_HUMAN", "HUMAN_EDITING", "BLOCKED"}

Driven == States \ (Terminal \cup HumanWait)

PRStates == {"PR_CREATING", "PR_READY", "WAITING_FOR_HUMAN", "COMPLETED"}

VARIABLES state, blockedFrom, verdict, repairs, binding, reclaims, everVerified

vars == <<state, blockedFrom, verdict, repairs, binding, reclaims, everVerified>>

TypeOK ==
  /\ state \in States
  /\ blockedFrom \in States \cup {"none"}
  /\ verdict \in {"none", "pass", "fail"}
  /\ repairs \in 0..MaxRepairs
  /\ binding \in {"active", "stalled", "finished"}
  /\ reclaims \in 0..MaxReclaims
  /\ everVerified \in BOOLEAN

Init ==
  /\ state = "CREATED"
  /\ blockedFrom = "none"
  /\ verdict = "none"
  /\ repairs = 0
  /\ binding = "active"
  /\ reclaims = 0
  /\ everVerified = FALSE

Move(to) ==
  /\ Legal(state, to, blockedFrom)
  /\ state' = to
  /\ blockedFrom' = IF to = "BLOCKED" THEN state ELSE "none"

FreshCode(to) == verdict' = IF to = "VERIFYING" THEN "none" ELSE verdict

Drive(to) ==
  /\ binding = "active"
  /\ state \in Driven
  /\ to \notin {"BLOCKED", "CANCELLED", "FAILED", "HUMAN_EDITING"}
  /\ state = "VERIFYING" =>
       \/ (to = "PR_CREATING" /\ verdict = "pass")
       \/ (to = "REPAIRING" /\ verdict = "fail" /\ repairs < MaxRepairs)
       \/ (to = "MAX_REPAIR_ATTEMPTS_REACHED" /\ verdict = "fail" /\ repairs = MaxRepairs)
  /\ Move(to)
  /\ FreshCode(to)
  /\ repairs' = IF to = "REPAIRING" THEN repairs + 1 ELSE repairs
  /\ binding' = IF to \in Driven THEN "active" ELSE "finished"
  /\ UNCHANGED <<reclaims, everVerified>>

Verify ==
  /\ binding = "active"
  /\ state = "VERIFYING"
  /\ verdict = "none"
  /\ verdict' \in {"pass", "fail"}
  /\ everVerified' = TRUE
  /\ UNCHANGED <<state, blockedFrom, repairs, binding, reclaims>>

DriveStop(to) ==
  /\ binding = "active"
  /\ state \in Driven
  /\ to \in {"FAILED", "BLOCKED"}
  /\ Move(to)
  /\ binding' = "finished"
  /\ UNCHANGED <<verdict, repairs, reclaims, everVerified>>

Human(to) ==
  /\ \/ (state = "WAITING_FOR_APPROVAL" /\ to = "PROVISIONING")
     \/ (state = "WAITING_FOR_HUMAN" /\ to \in {"COMPLETED", "HUMAN_EDITING"})
     \/ (state = "HUMAN_EDITING" /\ to \in {"VERIFYING", "IMPLEMENTING"})
     \/ (state \in {"IMPLEMENTING", "REPAIRING"} /\ to = "HUMAN_EDITING")
     \/ (state = "BLOCKED" /\ to = blockedFrom)
     \/ to = "CANCELLED"
  /\ Move(to)
  /\ FreshCode(to)
  /\ binding' = IF to \in Driven THEN "active" ELSE "finished"
  /\ UNCHANGED <<repairs, reclaims, everVerified>>

HumanAct == \E to \in States : Human(to)

Stall ==
  /\ binding = "active"
  /\ binding' = "stalled"
  /\ UNCHANGED <<state, blockedFrom, verdict, repairs, reclaims, everVerified>>

Reclaim ==
  /\ binding = "stalled"
  /\ state \notin Terminal
  /\ reclaims < MaxReclaims
  /\ reclaims' = reclaims + 1
  /\ binding' = "active"
  /\ UNCHANGED <<state, blockedFrom, verdict, repairs, everVerified>>

GiveUp ==
  /\ binding = "stalled"
  /\ state \notin Terminal
  /\ reclaims = MaxReclaims
  /\ binding' = "finished"
  /\ IF Legal(state, "FAILED", blockedFrom)
       THEN state' = "FAILED" /\ blockedFrom' = "none"
       ELSE UNCHANGED <<state, blockedFrom>>
  /\ UNCHANGED <<verdict, repairs, reclaims, everVerified>>

Release ==
  /\ binding = "stalled"
  /\ state \in Terminal
  /\ binding' = "finished"
  /\ UNCHANGED <<state, blockedFrom, verdict, repairs, reclaims, everVerified>>

Next ==
  \/ \E to \in States : Drive(to) \/ DriveStop(to) \/ Human(to)
  \/ Verify
  \/ Stall
  \/ Reclaim
  \/ GiveUp
  \/ Release

Fairness ==
  /\ \A to \in States : WF_vars(Drive(to))
  /\ WF_vars(Verify)
  /\ WF_vars(Reclaim)
  /\ WF_vars(GiveUp)
  /\ WF_vars(Release)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------

NoPRWithoutPass == state \in PRStates => verdict = "pass"

CompletedWasVerified == state = "COMPLETED" => everVerified

RepairsBounded == repairs <= MaxRepairs

ExecutionsOnlyDriveDrivenStates == binding = "active" => state \in Driven

BlockedRemembers == (state = "BLOCKED") <=> (blockedFrom # "none")

SafetyInvariants ==
  /\ TypeOK
  /\ NoPRWithoutPass
  /\ CompletedWasVerified
  /\ RepairsBounded
  /\ ExecutionsOnlyDriveDrivenStates
  /\ BlockedRemembers

StepsAreLegal == [][state' # state => Legal(state, state', blockedFrom)]_vars

TerminalIsAbsorbing == [][(state \in Terminal) => state' = state]_vars

-----------------------------------------------------------------------------

Settled == state \in Terminal \cup HumanWait

HumansStop == <>[][~HumanAct]_vars

EventuallyQuiet == HumansStop => <>[](Settled \/ binding = "finished")

NoRunStranded == HumansStop => <>[](Settled \/ binding # "finished")

=============================================================================
