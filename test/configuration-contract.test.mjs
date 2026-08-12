import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the public Configuration Contract is versioned and fail-closed", () => {
  const contract = JSON.parse(
    readFileSync(
      resolve(repositoryRoot, "config/configuration-contract.schema.json"),
      "utf8",
    ),
  );

  assert.equal(contract.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(contract.properties.apiVersion.const, "openab.dev/v1alpha1");
  assert.deepEqual(contract.properties.kind.enum, [
    "SyntheticInstallation",
    "Installation",
  ]);
  assert.equal(contract.additionalProperties, false);
  assert.equal(
    contract.properties.policy.properties.reviewerDiversity.default,
    "distinct-serving-providers",
  );
  assert.equal(contract.$defs.secretReference.additionalProperties, false);
  assert.equal(contract.$defs.placeholder.additionalProperties, false);
  assert.match(contract.description, /private Installation/i);
  assert.match(contract.description, /Secret Material/i);
});
