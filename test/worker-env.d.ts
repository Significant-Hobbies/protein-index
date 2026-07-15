declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
      TEST_SEED_QUERIES: string[];
      TEST_ROBOTOFF_REPLAY_QUERIES: string[];
      TEST_ROBOTOFF_DRIFT_QUERIES: string[];
    }

    interface GlobalProps {
      mainModule: typeof import("../worker/index");
    }
  }
}

export {};
