import { Client } from "pg";

async function getLivePlayers(serverCode) {
  try {
    const res = await fetch(`https://servers.fivem.net/api/servers/single/${serverCode}`);
    if (!res.ok) return { online: false };

    const data = await res.json();
    const players = data?.Data?.clients;

    if (typeof players === "number") {
      return {
        online: players > 0,
        players
      };
    }

    return { online: false };
  } catch {
    return { online: false };
  }
}

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await db.connect();

  const { rows } = await db.query(`
    SELECT
      server_code,
      server_name,
      MAX(players) AS max_players,
      ROUND(AVG(players)::numeric, 1) AS avg_players,
      COUNT(*) AS samples
    FROM samples
    GROUP BY server_code, server_name
    ORDER BY MAX(players) DESC;
  `);

  await db.end();

  const ranking = [];

  for (let i = 0; i < rows.slice(0,10).length; i++) {
    const r = rows[i];

    const medal =
      i === 0 ? "🥇" :
      i === 1 ? "🥈" :
      i === 2 ? "🥉" :
      `**${i + 1}.**`;

    const live = await getLivePlayers(r.server_code);

    const status = live.online
      ? `🟢 En línea: **${live.players}**`
      : `🔴 **OFFLINE**`;

    ranking.push(`${medal} **${r.server_name}**
${status}
👥 Max: **${r.max_players}** | Avg: **${r.avg_players}** | Muestras: ${r.samples}
🔗 https://servers.fivem.net/servers/detail/${r.server_code}`);
  }

  const payload = {
    content: "",
    embeds: [
      {
        title: "📊 TOP EN VIVO (FiveM)",
        description: ranking.join("\n\n"),
        color: 7306,
        footer: { text: "By: JayyP" },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await fetch(`${process.env.DISCORD_WEBHOOK_URL}/messages/${process.env.DISCORD_MESSAGE_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

main();
