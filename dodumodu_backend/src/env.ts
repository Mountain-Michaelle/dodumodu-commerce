// Shape of everything bound to a running instance of the app — vars, secrets,
// and bindings. Import this type wherever a route/service/repo needs `env`;
// never redeclare it.
//
// The same shape serves both runtimes. On the Worker the values come from
// wrangler ([vars], secrets, R2/KV bindings); in local Node they are assembled
// from the root .env plus the local shims in src/node/shims.ts. That is the
// whole difference between the two environments: this type does not change.
export type Env = {
  // vars (wrangler.toml [vars] / .env)
  R2_BUCKET_NAME: string;
  ENVIRONMENT: "sandbox" | "production";
  RATE_LIMIT_API_PER_MINUTE: string;
  /** Visitor writes are HMAC-keyed with this dedicated secret; never reuse another key. */
  ANALYTICS_IP_HMAC_SECRET: string;
  ANALYTICS_IP_HMAC_VERSION: string;
  /** Only the anonymous intent event is gated by this optimization switch. */
  ANALYTICS_WARMUP_ENABLED: string;
  /**
   * Order Assignment Mode (fulfilment routing). "false" (the default) keeps the
   * feature dark: the assign/unassign actions and the staff endpoint refuse,
   * and the panel hides the toggle. Flip to "true" to enable without a deploy
   * where the runtime allows it. Strictly additive and independently revertible.
   */
  ASSIGNMENT_MODE_ENABLED: string;
  RATE_LIMIT_ORDER_PER_PHONE_PER_HOUR: string;
  /**
   * Admin console read ceiling, per operator per minute. Separate from
   * RATE_LIMIT_API_PER_MINUTE on purpose - the console has its own budget and its
   * own keyspace, so operator browsing never competes with customer traffic.
   */
  RATE_LIMIT_ADMIN_PER_MINUTE: string;
  /**
   * Admin console WRITE ceiling, per operator per minute. Deliberately tighter
   * than the read ceiling: this covers order transitions, payment overrides, bulk
   * actions, uploads and publishes.
   */
  RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: string;

  /* ---- abuse protection ---- */
  //
  // RL_AUTO_BLOCK is the only switch that can refuse an order automatically:
  // "off" | "shadow" | "on", defaulting to shadow. RL_MODE governs the long-window
  // volume rule, which never refuses anyone.
  RL_MODE: string;
  RL_AUTO_BLOCK: string;
  RL_V2_ENABLED: string;
  RL_VELOCITY_WINDOW_SECONDS: string;
  RL_VELOCITY_BLOCK_SECONDS: string;
  RL_V1_MIN_ORDERS: string;
  RL_V1_MIN_PHONES: string;
  RL_V2_MIN_ORDERS: string;
  RL_V2_MIN_PHONES: string;
  RL_V2_DEVICE_RATIO: string;
  RL_WINDOW_SECONDS: string;
  RL_BLOCK_SECONDS: string;
  RL_ABUSE_IP_POSTS: string;
  RL_ABUSE_DISTINCT_PHONES: string;
  RL_ABUSE_FAILURES: string;
  RL_ABUSE_SUCCESS_FLOOR: string;
  RL_IP_ALLOWLIST: string;
  RL_PHONE_MAX_OPEN: string;
  /** Optional; validated against wa.me / api.whatsapp.com before it is ever rendered. */
  SUPPORT_WHATSAPP_URL: string;
  /** Optional Slack webhook URL for §5.11 alerts. */
  REFERRED_SLACK_WEBHOOK_URL: string;

  /* ---- image pipeline (see src/config/imageConfig.ts for what each does) ---- */

  /** "transform" (Cloudflare /cdn-cgi/image) or "derivative" (admin-rendered). */
  IMAGE_MODE: string;
  MAX_UPLOAD_BYTES: string;
  /** Cloudflare cannot transform past 12,000px per side. */
  MAX_IMAGE_DIMENSION: string;
  IMAGE_KEY_PREFIX: string;
  IMAGE_WIDTHS_HERO: string;
  IMAGE_WIDTHS_GALLERY: string;
  IMAGE_WIDTHS_TESTIMONIAL: string;
  IMAGE_WIDTHS_THUMBNAIL: string;
  IMAGE_QUALITY_HERO: string;
  IMAGE_QUALITY_GALLERY: string;
  IMAGE_QUALITY_TESTIMONIAL: string;
  IMAGE_QUALITY_THUMBNAIL: string;
  /** s-maxage for public catalog JSON; the edge serves it without asking again. */
  CATALOG_EDGE_TTL: string;
  CATALOG_EDGE_SWR: string;
  /**
   * R2 custom domain that fronts the bucket, e.g. https://media.example.com.
   * Required in BOTH delivery modes and NOT used as a Worker route: no Worker sits
   * in the image path.
   */
  IMAGE_DELIVERY_BASE: string;
  /** Cloudflare Pages deploy hook fired by the admin's Publish action. */
  PAGES_DEPLOY_HOOK: string;
  /**
   * The PUBLIC storefront origin, e.g. https://yoursite.com.
   *
   * This is what the deployment verifier FETCHES to find out which publish is
   * actually live. It must be the public origin, not the API origin: the whole
   * point is to check the page a customer receives, and checking the API instead
   * would confirm nothing about what is being served.
   */
  SITE_URL: string;
  MAX_ORDER_QUANTITY: string;
  /** Comma-separated CORS allowlist. See isOriginAllowed in app.ts. */
  ALLOWED_ORIGINS: string;
  /** Public origin of the deployed Worker, e.g. https://<your-worker>.workers.dev. */ WORKER_URL: string;
  /** OPay API root, e.g. the sandbox or production host. */
  OPAY_BASE_URL: string;
  /**
   * Optional comma-separated operator allowlist. Empty means "anyone Cloudflare
   * Access vouched for", which is correct while Access admits only the owner.
   * See resolvePrincipal in src/auth/adminAuth.ts - this is configuration read in
   * exactly one place, which is why no email address appears in a route file.
   */
  ADMIN_OPERATORS: string;

  // admin-auth v2 (feature flag "0"/"1"; additive only, existing routes untouched)
  ADMIN_AUTH_V2: string;

  /**
   * The opaque admin URL namespace, e.g. "/e5he78f823523". Exactly one path
   * segment beginning with "/". Local development defaults to "/admin" when
   * unset; production must set it explicitly and never falls back.
   * Validated by resolveAdminBasePath in src/config/adminBase.ts.
   */
  ADMIN_BASE_PATH: string;
  /** Test-only: allows X-Test-IP to override the client IP. Exists only in .dev.vars. */
  ALLOW_TEST_IP: string;

  // secrets (wrangler secret put / .env)
  DATABASE_URL: string;
  OPAY_PUBLIC_KEY: string;
  OPAY_SECRET_KEY: string;
  OPAY_MERCHANT_ID: string;
  OPAY_WEBHOOK_SECRET: string;
  TURNSTILE_SECRET_KEY: string;
  RECONCILE_CRON_SECRET: string;

  // admin-auth v2 secrets (Worker secrets only; see src/auth/config.ts)
  OTP_KEY: string;
  THROTTLE_KEY: string;
  TOTP_ENC_KEY: string;
  RESEND_API_KEY: string;
  TURNSTILE_SECRET: string;
  /** From address for login codes. Must be a Resend-verified sender/domain. */
  AUTH_FROM_EMAIL: string;

  // Build-deploy secrets — set via wrangler secret put; never committed.
  /** CI authenticates build-status mutations (mark-deployed/verified/failed) with this secret. */
  DEPLOY_TRIGGER_SECRET: string;
  /** The Worker authenticates GitHub repository_dispatch calls with this secret. */
  GITHUB_DEPLOY_TOKEN: string;

  // bindings — real R2/KV on the Worker, local shims under Node
  MEDIA_BUCKET: R2Bucket;
  RATE_LIMIT_KV: KVNamespace;
};
