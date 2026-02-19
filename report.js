import { Client } from "pg";

function dayKeyBogota(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  if (!process.env.DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");

  const dayKey = dayKeyBogota();
  const start = new Date(`${dayKey}T00:00:00-05:00`);
  const end = new Date(`${dayKey}T23:59:59-05:00`);

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await db.connect();

  const { rows } = await db.query(
    `
    SELECT
      server_code,
      server_name,
      MAX(players) AS max_players,
      ROUND(AVG(players)::numeric, 1) AS avg_players,
      COUNT(*) AS samples
    FROM samples
    WHERE ts >= $1 AND ts <= $2
    GROUP BY server_code, server_name
    ORDER BY MAX(players) DESC;
    `,
    [start.toISOString(), end.toISOString()]
  );

  await db.end();

  const top = rows.slice(0, 10);
  const lines = top.map((r, i) => {
    const link = `https://servers.fivem.net/servers/detail/${r.server_code}`;
    return `**${i + 1}. ${r.server_name}**\n👥 Max: **${r.max_players}** | Avg: **${r.avg_players}** | Muestras: ${r.samples}\n🔗 ${link}`;
  });

  const content =
`📊 **TOP DIARIO (FiveM)** — **${dayKey}**
(Métrica: **Max players** del día)

${lines.join("\n\n") || "No hay datos todavía para hoy."}`;

  const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
  console.log("Report sent:", dayKey);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
