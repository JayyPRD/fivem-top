import { Client } from "pg";

function rdNow() {
  // Hora RD real (sin depender del timezone del container)
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
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
        timestamp: new Date().toISOString(),
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

// ✅ Calcula el rango del “día competitivo” que reinicia a las 10:00 AM RD
function getCompetitiveWindowRD() {
  const now = rdNow();

  const start = new Date(now);
  start.setHours(10, 0, 0, 0); // 10:00 AM RD

  // Si todavía no son las 10 AM, el ciclo comenzó ayer a las 10 AM
  if (now.getHours() < 10) {
    start.setDate(start.getDate() - 1);
  }

  return { start, end: now };
}

function formatWindowLabelRD(start, end) {
  // Etiqueta simple para el embed
  const fmt = new Intl.DateTimeFormat("es-DO", {
    timeZone: "America/Santo_Domingo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${fmt.format(start)} → ${fmt.format(end)}`;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  if (!process.env.DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");

  const webhookBase = process.env.DISCORD_WEBHOOK_URL;
  const messageId = await ensureMessageId(webhookBase);

  // ✅ Ventana 10AM RD → ahora
  const { start, end } = getCompetitiveWindowRD();
  const windowLabel = formatWindowLabelRD(start, end);

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await db.connect();

  // ✅ Online (último sample del rango) + Max/Avg/Samples
  const { rows } = await db.query(
    `
    WITH win AS (
      SELECT *
      FROM samples
      WHERE ts >= $1 AND ts <= $2
    ),
    latest AS (
      SELECT DISTINCT ON (server_code)
        server_code,
        players AS online_now,
        ts AS last_seen
      FROM win
      ORDER BY server_code, ts DESC
    )
    SELECT
      w.server_code,
      w.server_name,
      MAX(w.players) AS max_players,
      ROUND(AVG(w.players)::numeric, 1) AS avg_players,
      COUNT(*) AS samples,
      l.online_now,
      l.last_seen
    FROM win w
    JOIN latest l USING (server_code)
    GROUP BY w.server_code, w.server_name, l.online_now, l.last_seen
    ORDER BY MAX(w.players) DESC;
    `,
    [start.toISOString(), end.toISOString()]
  );

  await db.end();

  const top = rows.slice(0, 10);

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
            const status = isOffline ? `🔴 **OFFLINE**` : `🟢 En línea: **${r.online_now}**`;

            return `${medal} **${r.server_name}**\n${status}\n👥 Max: **${r.max_players}** | Avg: **${r.avg_players}** | Muestras: ${r.samples}\n🔗 ${link}`;
          })
          .join("\n\n")
      : "⏳ No hay datos todavía (esperando samples del collector).";

  const payload = {
    content: "",
    embeds: [
      {
        title: "📊 TOP EN VIVO (FiveM)",
        description:
          `🕙 **Reinicio diario: 10:00 AM RD**\n` +
          `📅 Ventana: **${windowLabel}**\n` +
          `(Actualiza cada 30 min | Métrica: Max players)\n\n` +
          `${rankingTexto}`,
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
  console.log("Report updated. Window start:", start.toISOString(), "message:", messageId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
