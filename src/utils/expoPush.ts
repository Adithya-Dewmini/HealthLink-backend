export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, any>;
};

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export async function sendExpoPush(messages: ExpoPushMessage[]) {
  if (!messages.length) return;

  const chunks: ExpoPushMessage[][] = [];
  const size = 100;
  for (let i = 0; i < messages.length; i += size) {
    chunks.push(messages.slice(i, i + size));
  }

  for (const chunk of chunks) {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chunk),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Expo push error:", text);
    }
  }
}

export function filterExpoTokens(tokens: (string | null | undefined)[]) {
  return tokens.filter((t): t is string =>
    typeof t === "string" &&
      (t.startsWith("ExponentPushToken") || t.startsWith("ExpoPushToken"))
  );
}
