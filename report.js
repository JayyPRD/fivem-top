import { Client } from "pg";

function rdNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
}

function isResetHourRD() {
  const d = rdNow();
  return d.getHours() === 12 && d.getMinutes() === 0; // ✅ 12:00 PM RD
}

function minutesBetween(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / 60000);
}

// ✅ LIVE CHECK (CFX) — players reales ahora mismo
async function getLivePlayers(serverCode) {
  try {
    const res = await fetch(`https://servers.fivem.net/api/servers/single/${serverCode}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return { ok: false };

    const data = await res.json();
    const players = data?.Data?.clients;

    if (typeof players === "number") return { ok: true, players };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// ✅ Concurrencia limitada para no spamear requests
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
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
  return "🔄 **Reinicio diario (12:00 PM RD)**\n\n🟢 En línea: **0** | 👥 Max: **0** | Avg: **0.0** | Muestras: 0";
}

// ✅ Ventana competitiva: 12:00 PM RD → ahora
function getCompetitiveWindowRD() {
  const now = rdNow();
  const start = new Date(now);
  start.setHours(12, 0, 0, 0); // ✅ 12:00 PM RD

  if (now.getHours() < 12) {
    start.setDate(start.getDate() - 1); // antes de 12 → ayer 12 PM
  }

  return { start, end: now };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  if (!process.env.DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");

  const webhookBase = process.env.DISCORD_WEBHOOK_URL;
  const messageId = await ensureMessageId(webhookBase);

  // ✅ Reset visual automático a las 12:00 PM RD
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
    console.log("Reset automático aplicado (12:00 PM RD). message:", messageId);
    return;
  }

  // ✅ Rango nuevo (12:00 PM RD → ahora)
  const { start, end } = getCompetitiveWindowRD();

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await db.connect();

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

  // ✅ LIVE CHECK para los del TOP (sin eliminar offline)
  const liveResults = await mapLimit(top, 4, async (r) => {
    const live = await getLivePlayers(r.server_code);
    return { server_code: r.server_code, live };
  });
  const liveMap = new Map(liveResults.map((x) => [x.server_code, x.live]));

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

            // fallback offline por tiempo (solo si CFX falla)
            const staleOffline = !lastSeen || minsAgo > offlineMinutes;

            const live = liveMap.get(r.server_code) || { ok: false };

            // ✅ status final (NO se filtra, siempre aparece)
            let statusLine;
            if (live.ok) {
              statusLine = live.players > 0
                ? `🟢 En línea: **${live.players}**`
                : `🔴 **OFFLINE**`;
            } else {
              statusLine = staleOffline
                ? `🔴 **OFFLINE**`
                : `🟢 En línea: **${r.online_now}**`;
            }

            const maxLine = `👥 Max: **${r.max_players}** | Avg: **${r.avg_players}** | Muestras: ${r.samples}`;
            const seenLine = `⏱️ Último ping: hace **${minsAgo} min**`;

            return `${medal} **${r.server_name}**\n${statusLine}\n${maxLine}\n${seenLine}\n🔗 ${link}`;
          })
          .join("\n\n")
      : "⏳ No hay datos todavía (esperando samples del collector).";

  const payload = {
    content: "",
    embeds: [
      {
        title: "📊 TOP EN VIVO (FiveM)",
        description: `(Reinicio diario: **12:00 PM RD** | Actualiza cada 30 min | Métrica: Max players)\n\n${rankingTexto}`,
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
  console.log("Report updated. Window:", start.toISOString(), "→", end.toISOString(), "message:", messageId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
