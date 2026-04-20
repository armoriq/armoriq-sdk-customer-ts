/**
 * Build-time environment marker (matches armoriq-sdk-customer/_build_env.py).
 *
 * This file is the ONLY difference between the `dev` and `main` branches.
 * Merging dev → main conflicts on the `ARMORIQ_ENV` constant below —
 * that's intentional, so the release owner consciously flips the default
 * before publishing prod.
 *
 *   main branch  →  ARMORIQ_ENV = "production"  (prod URLs; published as stable)
 *   dev  branch  →  ARMORIQ_ENV = "staging"     (staging URLs; published as -dev)
 *
 * The baked constant is the ONLY source of truth — no runtime env-var
 * override. To point the SDK at staging, install the dev build; to
 * override a specific endpoint for testing, pass `backendEndpoint:` etc.
 * to the ArmorIQClient constructor or set BACKEND_ENDPOINT / IAP_ENDPOINT
 * / PROXY_ENDPOINT env vars.
 */

export const ARMORIQ_ENV: 'production' | 'staging' = 'production';

// Endpoint table — keep in sync with GCP Cloud Run domain mappings.
//   prod:
//     api.armoriq.ai    → conmap-auto             (us-central1)
//     iap.armoriq.ai    → csrg-execution-service  (us-central1)
//     proxy.armoriq.ai  → armoriq-proxy-server    (us-central1)
//   staging:
//     staging-api.armoriq.ai          → conmap-auto-staging            (us-central1)
//     iap-staging.armoriq.ai          → csrg-execution-service-staging (us-central1)
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
    iap: 'https://iap-staging.armoriq.ai',
  },
} as const;

export type EndpointKind = 'backend' | 'proxy' | 'iap';

export function resolveEndpoint(kind: EndpointKind): string {
  return ENDPOINTS[ARMORIQ_ENV][kind];
}
