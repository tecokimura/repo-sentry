export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export function parseSemVer(v: string): SemVer | null {
  const clean = v.replace(/^[vV]/, "").split(/[-+]/)[0];
  const parts = clean.split(".").map(Number);
  if (parts.length < 1 || parts.some((n) => isNaN(n))) return null;
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0, raw: clean };
}

export function cmpSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** 現在バージョンの同一メジャー内で current より大きい最小バージョン。なければ全体で最小。*/
export function computeRecommendedVersion(
  currentVersion?: string,
  fixedVersions?: string[],
): string | undefined {
  if (!fixedVersions?.length || !currentVersion) return undefined;
  const current = parseSemVer(currentVersion);
  if (!current) return undefined;

  const parsed = fixedVersions
    .map(parseSemVer)
    .filter((v): v is SemVer => v !== null);

  const sameMajor = parsed
    .filter((v) => v.major === current.major && cmpSemVer(v, current) > 0)
    .sort(cmpSemVer);
  if (sameMajor.length > 0) return sameMajor[0].raw;

  const newer = parsed.filter((v) => cmpSemVer(v, current) > 0).sort(cmpSemVer);
  return newer[0]?.raw;
}

/** 現在バージョンの同一メジャー以上で current より大きいバージョン一覧（昇順）。*/
export function filterAvailableVersions(
  fixedVersions: string[],
  currentVersion?: string,
): string[] {
  if (!currentVersion) {
    return fixedVersions
      .map(parseSemVer)
      .filter((v): v is SemVer => v !== null)
      .sort(cmpSemVer)
      .map((v) => v.raw);
  }
  const current = parseSemVer(currentVersion);
  if (!current) return fixedVersions;

  return fixedVersions
    .map(parseSemVer)
    .filter((v): v is SemVer => v !== null)
    .filter((v) => v.major >= current.major && cmpSemVer(v, current) > 0)
    .sort(cmpSemVer)
    .map((v) => v.raw);
}
