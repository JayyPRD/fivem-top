import fs from "fs";
import { Client } from "pg";

const servers = JSON.parse(fs.readFileSync("./servers.json", "utf8"));

async function fetchPlayers(code) {
  const url = `https://servers-frontend.fivem.net/api/servers/single/${code}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (fivem-top-collector)" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const players = data?.Data?.clients;
  return typeof players === "number" ? players : null;
}

const sqlInit = `
CREATE TABLE IF NOT EXISTS samples (
  id BIGSERIAL PRIMARY KEY,
  server_code TEXT NOT NULL,
  server_name TEXT NOT NULL,
  players INT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples (ts);
CREATE INDEX IF NOT EXISTS idx_samples_server_ts ON samples (server_code, ts);
`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
  }

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await db.connect();
  await db.query(sqlInit);

  for (const s of servers) {
    try {
      const players = await fetchPlayers(s.code);
      if (players === null) continue;

      await db.query(
        "INSERT INTO samples (server_code, server_name, players) VALUES ($1,$2,$3)",
        [s.code, s.name, players]
      );

      console.log(`OK ${s.name} (${s.code}) -> ${players}`);
    } catch (e) {
      console.log(`FAIL ${s.name} (${s.code}) -> ${e.message}`);
    }
  }

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
