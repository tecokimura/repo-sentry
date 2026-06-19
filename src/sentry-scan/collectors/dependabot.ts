import { completeCollector, failCollector, startCollector } from "./common.ts";
import type {
  CollectorResult,
  DependabotSourceStatus,
  Finding,
  FindingStatus,
  ScanRequest,
} from "../types.ts";
import { toSeverity } from "../../shared/utils.ts";

const githubApiBase = "https://api.github.com";

interface GitHubRepoResponse {
  archived?: boolean;
  private?: boolean;
  full_name?: string;
}

interface DependabotAlert {
  number?: number;
  state?: string;
  html_url?: string;
  dependency?: {
    package?: {
      ecosystem?: string;
      name?: string;
    };
    manifest_path?: string;
  };
  security_advisory?: {
    ghsa_id?: string;
    cve_id?: string;
    summary?: string;
    description?: string;
    severity?: string;
    identifiers?: Array<{
      type?: string;
      value?: string;
    }>;
  };
  security_vulnerability?: {
    package?: {
      ecosystem?: string;
      name?: string;
    };
    vulnerable_version_range?: string;
    first_patched_version?: {
      identifier?: string;
    } | null;
  };
}

export async function collectDependabot(request: ScanRequest): Promise<CollectorResult> {
  const timing = startCollector();

  if (!request.repo) {
    return failCollector("dependabot", timing, "--repo is required for dependabot");
  }

  if (!request.githubToken) {
    return failCollector("dependabot", timing, "GITHUB_TOKEN is required for dependabot", {
      sourceStatus: "permission_missing",
      notes: ["Set GITHUB_TOKEN with Dependabot alerts read access"],
    });
  }

  try {
    const repoResponse = await githubFetch(`/repos/${request.repo}`, request.githubToken);
    if (repoResponse.status === 404) {
      return failCollector("dependabot", timing, "Repository not found or token cannot access it", {
        sourceStatus: "permission_missing",
      });
    }
    if (repoResponse.status === 403) {
      return failCollector("dependabot", timing, "GitHub API permission denied for repository", {
        sourceStatus: "permission_missing",
      });
    }
    if (!repoResponse.ok) {
      return failCollector(
        "dependabot",
        timing,
        `GitHub repository API returned ${repoResponse.status}`,
        { sourceStatus: "unknown" },
      );
    }

    const repo = await repoResponse.json() as GitHubRepoResponse;
    if (repo.archived) {
      const status = completeCollector("dependabot", timing, 0, {
        sourceStatus: "repo_archived",
        notes: ["Repository is archived"],
      });
      return { status, findings: [] };
    }

    const vulnerabilityStatus = await githubFetch(
      `/repos/${request.repo}/vulnerability-alerts`,
      request.githubToken,
    );
    const alertsEnabled = vulnerabilityStatus.status === 204;
    const vulnerabilityEndpointWas404 = vulnerabilityStatus.status === 404;

    const alertsResponse = await githubFetch(
      `/repos/${request.repo}/dependabot/alerts?state=open&per_page=100`,
      request.githubToken,
    );

    if (alertsResponse.status === 403) {
      return failCollector("dependabot", timing, "Token cannot read Dependabot alerts", {
        sourceStatus: "permission_missing",
        notes: ["Fine-grained tokens need Dependabot alerts read access"],
      });
    }

    if (alertsResponse.status === 404) {
      const sourceStatus: DependabotSourceStatus = alertsEnabled
        ? "permission_missing"
        : vulnerabilityEndpointWas404
        ? "disabled"
        : "unknown";
      return failCollector("dependabot", timing, "Dependabot alerts API returned 404", {
        sourceStatus,
        notes: [
          "404 can mean disabled alerts, missing permission, or repository invisibility",
        ],
      });
    }

    if (!alertsResponse.ok) {
      return failCollector(
        "dependabot",
        timing,
        `Dependabot alerts API returned ${alertsResponse.status}`,
        { sourceStatus: "unknown" },
      );
    }

    const alerts = await alertsResponse.json() as DependabotAlert[];

    let nextUrl = nextPageUrl(alertsResponse.headers.get("link"));
    while (nextUrl) {
      const pageResponse = await githubFetch(nextUrl, request.githubToken);
      if (!pageResponse.ok) {
        return failCollector(
          "dependabot",
          timing,
          `Dependabot alerts API returned ${pageResponse.status} while paginating`,
          { sourceStatus: "unknown" },
        );
      }
      alerts.push(...await pageResponse.json() as DependabotAlert[]);
      nextUrl = nextPageUrl(pageResponse.headers.get("link"));
    }

    const findings = normalizeDependabotAlerts(alerts);
    const sourceStatus: DependabotSourceStatus = findings.length > 0
      ? "enabled_with_alerts"
      : alertsEnabled
      ? "enabled_no_alerts"
      : vulnerabilityEndpointWas404
      ? "disabled"
      : "unknown";

    const status = completeCollector("dependabot", timing, findings.length, {
      sourceStatus,
      notes: alertsEnabled ? [] : ["Dependency alerts enabled state was not confirmed as enabled"],
    });

    return { status, findings };
  } catch (error) {
    return failCollector("dependabot", timing, error, { sourceStatus: "unknown" });
  }
}

export function normalizeDependabotAlerts(alerts: DependabotAlert[]): Finding[] {
  return alerts.map((alert) => {
    const advisory = alert.security_advisory;
    const vulnerability = alert.security_vulnerability;
    const dependencyPackage = alert.dependency?.package ?? vulnerability?.package;
    const packageName = dependencyPackage?.name;
    const ecosystem = dependencyPackage?.ecosystem;
    const manifestPath = alert.dependency?.manifest_path;
    const identifiers = advisory?.identifiers?.map((identifier) => identifier.value ?? "")
      .filter(Boolean) ?? [];

    return {
      id: alert.number ? `dependabot-${alert.number}` : advisory?.ghsa_id,
      tool: "dependabot",
      category: "dependency-vulnerability",
      severity: toSeverity(advisory?.severity),
      title: advisory?.summary ?? `Dependabot alert for ${packageName ?? "dependency"}`,
      description: advisory?.description,
      location: manifestPath,
      status: toFindingStatus(alert.state),
      url: alert.html_url,
      identifiers,
      packageName: packageName ? `${ecosystem ?? "package"}:${packageName}` : undefined,
      packageVersion: vulnerability?.vulnerable_version_range,
      raw: alert,
    };
  });
}

function toFindingStatus(state: unknown): FindingStatus {
  if (state === "open") return "open";
  if (state === "fixed") return "fixed";
  if (state === "dismissed") return "dismissed";
  return "unknown";
}

function nextPageUrl(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match && match[1].startsWith(githubApiBase)) return match[1];
  }
  return undefined;
}

function githubFetch(pathOrUrl: string, token: string): Promise<Response> {
  const url = pathOrUrl.startsWith(githubApiBase) ? pathOrUrl : `${githubApiBase}${pathOrUrl}`;
  return fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "repo-sentry",
    },
  });
}
