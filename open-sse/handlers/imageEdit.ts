import axios from "axios";

type CredentialShape = {
  apiKey?: string | null;
  accessToken?: string | null;
  providerSpecificData?: Record<string, unknown>;
  connectionId?: string | null;
};

type ImageEditBody = {
  model: string;
  prompt: string;
  image?: string;
  image_url?: string;
  image_data_base64?: string;
  image_mime_type?: string;
  size?: string;
  width?: number;
  height?: number;
  negative_prompt?: string;
  region?: string;
  seed?: number;
  true_cfg_scale?: number;
  num_inference_steps?: number;
};

type ImageEditRoute = {
  provider: string;
  model: string;
  fullId: string;
  family: string;
  isFallback: boolean;
};

function bearerToken(credentials: CredentialShape): string | null {
  return credentials.apiKey || credentials.accessToken || null;
}

async function fetchAsDataUrl(url: string): Promise<{ dataUrl: string; mimeType: string }> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to fetch image URL: HTTP ${response.status}`);
  }

  const mimeType =
    typeof response.headers["content-type"] === "string" && response.headers["content-type"].trim()
      ? response.headers["content-type"].split(";")[0].trim()
      : "image/png";

  return {
    dataUrl: `data:${mimeType};base64,${Buffer.from(response.data).toString("base64")}`,
    mimeType,
  };
}

async function normalizeImageInput(
  body: ImageEditBody
): Promise<{ dataUrl: string; mimeType: string; rawBase64: string }> {
  if (typeof body.image === "string" && body.image.trim()) {
    const trimmed = body.image.trim();
    if (trimmed.startsWith("data:image/")) {
      const [, base64 = ""] = trimmed.split(",", 2);
      const mimeMatch = trimmed.match(/^data:([^;]+);base64,/i);
      return {
        dataUrl: trimmed,
        mimeType: mimeMatch?.[1] || "image/png",
        rawBase64: base64,
      };
    }

    if (/^https?:\/\//i.test(trimmed)) {
      const fetched = await fetchAsDataUrl(trimmed);
      return {
        dataUrl: fetched.dataUrl,
        mimeType: fetched.mimeType,
        rawBase64: fetched.dataUrl.split(",", 2)[1] || "",
      };
    }
  }

  if (typeof body.image_url === "string" && body.image_url.trim()) {
    const fetched = await fetchAsDataUrl(body.image_url.trim());
    return {
      dataUrl: fetched.dataUrl,
      mimeType: fetched.mimeType,
      rawBase64: fetched.dataUrl.split(",", 2)[1] || "",
    };
  }

  if (typeof body.image_data_base64 === "string" && body.image_data_base64.trim()) {
    const mimeType = body.image_mime_type || "image/png";
    const rawBase64 = body.image_data_base64.trim();
    return {
      dataUrl: `data:${mimeType};base64,${rawBase64}`,
      mimeType,
      rawBase64,
    };
  }

  throw new Error("No input image provided");
}

function parseSize(body: ImageEditBody): { width: number; height: number } {
  if (typeof body.width === "number" && typeof body.height === "number") {
    return { width: body.width, height: body.height };
  }

  const raw = String(body.size || "").trim();
  const normalized = raw.replace("*", "x");
  const match = normalized.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    return { width: 1024, height: 1024 };
  }

  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function dashscopeSize(body: ImageEditBody): string {
  if (typeof body.size === "string" && body.size.trim()) {
    return body.size.trim().replace("x", "*");
  }

  const { width, height } = parseSize(body);
  return `${width}*${height}`;
}

function extractDashscopeImageCandidates(
  payload: any
): Array<{ type: "url" | "b64_json"; value: string }> {
  const results: Array<{ type: "url" | "b64_json"; value: string }> = [];
  const output = payload?.output;
  const choices = Array.isArray(output?.choices) ? output.choices : [];

  for (const choice of choices) {
    const content = Array.isArray(choice?.message?.content) ? choice.message.content : [];
    for (const item of content) {
      if (typeof item?.image === "string" && item.image.trim()) {
        results.push({ type: "url", value: item.image.trim() });
      }
      if (typeof item?.url === "string" && item.url.trim()) {
        results.push({ type: "url", value: item.url.trim() });
      }
      if (typeof item?.b64_json === "string" && item.b64_json.trim()) {
        results.push({ type: "b64_json", value: item.b64_json.trim() });
      }
    }
  }

  return results;
}

function extractChutesImageCandidates(
  payload: any
): Array<{ type: "b64_json" | "url"; value: string }> {
  const results: Array<{ type: "b64_json" | "url"; value: string }> = [];
  const push = (value: any) => {
    if (typeof value !== "string" || !value.trim()) return;
    const trimmed = value.trim();
    if (trimmed.startsWith("http")) {
      results.push({ type: "url", value: trimmed });
      return;
    }
    if (trimmed.startsWith("data:image")) {
      results.push({ type: "b64_json", value: trimmed.split(",")[1] || "" });
      return;
    }
    results.push({ type: "b64_json", value: trimmed });
  };

  push(payload?.image_b64);
  if (Array.isArray(payload?.image_b64s)) payload.image_b64s.forEach(push);
  if (Array.isArray(payload?.images)) {
    for (const item of payload.images) {
      if (typeof item === "string") {
        push(item);
        continue;
      }
      push(item?.image_b64);
      push(item?.b64_json);
      push(item?.url);
      push(item?.image_url);
    }
  }
  push(payload?.output?.image_b64);
  if (Array.isArray(payload?.output?.image_b64s)) payload.output.image_b64s.forEach(push);
  return results.filter((entry) => entry.value);
}

function asSuccess(data: any) {
  return {
    success: true as const,
    data,
  };
}

function asFailure(status: number, error: string) {
  return {
    success: false as const,
    status,
    error,
  };
}

async function handleDashScopeImageEdit({
  body,
  credentials,
  resolvedRoute,
}: {
  body: ImageEditBody;
  credentials: CredentialShape;
  resolvedRoute: ImageEditRoute;
}) {
  const token = bearerToken(credentials);
  if (!token) {
    return asFailure(401, "No DashScope credential available");
  }

  const normalizedImage = await normalizeImageInput(body);
  const region =
    typeof credentials.providerSpecificData?.region === "string" &&
    credentials.providerSpecificData.region.trim()
      ? credentials.providerSpecificData.region.trim()
      : typeof body.region === "string" && body.region.trim()
        ? body.region.trim()
        : "beijing";
  const endpoint =
    region === "singapore"
      ? "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
      : "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

  const response = await axios.post(
    endpoint,
    {
      model: resolvedRoute.model,
      input: {
        messages: [
          {
            role: "user",
            content: [{ image: normalizedImage.dataUrl }, { text: body.prompt }],
          },
        ],
      },
      parameters: {
        n: 1,
        watermark: false,
        prompt_extend: true,
        negative_prompt:
          body.negative_prompt ||
          "watermark, logo, text overlay, cartoon, illustration, painting style, blurry, distorted",
        result_format: "message",
        size: dashscopeSize(body),
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 240000,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    const message =
      response.data?.message ||
      response.data?.code ||
      response.data?.error?.message ||
      `DashScope API error ${response.status}`;
    return asFailure(response.status, String(message));
  }

  const imageResults = extractDashscopeImageCandidates(response.data);
  if (imageResults.length === 0) {
    return asFailure(502, "DashScope returned no edited image");
  }

  return asSuccess({
    created: Math.floor(Date.now() / 1000),
    data: imageResults.map((item) =>
      item.type === "b64_json" ? { b64_json: item.value } : { url: item.value }
    ),
  });
}

async function handleFireworksImageEdit({
  body,
  credentials,
  resolvedRoute,
}: {
  body: ImageEditBody;
  credentials: CredentialShape;
  resolvedRoute: ImageEditRoute;
}) {
  const token = bearerToken(credentials);
  if (!token) {
    return asFailure(401, "No Fireworks credential available");
  }

  const normalizedImage = await normalizeImageInput(body);
  const submitUrl = `https://api.fireworks.ai/inference/v1/workflows/accounts/fireworks/models/${resolvedRoute.model}`;

  const response = await axios.post(
    submitUrl,
    {
      prompt: body.prompt,
      input_image: normalizedImage.dataUrl,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    const message =
      response.data?.error?.message ||
      response.data?.message ||
      `Fireworks API error ${response.status}`;
    return asFailure(response.status, String(message));
  }

  const requestId = response.data?.request_id || response.data?.id;
  if (!requestId) {
    return asFailure(502, "Fireworks edit response did not include a request id");
  }

  let editedImageData: string | null = null;
  let lastPollError = "Fireworks edit timed out";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const waitTime = Math.round(Math.min(500 * Math.pow(1.2, attempt), 5000));
    await new Promise((resolve) => setTimeout(resolve, waitTime));

    const pollResponse = await axios.post(
      `${submitUrl}/get_result`,
      { id: requestId },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
        validateStatus: () => true,
      }
    );

    if (pollResponse.status < 200 || pollResponse.status >= 300) {
      lastPollError =
        pollResponse.data?.error?.message ||
        pollResponse.data?.message ||
        `Fireworks polling error ${pollResponse.status}`;
      continue;
    }

    const status = pollResponse.data?.status;
    if (["Ready", "Complete", "Finished"].includes(status)) {
      editedImageData = pollResponse.data?.result?.sample || null;
      break;
    }

    if (["Failed", "Error"].includes(status)) {
      lastPollError = `Fireworks edit failed with status: ${status}`;
      break;
    }
  }

  if (!editedImageData) {
    return asFailure(502, lastPollError);
  }

  if (editedImageData.startsWith("http")) {
    return asSuccess({
      created: Math.floor(Date.now() / 1000),
      data: [{ url: editedImageData }],
      request_id: requestId,
    });
  }

  if (editedImageData.startsWith("data:image")) {
    return asSuccess({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: editedImageData.split(",")[1] || "" }],
      request_id: requestId,
    });
  }

  return asFailure(502, "Fireworks returned an unsupported edited image format");
}

