/**
 * Build-time environment marker (matches armoriq-sdk-customer/_build_env.py).
 *
 * This file is one of two intentional divergence points between the
 * `dev` and `main` branches. Merging dev → main will conflict here and
 * in `package.json` (different `version` + `bin` name) — that's
 * intentional, so the release owner consciously flips both defaults
 * before publishing prod.
 *
 *   main branch  →  ARMORIQ_ENV = "production"  (prod URLs; published as @armoriq/sdk)
 *                   package.json bin = "armoriq"
 *   dev  branch  →  ARMORIQ_ENV = "staging"     (staging URLs; published as @armoriq/sdk-dev)
 *                   package.json bin = "armoriq-dev"
 *
 * The dev branch's bin is renamed to `armoriq-dev` so it can coexist
 * with the prod `@armoriq/sdk` on the same machine without npm-bin
 * collisions (which would otherwise cause silent PATH shadowing — a
 * staging-targeted plugin would mint prod-scoped credentials).
 *
 * The baked constant is the branch-baked default. Set ARMORIQ_ENV=local
 * (or staging/production) in your shell to override at runtime. Per-
 * endpoint env vars (BACKEND_ENDPOINT / IAP_ENDPOINT / PROXY_ENDPOINT)
 * and constructor args still win over both.
 */

export type EnvName = 'production' | 'staging' | 'local';

export const ARMORIQ_ENV: EnvName = 'staging';

// Endpoint table — keep in sync with GCP Cloud Run domain mappings.
//   prod:
//     api.armoriq.ai    → conmap-auto             (us-central1)
//     iap.armoriq.ai    → csrg-execution-service  (us-central1)
//     proxy.armoriq.ai  → armoriq-proxy-server    (us-central1)
//   staging:
//     staging-api.armoriq.ai          → conmap-auto-staging            (us-central1)
//     iap-staging.armoriq.ai          → csrg-execution-service-staging (us-central1)
//     cloud-run-proxy.armoriq.io      → armoriq-proxy-dev              (europe-west1)
//   local: same ports the Python SDK uses.
export const ENDPOINTS: Record<EnvName, { backend: string; proxy: string; iap: string }> = {
  production: {
    backend: 'https://api.armoriq.ai',
    proxy: 'https://proxy.armoriq.ai',
    iap: 'https://iap.armoriq.ai',
  },
  staging: {
    backend: 'https://staging-api.armoriq.ai',
    proxy: 'https://cloud-run-proxy.armoriq.io',
    iap: 'https://iap-staging.armoriq.ai',
  },
  local: {
    backend: 'http://127.0.0.1:3000',
    proxy: 'http://127.0.0.1:3001',
    iap: 'http://127.0.0.1:8080',
  },
};

export type EndpointKind = 'backend' | 'proxy' | 'iap';

function activeEnv(): EnvName {
  const override = (process.env.ARMORIQ_ENV || '').trim().toLowerCase();
  if (override === 'production' || override === 'staging' || override === 'local') {
    return override;
  }
  return ARMORIQ_ENV;
}

export function resolveEndpoint(kind: EndpointKind): string {
  return ENDPOINTS[activeEnv()][kind];
}
