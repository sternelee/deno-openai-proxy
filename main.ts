import { serve } from "https://deno.land/std@0.181.0/http/server.ts";
import type {
  ParsedEvent,
  ReconnectInterval,
} from "https://esm.sh/eventsource-parser@1.0.0";
import { createParser } from "https://esm.sh/eventsource-parser@1.0.0";

const OPENAI_API_HOST = "api.openai.com";
// const OPENAI_API_HOST = "lee-chat.deno.dev";
const APIKEY = Deno.env.get("OPEN_AI_KEY");
const APPID = Deno.env.get("APPID") || "";
const SECRET = Deno.env.get("SECRET") || "";
const MAX_DAY_COUNT = 3;
const MY_KEY = "l5e2e0";

const clients = new Map();
const users: {
  [openid: string]: {
    day: string;
    count: number;
  };
} = {};

const getDayCount = (openid: string) => {
  const now = new Date().toLocaleDateString();
  if (users[openid] && users[openid].day === now) {
    if (users[openid].count >= MAX_DAY_COUNT) return 0;
    users[openid].count += 1;
    return users[openid].count;
  } else {
    users[openid] = {
      day: now,
      count: 1,
    };
    return 1;
  }
};

const decoder = new TextDecoder();

serve(async (request: Request) => {
  const url = new URL(request.url);
  const upgrade = request.headers.get("upgrade") || "";
  console.log("URL:", url.pathname);
  if (upgrade.toLowerCase() != "websocket") {
    if (url.pathname === "/") {
      return fetch(new URL("./Readme.md", import.meta.url));
    }

    if (url.pathname === "/jscode2session") {
      const ret = await fetch(
        `https://api.weixin.qq.com/sns/jscode2session?js_code=${
          url.searchParams.get(
            "js_code",
          )
        }&appid=${APPID}&secret=${SECRET}&grant_type=authorization_code`,
      ).then((response) => response.json());
      if (ret.openid) {
        return new Response(JSON.stringify(
          {
            openid: ret.openid,
          },
        ));
      }
      return new Response(JSON.stringify(ret));
    }

    url.host = OPENAI_API_HOST;
    return await fetch(url, request);
  }

  const { socket, response } = Deno.upgradeWebSocket(request);
  const openid = url.pathname.split("/ws/")[1];
  socket.onopen = () => {
    console.log("socket opened")
    if (openid && !clients.get(openid)) {
      clients.set(openid, socket);
    }
  };
  socket.onmessage = async (e) => {
    try {
      const { type, action, key, ...options } = JSON.parse(e.data);
      console.log("socket message:", e.data);
      // 采用 socket 方式返回分流信息
      const client = clients.get(openid) || socket;
      if (!client) return;
      if (type === "chat") {
        const auth = key.includes(MY_KEY) && getDayCount(openid) > 0
          ? APIKEY
          : key;
        const url = `https://${OPENAI_API_HOST}${action}`;
        const rawRes = await fetch(url, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth}`,
          },
          method: "POST",
          body: JSON.stringify({
            // max_tokens: 4096 - tokens,
            stream: true,
            ...options,
          }),
        }).catch((err) => {
          return client.send(
            JSON.stringify({
              type: "fail",
              status: 500,
              message: err.message,
            }),
          );
        });

        // console.log('rawRes:', rawRes)
        if (!rawRes.ok) {
          return client.send(
            JSON.stringify({
              type: "fail",
              status: rawRes.status,
              message: rawRes.statusText,
            }),
          );
        }
        const streamParser = (event: ParsedEvent | ReconnectInterval) => {
          if (event.type === "event") {
            const data = event.data;
            if (data === "[DONE]") {
              return client.send(JSON.stringify({ type: "done", status: 200 }));
            }
            try {
              const json = JSON.parse(data);
              const text = json.choices[0].delta?.content;
              client.send(
                JSON.stringify({ type: "ok", status: 200, content: text }),
              );
            } catch (e) {
              client.send(
                JSON.stringify({
                  type: "fail",
                  status: 200,
                  content: e.message.toString(),
                }),
              );
            }
          }
        };
        const parser = createParser(streamParser);
        for await (const chunk of rawRes.body as any) {
          parser.feed(decoder.decode(chunk));
        }
      } else {
        socket.send(new Date().toString());
      }
    } catch (e) {
      socket.send(e.message);
    }
  };
  socket.onerror = (e) => {
    console.log("socket errored:", e);
    if (openid && clients.get(openid)) {
      clients.delete(openid);
    }
  };
  socket.onclose = () => {
    if (openid && clients.get(openid)) {
      clients.delete(openid);
    }
  };
  return response;
});
