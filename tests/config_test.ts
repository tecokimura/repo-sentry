import { parseRunOptions } from "../src/config.ts";
import { assertEquals } from "./assert.ts";

Deno.test("parseRunOptions parses the MVP run command", () => {
  const options = parseRunOptions([
    "run",
    "--path",
    "./target-repo",
    "--repo",
    "owner/name",
    "--tools",
    "gitleaks,trivy,dependabot",
    "--format",
    "markdown",
    "--output",
    "./reports/latest.md",
  ]);

  assertEquals(options.path, "./target-repo");
  assertEquals(options.repo, "owner/name");
  assertEquals(options.tools, ["gitleaks", "trivy", "dependabot"]);
  assertEquals(options.format, "markdown");
  assertEquals(options.output, "./reports/latest.md");
});

Deno.test("parseRunOptions excludes clearwing from all", () => {
  const options = parseRunOptions([
    "run",
    "--path",
    "./target-repo",
    "--repo",
    "owner/name",
    "--tools",
    "all",
  ]);

  assertEquals(options.tools, ["gitleaks", "trivy", "dependabot"]);
});

Deno.test("parseRunOptions requires explicit Clearwing risk acknowledgement", () => {
  const options = parseRunOptions([
    "run",
    "--path",
    "./target-repo",
    "--tools",
    "clearwing",
    "--clearwing-depth",
    "quick",
    "--clearwing-ack-risk",
  ]);

  assertEquals(options.clearwingAckRisk, true);
  assertEquals(options.clearwingDepth, "quick");
});
