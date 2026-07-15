import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

for (let index = 0; index < env.TEST_SEED_QUERIES.length; index += 50) {
  const statements = env.TEST_SEED_QUERIES
    .slice(index, index + 50)
    .map((query) => env.DB.prepare(query));
  await env.DB.batch(statements);
}
