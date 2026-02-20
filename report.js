import { Client } from "pg";

function dayKeyBogota(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function rdNow() {
  // Fecha “local” RD (sin depender del timezone del container)
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
}

function isResetHourRD() {
  const d = rdNow();
  return d.getHours() === 9 && d.getMinutes() === 0;
}

function minutesBetween(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / 60000);
}

async function ensureMessageId(webhookBaseUrl) {
  if (process.env.DISCORD_MESSAGE_ID) return process.env.DISCORD_MESSAGE_ID;

  const initPayload = {
    content: "",
    embeds: [
      {
        title: "📊 TOP EN VIVO (FiveM)",
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

async function patchMessage(webhookBase, messageId, payload) {
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
}

function buildResetRanking() {
  return "🌙 **Nuevo día iniciado**\n\n🟢 En línea: **0** | 👥 Max: **0** | Avg: **0.0** | Muestras: 0";
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  if (!process.env.DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");

  const webhookBase = process.env.DISCORD_WEBHOOK_URL;
  const messageId = await ensureMessageId(webhookBase);

  // ✅ Reset automático a las 12:00 AM RD
  if (isResetHourRD()) {
    const payloadReset = {
      content: "",
      embeds: [
        {
          title: "📊 TOP EN VIVO (FiveM)",
          description: `(Actualiza cada 30 min | Métrica: Max players)\n\n${buildResetRanking()}`,
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

    await patchMessage(webhookBase, messageId, payloadReset);
    console.log("Reset automático aplicado (10:00 RD). message:", messageId);
    return;
  }

  const dayKey = dayKeyBogota();
  const start = new Date(`${dayKey}T00:00:00-05:00`);
  const end = new Date(`${dayKey}T23:59:59-05:00`);

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await db.connect();

  // Trae: Max/Avg/Samples + “online_now” (último sample del día) + last_seen
  const { rows } = await db.query(
    `
    WITH day AS (
      SELECT *
      FROM samples
      WHERE ts >= $1 AND ts <= $2
    ),
    latest AS (
      SELECT DISTINCT ON (server_code)
        server_code,
        players AS online_now,
        ts AS last_seen
      FROM day
      ORDER BY server_code, ts DESC
    )
    SELECT
      d.server_code,
      d.server_name,
      MAX(d.players) AS max_players,
      ROUND(AVG(d.players)::numeric, 1) AS avg_players,
      COUNT(*) AS samples,
      l.online_now,
      l.last_seen
    FROM day d
    JOIN latest l USING (server_code)
    GROUP BY d.server_code, d.server_name, l.online_now, l.last_seen
    ORDER BY MAX(d.players) DESC;
    `,
    [start.toISOString(), end.toISOString()]
  );

  await db.end();

  const top = rows.slice(0, 10);

  // ✅ OFFLINE si el último sample está viejo
  const offlineMinutes = Number(process.env.OFFLINE_MINUTES || "45");
  const nowRD = rdNow();

  const rankingTexto =
    top.length > 0
      ? top
          .map((r, i) => {
            const medal =
              i === 0 ? "🥇" :
              i === 1 ? "🥈" :
              i === 2 ? "🥉" :
              `**${i + 1}.**`;

            const link = `https://servers.fivem.net/servers/detail/${r.server_code}`;

            const lastSeen = r.last_seen ? new Date(r.last_seen) : null;
            const minsAgo = lastSeen ? minutesBetween(nowRD, lastSeen) : 999999;

            const isOffline = !lastSeen || minsAgo > offlineMinutes;

            const statusLine = isOffline
              ? `🔴 **OFFLINE**`
              : `🟢 En línea: **${r.online_now}**`;

            const maxLine = `👥 Max: **${r.max_players}** | Avg: **${r.avg_players}** | Muestras: ${r.samples}`;
            const seenLine = isOffline ? `⏱️ Último ping: hace **${minsAgo} min**` : `⏱️ Último ping: hace **${minsAgo} min**`;

            return `${medal} **${r.server_name}**\n${statusLine}\n${maxLine}\n${seenLine}\n🔗 ${link}`;
          })
          .join("\n\n")
      : "⏳ No hay datos todavía (esperando samples del collector).";

  const payload = {
    content: "",
    embeds: [
      {
        title: "📊 TOP EN VIVO (FiveM)",
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

  await patchMessage(webhookBase, messageId, payload);
  console.log("Report updated:", dayKey, "message:", messageId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
