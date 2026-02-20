import { Client } from "pg";

function dayKeyBogota(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

async function ensureMessageId(webhookBaseUrl) {
  // Si ya lo tienes, úsalo
  if (process.env.DISCORD_MESSAGE_ID) return process.env.DISCORD_MESSAGE_ID;

  // Si no existe, crea el primer mensaje embed y devuelve su ID
  const initPayload = {
    content: "",
    embeds: [
      {
        title: "📊 **TOP EN VIVO (FiveM)**",
        description: "⏳ Inicializando… en breve aparecerá el top.",
        color: 7306,
        footer: { text: "By: JayyP" },
        image: {
          url: "https://media.discordapp.net/attachments/1442556589952208947/1474185621474902036/standard_1.gif?ex=6998edd9&is=69979c59&hm=b8dbbd2ff4e9e1690e944fdb91df86c9a95b7e90e9a034f0d5a5c98faf49f023&=",
        },
      },
    ],
    attachments: [],
    allowed_mentions: { parse: [] },
  };

  const res = await fetch(`${webhookBaseUrl}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(initPayload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook POST(init) ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!data?.id) throw new Error("No message id returned from webhook.");

  console.log("Created initial message. Set DISCORD_MESSAGE_ID to:", data.id);
  return data.id;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  if (!process.env.DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");

  const webhookBase = process.env.DISCORD_WEBHOOK_URL;
  const messageId = await ensureMessageId(webhookBase);

  const dayKey = dayKeyBogota();
  const start = new Date(`${dayKey}T00:00:00-05:00`);
  const end = new Date(`${dayKey}T23:59:59-05:00`);

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
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
      ? top
          .map((r, i) => {
            const link = `https://servers.fivem.net/servers/detail/${r.server_code}`;
            return `**${i + 1}. ${r.server_name}**\n👥 Max: **${r.max_players}** | Avg: **${r.avg_players}** | Muestras: ${r.samples}\n🔗 ${link}`;
          })
          .join("\n\n")
      : "⏳ No hay datos todavía (esperando samples del collector).";

  const payload = {
    content: "", // ✅ corregido (no null)
    embeds: [
      {
        title: "📊 **TOP EN VIVO (FiveM)**",
        description: `(Actualiza cada 30 min | Métrica: Max players)\n\n${rankingTexto}`,
        color: 7306,
        footer: { text: "By: JayyP" },
        image: {
          url: "https://media.discordapp.net/attachments/1442556589952208947/1474185621474902036/standard_1.gif?ex=6998edd9&is=69979c59&hm=b8dbbd2ff4e9e1690e944fdb91df86c9a95b7e90e9a034f0d5a5c98faf49f023&=",
        },
        timestamp: new Date().toISOString(),
      },
    ],
    attachments: [],
    allowed_mentions: { parse: [] },
  };

  const editUrl = `${webhookBase}/messages/${messageId}`;

  const res = await fetch(editUrl, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook PATCH ${res.status}: ${text}`);
  }

  console.log("Report updated:", dayKey, "message:", messageId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
