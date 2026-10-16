import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SOURCE ROOTS THE PUBLIC REPOSITORY CARRIES, read off the disk: every app's `src` and `app`
 * and every package's `src`. The operator console's app is the private remainder and is
 * excluded BY NAME, so a checkout that still holds it and one that never did read the same roots.
 */
export const PRIVATE_APPS = ["admin"];

export function publishedSourceRoots(root: string): string[] {
  const out: string[] = [];
  const dirs = (rel: string): string[] => (existsSync(join(root, rel))
    ? readdirSync(join(root, rel)).filter((d) => statSync(join(root, rel, d)).isDirectory()).sort()
    : []);
  for (const app of dirs("apps")) {
    if (PRIVATE_APPS.includes(app)) continue;
    for (const sub of ["src", "app"]) if (existsSync(join(root, "apps", app, sub))) out.push(`apps/${app}/${sub}`);
  }
  for (const pkg of dirs("packages")) if (existsSync(join(root, "packages", pkg, "src"))) out.push(`packages/${pkg}/src`);
  return out;
}
