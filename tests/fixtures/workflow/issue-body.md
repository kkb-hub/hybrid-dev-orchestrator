## Problem / Context

The HDO workflow parity harness needs a deterministic Issue body that drives the full plan -> implement -> validate -> review loop without any real GitHub or agent dependency.

## Goal

Exercise the bounded workflow loop end to end using only deterministic mock adapters.

## In scope

- Deterministic fixture-driven workflow scenarios

## Out of scope

- Real GitHub writeback

## Acceptance Criteria

- AC-01: The workflow reaches a terminal state deterministically.
- AC-02: Validation gate results are classified deterministically.

## Validation Gate IDs

__VALIDATION_GATES__

## Constraints

- Do not require network access.

## Dependencies

_No response_

## Affected Areas

- workflow

## Additional Context

_No response_
