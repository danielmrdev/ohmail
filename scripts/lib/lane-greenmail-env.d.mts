/** Declarations for `lane-greenmail-env.mjs`, so the tests and helpers that import it typecheck. */
export declare const LANE_GREENMAIL_ENV_FILE: string;
export declare const LANE_GREENMAIL_PREFIX: string;
export declare const LANE_GREENMAIL_PROJECT_RE: RegExp;
export declare const LANE_GREENMAIL_VARS: readonly ["IMAP_HOST", "IMAP_PORT", "SMTP_HOST", "SMTP_PORT"];
export declare const SHARED_GREENMAIL_PORTS: ReadonlySet<number>;
export declare const LANE_PORT_BASE: number;
export declare const LANE_PORT_SLOTS: number;
export interface LaneGreenmail {
  project: string;
  vars: { IMAP_HOST: string; IMAP_PORT: string; SMTP_HOST: string; SMTP_PORT: string };
}
export interface GreenmailEndpoint {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** The lane project the endpoint belongs to, `null` on the environment or the shared box. */
  lane: string | null;
}
export declare function laneGreenmailKey(worktreePath: string): string;
export declare function laneGreenmailProject(worktreePath: string): string;
export declare function assertLaneGreenmailProject(name: string): string;
export declare function lanePorts(key: string, attempt?: number): { imap: number; smtp: number };
export declare function parseLaneGreenmailEnv(text: string, where?: string): LaneGreenmail;
export declare function readLaneGreenmail(root: string): LaneGreenmail | null;
export declare function applyLaneGreenmail(env: NodeJS.ProcessEnv, lane: LaneGreenmail | null): string[];
export declare function greenmailEndpoint(env: NodeJS.ProcessEnv, lane: LaneGreenmail | null): GreenmailEndpoint;
export declare const DOCKER_DEFAULT_POOLS: { base: string; size: number }[];
export declare function poolCapacity(pools: { base: string; size: number }[]): number;
export declare const DOCKER_OWNED_DEV: RegExp;
export declare function routeSkipped(pools: { base: string; size: number }[], routes: { dst: string; dev?: string }[]): { skipped: number; routes: string[] };
export declare function networkPoolReading(input: {
  bridge: number; lanes: number; orphans: number; pools: { base: string; size: number }[]; source: string;
  routes: { dst: string; dev?: string }[]; minFree?: number;
}): { rc: number; free: number; lines: string[] };
