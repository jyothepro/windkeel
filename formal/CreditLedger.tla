---------------------------- MODULE CreditLedger ----------------------------
(***************************************************************************)
(* One credit account and its runs, as a model the TLC model checker       *)
(* explores exhaustively. See formal/README.md.                            *)
(*                                                                         *)
(* What is modelled, and where it lives in the code:                       *)
(*  - Spend order: prepaid credits first, then overage                     *)
(*    (allocate in src/factory/config/credits.ts).                         *)
(*  - Billed overage is clamped at the cap in force when the cost is       *)
(*    recorded; the rest is recorded and never billed (Bill below;         *)
(*    billableOverageMicro in credits.ts; ADR-0040 §5, #439).              *)
(*  - A maker step starts only when the account is admitted, and runs to   *)
(*    its end whatever it spends; verification follows and is never cut    *)
(*    short or refused for credits (ADR-0040 §5, #439).                    *)
(*  - Compute is rounded once per run: the seconds billed for a run are    *)
(*    always one ceiling of its total time (priceCostLines, #439).         *)
(*  - An admin may turn overage on or off and set any cap at any time.     *)
(*                                                                         *)
(* Units are scaled down: a credit is 1, a second is Unit time ticks, and  *)
(* a second of compute costs one credit.                                   *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Prepaid, Caps, MaxCharge, MaxCharges, Unit

Min(a, b) == IF a < b THEN a ELSE b
Max(a, b) == IF a > b THEN a ELSE b
CeilDiv(a, b) == (a + b - 1) \div b

Phases == {"idle", "making", "verifying"}

VARIABLES left, billed, unbilled, spent, overageOn, cap, capHigh, phase, charges, ms, secs

vars == <<left, billed, unbilled, spent, overageOn, cap, capHigh, phase, charges, ms, secs>>

TypeOK ==
  /\ left \in 0..Prepaid
  /\ billed \in Nat
  /\ unbilled \in Nat
  /\ spent \in Nat
  /\ overageOn \in BOOLEAN
  /\ cap \in Caps
  /\ capHigh \in Caps
  /\ phase \in Phases
  /\ charges \in 0..MaxCharges
  /\ ms \in Nat
  /\ secs \in Nat

Admits == left > 0 \/ (overageOn /\ billed < cap)

Bill(over) == IF overageOn THEN Min(over, IF cap > billed THEN cap - billed ELSE 0) ELSE 0

Init ==
  /\ left = Prepaid
  /\ billed = 0
  /\ unbilled = 0
  /\ spent = 0
  /\ overageOn \in BOOLEAN
  /\ cap \in Caps
  /\ capHigh = cap
  /\ phase = "idle"
  /\ charges = 0
  /\ ms = 0
  /\ secs = 0

Spend(a) ==
  LET take == Min(a, left)
      over == a - take
      bill == Bill(over)
  IN /\ left' = left - take
     /\ billed' = billed + bill
     /\ unbilled' = unbilled + (over - bill)
     /\ spent' = spent + a

StartStep ==
  /\ phase = "idle"
  /\ Admits
  /\ phase' = "making"
  /\ UNCHANGED <<left, billed, unbilled, spent, overageOn, cap, capHigh, charges, ms, secs>>

EndStep ==
  /\ phase = "making"
  /\ phase' = "verifying"
  /\ UNCHANGED <<left, billed, unbilled, spent, overageOn, cap, capHigh, charges, ms, secs>>

EndVerification ==
  /\ phase = "verifying"
  /\ phase' = "idle"
  /\ UNCHANGED <<left, billed, unbilled, spent, overageOn, cap, capHigh, charges, ms, secs>>

ChargeAI(a) ==
  /\ phase \in {"making", "verifying"}
  /\ charges < MaxCharges
  /\ a \in 1..MaxCharge
  /\ Spend(a)
  /\ charges' = charges + 1
  /\ UNCHANGED <<overageOn, cap, capHigh, phase, ms, secs>>

ChargeCompute(d) ==
  /\ phase \in {"making", "verifying"}
  /\ charges < MaxCharges
  /\ d \in 1..MaxCharge
  /\ ms' = ms + d
  /\ secs' = Max(secs, CeilDiv(ms + d, Unit))
  /\ Spend(Max(secs, CeilDiv(ms + d, Unit)) - secs)
  /\ charges' = charges + 1
  /\ UNCHANGED <<overageOn, cap, capHigh, phase>>

Settings ==
  /\ \E on \in BOOLEAN, c \in Caps :
       /\ overageOn' = on
       /\ cap' = c
       /\ capHigh' = Max(capHigh, c)
  /\ UNCHANGED <<left, billed, unbilled, spent, phase, charges, ms, secs>>

Next ==
  \/ StartStep
  \/ EndStep
  \/ EndVerification
  \/ \E a \in 1..MaxCharge : ChargeAI(a) \/ ChargeCompute(a)
  \/ Settings

Spec == Init /\ [][Next]_vars /\ WF_vars(EndStep) /\ WF_vars(EndVerification)

-----------------------------------------------------------------------------

BilledWithinCap == billed <= capHigh

SpendIsConserved == spent = (Prepaid - left) + billed + unbilled

RoundedOnce == secs = CeilDiv(ms, Unit)

SafetyInvariants ==
  /\ TypeOK
  /\ BilledWithinCap
  /\ SpendIsConserved
  /\ RoundedOnce

NeverBillsPastTheCapInForce == [][billed' - billed <= IF cap > billed THEN cap - billed ELSE 0]_vars

StepsStartOnlyWhenAdmitted == [][(phase = "idle" /\ phase' = "making") => Admits]_vars

VerificationAlwaysFinishes == phase = "verifying" ~> phase = "idle"

StepsAlwaysFinish == phase = "making" ~> phase = "verifying"

=============================================================================
