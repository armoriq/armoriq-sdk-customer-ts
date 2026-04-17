/**
 * Build-time environment marker (matches armoriq-sdk-customer/_build_env.py).
 *
 * This file is the ONLY difference between the `dev` and `main` branches.
 * Merging dev → main conflicts on the `ARMORIQ_ENV` constant below —
 * that's intentional, so the release owner consciously flips the default
 * before publishing prod.
 *
 *   main branch  →  ARMORIQ_ENV = "production"  (SDK defaults to api.armoriq.ai)
 *   dev  branch  →  ARMORIQ_ENV = "staging"     (SDK defaults to staging-api.armoriq.ai)
 *
 * Runtime overrides (same precedence as Python SDK):
 *   1. explicit constructor args on ArmorIQClient
 *   2. ARMORIQ_ENV / BACKEND_ENDPOINT / IAP_ENDPOINT / PROXY_ENDPOINT env vars
 *   3. baked-in ARMORIQ_ENV below
 */

export const ARMORIQ_ENV: 'production' | 'staging' = 'production';

// Endpoint table — keep in sync with GCP Cloud Run domain mappings.
//   prod:
//     api.armoriq.ai    → conmap-auto             (us-central1)
//     iap.armoriq.ai    → csrg-execution-service  (us-central1)
//     proxy.armoriq.ai  → armoriq-proxy-server    (us-central1)
//   staging:
//     staging-api.armoriq.ai          → conmap-auto-staging            (us-central1)
//     csrg-execution-service-staging* → csrg-execution-service-staging (us-central1, no custom domain)
//     cloud-run-proxy.armoriq.io      → armoriq-proxy-dev              (europe-west1)
export const ENDPOINTS = {
  production: {
    backend: 'https://api.armoriq.ai',
    proxy: 'https://proxy.armoriq.ai',
    iap: 'https://iap.armoriq.ai',
  },
  staging: {
    backend: 'https://staging-api.armoriq.ai',
    proxy: 'https://cloud-run-proxy.armoriq.io',
    iap: 'https://csrg-execution-service-staging-77dabykria-uc.a.run.app',
  },
} as const;

export type EndpointKind = 'backend' | 'proxy' | 'iap';

export function resolveEndpoint(kind: EndpointKind): string {
  const override = (process.env.ARMORIQ_ENV?.toLowerCase() ?? ARMORIQ_ENV) as
    | 'production'
    | 'staging';
  const env = override === 'staging' ? 'staging' : 'production';
  return ENDPOINTS[env][kind];
}