async function handleChutesImageEdit({
  body,
  credentials,
}: {
  body: ImageEditBody;
  credentials: CredentialShape;
}) {
  const token = bearerToken(credentials);
  if (!token) {
    return asFailure(401, "No Chutes credential available");
  }

  const normalizedImage = await normalizeImageInput(body);
  const { width, height } = parseSize(body);
  const endpoint =
    (typeof credentials.providerSpecificData?.imageEditUrl === "string" &&
    credentials.providerSpecificData.imageEditUrl.trim()
      ? credentials.providerSpecificData.imageEditUrl.trim()
      : "") ||
    process.env.CHUTES_IMAGE_EDIT_2509_URL ||
    "https://chutes-qwen-image-edit-2509.chutes.ai/generate";

  const response = await axios.post(
    endpoint,
    {
      prompt: body.prompt,
      image_b64s: [normalizedImage.rawBase64],
      width,
      height,
      seed: body.seed ?? null,
      true_cfg_scale: body.true_cfg_scale ?? 4,
      negative_prompt: body.negative_prompt || "",
      num_inference_steps: body.num_inference_steps ?? 50,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 240000,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    const message =
      response.data?.message ||
      response.data?.error?.message ||
      `Chutes API error ${response.status}`;
    return asFailure(response.status, String(message));
  }

  const imageResults = extractChutesImageCandidates(response.data);
  if (imageResults.length === 0) {
    return asFailure(502, "Chutes returned no edited image");
  }

  return asSuccess({
    created: Math.floor(Date.now() / 1000),
    data: imageResults.map((item) =>
      item.type === "b64_json" ? { b64_json: item.value } : { url: item.value }
    ),
  });
}

export async function handleImageEdit({
  body,
  credentials,
  log,
  resolvedRoute,
}: {
  body: ImageEditBody;
  credentials: CredentialShape | null;
  log?: { warn?: (...args: any[]) => void };
  resolvedRoute: ImageEditRoute;
}) {
  try {
    if (!credentials) {
      return asFailure(401, "No provider credentials available");
    }

    if (resolvedRoute.provider === "dashscope") {
      return await handleDashScopeImageEdit({ body, credentials, resolvedRoute });
    }

    if (resolvedRoute.provider === "fireworks") {
      return await handleFireworksImageEdit({ body, credentials, resolvedRoute });
    }

    if (resolvedRoute.provider === "chutes") {
      return await handleChutesImageEdit({ body, credentials });
    }

    return asFailure(400, `Unsupported image edit provider: ${resolvedRoute.provider}`);
  } catch (error: any) {
    const message =
      error?.response?.data?.error?.message || error?.response?.data?.message || error?.message;
    if (log?.warn) {
      log.warn("IMAGE_EDIT", `${resolvedRoute.fullId} failed: ${message || "Unknown error"}`);
    }
    return asFailure(500, String(message || "Unknown image edit error"));
  }
}
