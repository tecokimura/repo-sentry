import { normalizeDependabotAlerts } from "../src/collectors/dependabot.ts";
import { normalizeGitleaksReport } from "../src/collectors/gitleaks.ts";
import { normalizeTrivyReport } from "../src/collectors/trivy.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("normalizeGitleaksReport maps leaks to secret findings", () => {
  const findings = normalizeGitleaksReport([
    {
      RuleID: "github-pat",
      Description: "GitHub Personal Access Token",
      File: "src/config.ts",
      StartLine: 18,
      Fingerprint: "abc123",
    },
  ], "reports/raw/gitleaks.json");

  assertEquals(findings.length, 1);
  assertEquals(findings[0].tool, "gitleaks");
  assertEquals(findings[0].category, "secret");
  assertEquals(findings[0].severity, "high");
  assertEquals(findings[0].location, "src/config.ts:18");
  assertEquals(findings[0].rawReportPath, "reports/raw/gitleaks.json");
});

Deno.test("normalizeTrivyReport maps vulnerabilities and misconfigurations", () => {
  const findings = normalizeTrivyReport({
    Results: [
      {
        Target: "package-lock.json",
        Type: "npm",
        Vulnerabilities: [
          {
            VulnerabilityID: "CVE-2026-0001",
            PkgName: "example",
            InstalledVersion: "1.0.0",
            Severity: "CRITICAL",
            Title: "Example vulnerability",
            PrimaryURL: "https://example.test/cve",
          },
        ],
      },
      {
        Target: "main.tf",
        Type: "terraform",
        Misconfigurations: [
          {
            ID: "AVD-AWS-0001",
            Title: "Public bucket",
            Severity: "HIGH",
            CauseMetadata: {
              StartLine: 7,
            },
          },
        ],
      },
    ],
  }, "reports/raw/trivy.json");

  assertEquals(findings.length, 2);
  assertEquals(findings[0].category, "dependency-vulnerability");
  assertEquals(findings[0].severity, "critical");
  assertEquals(findings[1].category, "iac-misconfiguration");
  assertEquals(findings[1].location, "main.tf:7");
});

Deno.test("normalizeDependabotAlerts maps GitHub alerts", () => {
  const findings = normalizeDependabotAlerts([
    {
      number: 42,
      state: "open",
      html_url: "https://github.com/owner/name/security/dependabot/42",
      dependency: {
        package: {
          ecosystem: "npm",
          name: "left-pad",
        },
        manifest_path: "package-lock.json",
      },
      security_advisory: {
        ghsa_id: "GHSA-xxxx-yyyy-zzzz",
        cve_id: "CVE-2026-0002",
        summary: "Example advisory",
        severity: "high",
        identifiers: [
          { type: "GHSA", value: "GHSA-xxxx-yyyy-zzzz" },
          { type: "CVE", value: "CVE-2026-0002" },
        ],
      },
      security_vulnerability: {
        vulnerable_version_range: "< 1.2.3",
        package: {
          ecosystem: "npm",
          name: "left-pad",
        },
      },
    },
  ]);

  assertEquals(findings.length, 1);
  assertEquals(findings[0].tool, "dependabot");
  assertEquals(findings[0].severity, "high");
  assertEquals(findings[0].location, "package-lock.json");
  assertEquals(findings[0].packageName, "npm:left-pad");
  assert(Array.isArray(findings[0].identifiers), "identifiers should be present");
});
