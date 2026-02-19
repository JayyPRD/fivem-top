import { Client } from "pg";

const WEBHOOK_EDIT_URL =
  "https://discord.com/api/webhooks/1474043533244760243/reuyQcFm2gsXaofyaCcBFUsjS3uXNt8SUS0jiO3kPAO0lpNdIYhKSBSa0PU7siECEogw/messages/1474177130421030913";

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

  const rankingTexto =
  top.length > 0
    ? top.map((r, i) => {
        const link = `https://servers.fivem.net/servers/detail/${r.server_code}`;
        return `**${i + 1}. ${r.server_name}**\n👥 Max: **${r.max_players}** | Avg: **${r.avg_players}**\n🔗 ${link}`;
      }).join("\n\n")
    : "⏳ Esperando datos del collector...";

  const payload = {
    content: "",
    embeds: [
      {
        title: "SERVIDORES DOMINICANOS TOP EN VIVO-",
        description: rankingTexto,
        color: 7306,
        footer: {
          text: "By: JayyP"
        },
        image: {
          url: "https://media.discordapp.net/attachments/1442556589952208947/1474185621474902036/standard_1.gif?ex=6998edd9&is=69979c59&hm=b8dbbd2ff4e9e1690e944fdb91df86c9a95b7e90e9a034f0d5a5c98faf49f023&="
        },
        timestamp: new Date().toISOString()
      }
    ],
    attachments: []
  };

  const res = await fetch(WEBHOOK_EDIT_URL, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook PATCH ${res.status}: ${text}`);
  }

  console.log("Embed updated:", dayKey);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
