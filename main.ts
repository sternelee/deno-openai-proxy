import { serve } from "https://deno.land/std@0.181.0/http/server.ts";
import type { ParsedEvent, ReconnectInterval } from "https://esm.sh/eventsource-parser@1.0.0";
import { createParser } from "https://esm.sh/eventsource-parser@1.0.0";
import Replicate from "https://esm.sh/replicate@0.10.0";
import * as tencentcloud from "https://esm.sh/tencentcloud-sdk-nodejs@4.0.578";
import { parsePrompts } from "./prompt.ts";

const OPENAI_API_HOST = "api.openai.com";
// const OPENAI_API_HOST = "lee-chat.deno.dev";
const APIKEY = Deno.env.get("OPEN_AI_KEY");
const APPID = Deno.env.get("APPID") || "";
const SECRET = Deno.env.get("SECRET") || "";
const REPLICATE_API_TOKEN = Deno.env.get("REPLICATE_API_TOKEN") || "";
const MAX_DAY_COUNT = 3;
const MY_KEY = Deno.env.get("MY_KEY") || "l5e2e0";

// 文本转语音
// https://learn.microsoft.com/en-us/azure/developer/javascript/tutorial/convert-text-to-speech-cognitive-services

const TmsClient = tencentcloud.tms.v20201229.Client;

const TENCENT_CLOUD_SID = Deno.env.get("TENCENT_CLOUD_SID");
const TENCENT_CLOUD_SKEY = Deno.env.get("TENCENT_CLOUD_SKEY");
const TENCENT_CLOUD_AP = Deno.env.get("TENCENT_CLOUD_AP") || "ap-singapore";

const prompts = parsePrompts();

const Config = {
  MAX_DAY_COUNT,
  MAX_DAY_AD_COUNT: 10,
  prompts,
};

const clientConfig = {
  credential: {
    secretId: TENCENT_CLOUD_SID,
    secretKey: TENCENT_CLOUD_SKEY,
  },
  region: TENCENT_CLOUD_AP,
  profile: {
    httpProfile: {
      endpoint: "tms.tencentcloudapi.com",
    },
  },
};
const mdClient = TENCENT_CLOUD_SID && TENCENT_CLOUD_SKEY
  ? new TmsClient(clientConfig)
  : false;

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({
    auth: REPLICATE_API_TOKEN,
  })
  : null;

const users: {
  [openid: string]: {
    day: string;
    count: number;
  };
} = {};

const sentences: {
  [openid: string]: {
    status: number;
    char: string;
    chars: string[];
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
      // return fetch(new URL("./Readme.md", import.meta.url));
      return new Response("Hello World");
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

    if (url.pathname === "/config") {
      return new Response(JSON.stringify(Config));
    }

    if (url.pathname === "/replicate") {
      if (replicate) {
        const { model, input } = request.body as any;
        const output = await replicate.run(model, { input });
        return new Response(output);
      } else {
        return new Response(JSON.stringify({ code: -1, message: "not found" }));
      }
    }

    url.host = OPENAI_API_HOST;
    return await fetch(url, request);
  }

  const { socket, response } = Deno.upgradeWebSocket(request);
  const openid = url.pathname.split("/ws/")[1];
  socket.onopen = () => {
    console.log("socket opened");
  };
  socket.onmessage = async (e) => {
    try {
      const { type, action, key, moderation_level = "", ...options } = JSON
        .parse(e.data);
      // console.log("socket message:", e.data);
      // 采用 socket 方式返回分流信息
      if (type === "chat") {
        const auth = key.includes(MY_KEY) && getDayCount(openid) > 0
          ? APIKEY
          : key;
        const url = `https://${OPENAI_API_HOST}${action}`;
        const controller = new AbortController();
        const rawRes = await fetch(url, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth}`,
          },
          signal: controller.signal,
          method: "POST",
          body: JSON.stringify({
            // max_tokens: 4096 - tokens,
            stream: true,
            ...options,
          }),
        }).catch((err) => {
          return socket.send(
            JSON.stringify({
              type: "fail",
              status: 500,
              message: err.message,
            }),
          );
        });

        if (!rawRes) {
          return socket.send(
            JSON.stringify({
              type: "fail",
              status: 500,
              message: "no response",
            }),
          );
        }
        // console.log('rawRes:', rawRes)
        if (!rawRes.ok) {
          return socket.send(
            JSON.stringify({
              type: "fail",
              status: rawRes.status,
              message: rawRes.statusText,
            }),
          );
        }
        const streamParser = async (event: ParsedEvent | ReconnectInterval) => {
          if (event.type === "event") {
            const data = event.data;
            // console.log('data:', data)
            if (data === "[DONE]") {
              return socket.send(JSON.stringify({ type: "done", status: 200 }));
            }
            try {
              const json = JSON.parse(data);
              const char = json.choices[0].delta?.content;
              if (mdClient) {
                if (!sentences[openid]) {
                  sentences[openid] = { status: 0, char: "", chars: [] };
                }
                sentences[openid].char += char;
                if (
                  char == "。" || char == "？" || char == "！" || char == "\n"
                ) {
                  // 将断句 sentence 送审
                  sentences[openid].chars.push(sentences[openid].char);
                  sentences[openid].char = "";
                }
                if (
                  sentences[openid].chars.length > 0
                  && sentences[openid].status === 0
                ) {
                  const sentence = sentences[openid].chars.pop() || "";
                  sentences[openid].status = 1;
                  const md_result = await mdClient.TextModeration({
                    Content: sentence,
                  });
                  sentences[openid].status = 0;
                  const md_check = moderation_level == "high"
                    ? md_result.Suggestion != "Pass"
                    : md_result.Suggestion == "Block";
                  if (md_check) {
                    sentences[openid] = { status: 0, char: "", chars: [] };
                    controller.abort();
                    socket.send(
                      JSON.stringify({
                        type: "ok",
                        status: 200,
                        content: "这个话题不适合讨论，换个提问吧",
                      }),
                    );
                    return;
                  }
                }
              }
              socket.send(
                JSON.stringify({ type: "ok", status: 200, content: char }),
              );
            } catch (e) {
              socket.send(
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
  };
  socket.onclose = () => {
  };
  return response;
});
