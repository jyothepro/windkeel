-- Billed overage stops at the overage cap (#439, ADR-0040 §5 as amended 2026-11-09).
--
-- A step already under way when an account reaches its overage cap runs on to its end; what it
-- spends past the cap is recorded as overage and never billed. One cost line can cross the cap, so
-- whether a debit's overage is billed is now an amount, not a yes or no:
-- `overage_billable_micro` is how much of `overage_micro` is billed.
--
-- Additive. A nullable column with a check. Rows written before it keep null, and their billed
-- amount stays what it was: `overage_micro` when `overage_billable`, else 0. New code writes
-- `overage_billable` true only when the whole overage is billed, so code older than this file reads
-- a partly billed row as unbilled: it can under-report to the meter during a deploy, never
-- over-report, and the next report from new code sends the rest.
--
-- No object here is schema-qualified (ADR-0024 §11).

alter table credit_debit
  add column overage_billable_micro bigint
    check (overage_billable_micro is null or (overage_billable_micro >= 0 and overage_billable_micro <= overage_micro));
