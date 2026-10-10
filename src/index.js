import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// ─── 常量与配置 ──────────────────────────────────────────────

const MAX_CONTENT = 500; // 消息摘要最大长度
const WEBHOOK_URL = (key) =>
  `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`;

const NOTIFY_AGENT = "wecom-notify"; // 入口1：指定 agent 才通知
const DEFAULT_NOTIFY_KEYWORDS = ["微信", "wecom", "wecom-notify"];

// ─── 密钥读取：环境变量 → OpenCode 全局配置 → 工作目录 → 插件目录 ──

function parseDotEnv(text = "") {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function loadEnvFile(file) {
  try {
    return parseDotEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function loadSetting(name, allowEmpty = true) {
  if (Object.hasOwn(process.env, name) && (allowEmpty || process.env[name])) {
    return process.env[name];
  }

  const candidates = [
    path.join(os.homedir(), ".config", "opencode", ".env"),
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), ".env"),
  ];
  for (const file of candidates) {
    const values = loadEnvFile(file);
    if (Object.hasOwn(values, name) && (allowEmpty || values[name])) return values[name];
  }
  return undefined;
}

function loadWecomKey() {
  return loadSetting("WECOM_BOT_KEY", false) || "";
}

function keywordActivationEnabled() {
  return loadSetting("WECOM_NOTIFY_KEYWORDS_ENABLED")?.toLowerCase() === "true";
}

function loadNotifyKeywords() {
  const configured = loadSetting("WECOM_NOTIFY_KEYWORDS");
  if (configured === undefined) return DEFAULT_NOTIFY_KEYWORDS;
  return configured.split(",").map((keyword) => keyword.trim()).filter(Boolean);
}

// ─── 企业微信群机器人 ────────────────────────────────────────

async function sendWecom(content) {
  const key = loadWecomKey();
  if (!key) return;
  try {
    const res = await fetch(WEBHOOK_URL(key), {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ msgtype: "text", text: { content } }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.errcode !== 0) {
      console.error(`[wecom-notify] 企业微信发送失败: errcode=${data.errcode} errmsg=${data.errmsg}`);
    }
  } catch (err) {
    console.error("[wecom-notify] 企业微信发送异常:", err.message);
  }
}

// ─── 工具函数 ────────────────────────────────────────────────

function truncate(text, max = MAX_CONTENT) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function extractText(parts = []) {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
}

function errText(error) {
  if (!error) return "未知错误";
  if (error.data?.message) return error.data.message;
  if (error.message) return error.message;
  return error.name || JSON.stringify(error);
}

async function getSessionTitle(client, sessionID) {
  try {
    const res = await client.session.get({ path: { id: sessionID } });
    return res?.data?.title || res?.title || "";
  } catch {
    return "";
  }
}

async function getLastAssistantMessage(client, sessionID) {
  try {
    const res = await client.session.messages({ path: { id: sessionID } });
    const messages = res.data || res || [];
    return [...messages].reverse().find((m) => m.info?.role === "assistant");
  } catch {
    return null;
  }
}

// ─── 命令定义与配置同步（入口2：/wecom-notify）────────────────

function getCommands() {
  return {
    "wecom-notify": {
      description: "(wecom-notify) 开启本会话的微信通知：回复完成/出错/权限确认时推送企业微信",
      template: `<command-instruction>
You are now in WECOM NOTIFY mode. This session will send WeChat Work notifications when the assistant finishes replying, encounters an error, or asks for permission.
Proceed with the task normally.
</command-instruction>

<user-task>
$ARGUMENTS
</user-task>`,
      argumentHint: '"task description"',
    },
    "wecom-off": {
      description: "(wecom-notify) 关闭本会话的企业微信通知",
      template: `<command-instruction>
Disable WeChat Work notifications for this session. Do not change or continue any task.
</command-instruction>`,
    },
  };
}

function getNotifyAgent() {
  return {
    mode: "primary",
    description: "Agent that sends WeChat Work notifications when replies complete, errors occur, or permission is requested.",
    prompt: `You are wecom-notify, an agent that notifies the user via WeChat Work when work finishes or needs attention.

RULES:
- Work on the task normally
- The notification plugin handles delivery automatically
- Do NOT ask whether notifications were received`,
    color: "#07C160",
    steps: 500,
  };
}

function syncCommandsToFile(configDir) {
  const commands = getCommands();
  const configFilePath = path.join(configDir, "opencode.json");
  try {
    let parsed = {};
    try {
      parsed = JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
    } catch {}

    const existing = parsed.command || {};

    // 移除过期的 wecom-notify 命令
    for (const key of Object.keys(existing)) {
      if (existing[key]?.__cc_source === "wecom-notify") {
        delete existing[key];
      }
    }

    // 注入最新命令
    for (const [name, def] of Object.entries(commands)) {
      existing[name] = { ...def, __cc_source: "wecom-notify" };
    }

    parsed.command = existing;
    fs.writeFileSync(configFilePath, JSON.stringify(parsed, null, 2), "utf-8");
    console.log(`[wecom-notify] Synced ${Object.keys(commands).length} command(s) to opencode.json`);
  } catch (e) {
    console.error(`[wecom-notify] Failed to sync commands:`, e.message);
  }
}

// ─── 插件 ────────────────────────────────────────────────────

export default async function wecomNotifyPlugin({ client }) {
  // 已启用通知的会话 ID（仅入口命中后加入，会话内持续生效）
  const enabled = new Set();
  // 用户显式关闭的会话，只有 /wecom-notify 可以重新启用
  const muted = new Set();
  // 去重：sessionID -> 已通知的最后一条 assistant 消息 id
  const notified = new Map();

  // 同步命令到 opencode.json，供桌面端 UI 自动补全
  const configDir = path.join(os.homedir(), ".config", "opencode");
  try {
    syncCommandsToFile(configDir);
  } catch {}

  return {
    name: "opencode-wecom-notify",

    // 注入 agent（入口1）与 /wecom-notify 命令（入口2）
    config: async (inputConfig) => {
      const existingAgent = inputConfig.agent?.[NOTIFY_AGENT] || {};
      inputConfig.agent = {
        ...(inputConfig.agent || {}),
        [NOTIFY_AGENT]: {
          ...getNotifyAgent(),
          ...existingAgent,
          mode: "primary",
          hidden: false,
        },
      };

      const existing = inputConfig.command || {};
      inputConfig.command = { ...existing, ...getCommands() };
    },

    // 显式命令优先，自动入口不得覆盖手动关闭状态
    "chat.message": async (input, output) => {
      const parts = input.parts || output?.parts || [];
      const text = extractText(parts);

      if (/^\/wecom-off(?:\s|$)/i.test(text)) {
        enabled.delete(input.sessionID);
        muted.add(input.sessionID);
        console.log(`[wecom-notify] 已关闭通知 (session=${input.sessionID})`);
        return;
      }

      if (/^\/wecom-notify(?:\s|$)/i.test(text)) {
        muted.delete(input.sessionID);
        enabled.add(input.sessionID);
        console.log(`[wecom-notify] 已通过命令启用通知 (session=${input.sessionID})`);
        return;
      }

      if (muted.has(input.sessionID)) return;

      // 入口1：选定 wecom-notify agent
      if (input.agent === NOTIFY_AGENT) {
        enabled.add(input.sessionID);
        return;
      }

      // 入口3：配置开启后，对话命中指定关键词
      if (!keywordActivationEnabled()) return;
      const lower = text.toLowerCase();
      if (loadNotifyKeywords().some((kw) => lower.includes(kw.toLowerCase()))) {
        enabled.add(input.sessionID);
        console.log(`[wecom-notify] 检测到通知意图，已启用 (session=${input.sessionID})`);
      }
    },

    event: async ({ event }) => {
      const sessionID = event.properties?.sessionID;
      // 门控：未启用通知的会话一律静默
      if (!sessionID || !enabled.has(sessionID)) return;

      // —— 回复完成 ——
      if (event.type === "session.idle") {
        const last = await getLastAssistantMessage(client, sessionID);
        if (!last || !last.info) return;

        if (notified.get(sessionID) === last.info.id) return; // 去重
        notified.set(sessionID, last.info.id);

        const title = await getSessionTitle(client, sessionID);
        const text = extractText(last.parts);
        const header = `[opencode] ✅ 回复完成\n${title ? "会话：" + truncate(title, 80) + "\n" : ""}`;
        await sendWecom(header + (truncate(text) || "(无文本输出)"));
        return;
      }

      // —— 出错 ——
      if (event.type === "session.error") {
        const title = sessionID ? await getSessionTitle(client, sessionID) : "";
        const content = `[opencode] ⚠️ 会话出错\n${title ? "会话：" + truncate(title, 80) + "\n" : ""}${truncate(errText(event.properties.error))}`;
        await sendWecom(content);
        return;
      }

      // —— 需要权限确认 ——（permission.asked 为有效事件；permission.updated 不存在）
      if (event.type === "permission.asked") {
        const p = event.properties || {};
        const title = sessionID ? await getSessionTitle(client, sessionID) : "";
        const detail = p.permission
          ? `${p.permission}${p.patterns?.length ? " " + p.patterns.join(", ") : ""}`
          : (p.patterns?.length ? p.patterns.join(", ") : "(无描述)");
        const content = `[opencode] 🔔 需要权限确认\n${title ? "会话：" + truncate(title, 80) + "\n" : ""}${truncate(detail)}`;
        await sendWecom(content);
      }
    },
  };
}
