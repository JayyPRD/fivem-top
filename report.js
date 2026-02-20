import { Client } from "pg";

function rdNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
}

function minutesBetween(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / 60000);
}

// ✅ Live check desde CFX
async function getLivePlayers(serverCode) {
  try {
    const res = await fetch(`https://servers.fivem.net/api/servers/single/${serverCode}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return { ok: false };

    const data = await res.json();
    const players = data?.Data?.clients;

    if (typeof players === "number") {
      return { ok: true, players };
    }
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

  const data = await res.json();
  return data.id;
}

async function patchMessage(webhookBase, messageId, payload) {
  await fetch(`${webhookBase}/messages/${messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function getCompetitiveWindowRD() {
  const now = rdNow();
  const start = new Date(now);
  start.setHours(10, 0, 0, 0);

  if (now.getHours() < 10) {
    start.setDate(start.getDate() - 1);
  }

  return { start, end: now };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  if (!process.env.DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");

  const webhookBase = process.env.DISCORD_WEBHOOK_URL;
  const messageId = await ensureMessageId(webhookBase);

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

  const offlineMinutes = Number(process.env.OFFLINE_MINUTES || "15");
  const nowRD = rdNow();

  const top = rows.slice(0, 10);

  // ✅ Live checks (limit 4 concurrent)
  const liveResults = await mapLimit(top, 4, async (r) => {
    const live = await getLivePlayers(r.server_code);
    return { server_code: r.server_code, live };
  });

  const liveMap = new Map(liveResults.map(x => [x.server_code, x.live]));

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

            // Fallback “offline por sample viejo”
            const lastSeen = r.last_seen ? new Date(r.last_seen) : null;
            const minsAgo = lastSeen ? minutesBetween(nowRD, lastSeen) : 999999;
            const staleOffline = !lastSeen || minsAgo > offlineMinutes;

            // ✅ Live status real
            const live = liveMap.get(r.server_code) || { ok: false };
            let status;

            if (live.ok) {
              // Si CFX dice 0, lo tratamos como offline real
              status = live.players > 0 ? `🟢 En línea: **${live.players}**` : `🔴 **OFFLINE**`;
            } else {
              // si CFX falló, usamos tu regla por tiempo
              status = staleOffline ? `🔴 **OFFLINE**` : `🟢 En línea: **${r.online_now}**`;
            }

            return `${medal} **${r.server_name}**
${status}
👥 Max: **${r.max_players}** | Avg: **${r.avg_players}** | Muestras: ${r.samples}
🔗 ${link}`;
          })
          .join("\n\n")
      : "⏳ No hay datos todavía.";

  const payload = {
    content: "",
    embeds: [
      {
        title: "📊 TOP EN VIVO (FiveM)",
        description: `🕙 Reinicio diario: 10:00 AM RD\n\n${rankingTexto}`,
        color: 7306,
        footer: { text: "By: JayyP" },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await patchMessage(webhookBase, messageId, payload);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
