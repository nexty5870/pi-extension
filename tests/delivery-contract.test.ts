import assert from "node:assert/strict";
import test from "node:test";
import { contractFromInput, contractHash, parseContractMarkdown, renderContract, validateContract } from "../extensions/orchestration/contracts.ts";

const input = {
  kind: "feature" as const, title: "Safe export", outcome: "Export safely", context: "Needed",
  inScope: ["Export"], acceptanceCriteria: ["Works"], validation: ["Tests"],
  delivery: { baseBranch: "main", branchName: "feat/safe-export", commitMessage: "feat: safe export", prTitle: "Safe export", prBody: "Implements approved export.", checks: [["npm", "test"], ["npm", "run", "typecheck"]] },
};
test("delivery metadata validates and round-trips through Markdown", () => {
  const contract = contractFromInput(input); assert.deepEqual(validateContract(contract), []);
  const parsed = parseContractMarkdown(renderContract(contract), contract);
  assert.deepEqual(parsed.delivery, contract.delivery); assert.equal(contractHash(parsed), contractHash(contract));
});
test("delivery argv and branch safety fail closed and affect hash", () => {
  const contract = contractFromInput({ ...input, delivery: { ...input.delivery, branchName: "../unsafe", checks: [[]] } });
  assert.match(validateContract(contract).join(" "), /branch name is unsafe/); assert.match(validateContract(contract).join(" "), /argv arrays/);
  const safe = contractFromInput(input); assert.notEqual(contractHash(safe), contractHash({ ...safe, delivery: { ...safe.delivery!, prTitle: "Changed" } }));
});
