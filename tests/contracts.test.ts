import assert from "node:assert/strict";
import test from "node:test";
import {
  contractFromInput,
  contractHash,
  parseContractMarkdown,
  renderContract,
  renderLinearContract,
  replaceLinearContractSection,
  validateContract,
} from "../extensions/orchestration/contracts.ts";

const feature = contractFromInput({
  kind: "feature",
  title: "Appointment reminders",
  outcome: "Reduce missed appointments.",
  context: "Users need automated reminders.",
  inScope: ["SMS reminders"],
  outOfScope: ["Voice reminders"],
  acceptanceCriteria: ["Reminder sends 24 hours before appointment"],
  constraints: ["Respect tenant timezone"],
  dependencies: ["Calendar integration"],
  validation: ["Unit and integration tests"],
  rollout: ["Feature flag"],
  documentation: ["Update user help"],
});

test("validates and renders a complete local-only feature contract", () => {
  assert.deepEqual(validateContract(feature), []);
  const markdown = renderContract(feature);
  assert.match(markdown, /GitHub\/docs-only; no Linear mutation\./);
  assert.match(markdown, /^# Feature Contract: Appointment reminders/m);
  assert.match(markdown, /## Acceptance criteria/);
  assert.match(markdown, /- Reminder sends 24 hours before appointment/);
});

test("requires bug reproduction and regression coverage", () => {
  const bug = contractFromInput({
    kind: "bug",
    title: "Transfer disconnect",
    linear: { team: "DEMO" },
    impact: "Calls drop",
    environment: "Production",
    expectedBehavior: "Transfer succeeds",
    actualBehavior: "Call disconnects",
    acceptanceCriteria: ["Transfer succeeds"],
  });
  assert.deepEqual(validateContract(bug), [
    "bug reproduction steps are required",
    "regression-test requirements are required",
  ]);
});

test("round-trips operator Markdown edits into the typed contract", () => {
  const markdown = renderContract(feature)
    .replace("Reduce missed appointments.", "Reduce missed appointments by 20%.")
    .replace("- Feature flag", "- Pilot tenant first");
  const edited = parseContractMarkdown(markdown, feature);
  assert.equal(edited.kind, "feature");
  assert.equal(edited.outcome, "Reduce missed appointments by 20%.");
  assert.deepEqual(edited.rollout, ["Pilot tenant first"]);
  assert.deepEqual(validateContract(edited), []);
});

test("replaces only the managed Linear contract section", () => {
  const first = renderLinearContract(feature, "2026-01-01T00:00:00.000Z");
  const second = renderLinearContract({ ...feature, version: 2 }, "2026-01-02T00:00:00.000Z");
  const description = `Human context\n\n${first}\n\nHuman footer`;
  const replaced = replaceLinearContractSection(description, second);
  assert.match(replaced, /^Human context/);
  assert.match(replaced, /Contract version:\*\* 2/);
  assert.match(replaced, /Human footer$/);
  assert.equal((replaced.match(/<!-- pi-contract:start -->/g) ?? []).length, 1);
});

test("contract hash is stable across object key order", () => {
  assert.equal(contractHash(feature), contractHash({ ...feature }));
  assert.match(contractHash(feature), /^sha256:[a-f0-9]{64}$/);
});
