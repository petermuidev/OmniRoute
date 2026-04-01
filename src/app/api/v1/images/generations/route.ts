import { CORS_ORIGIN } from "@/shared/utils/cors";
import { handleImageGeneration } from "@omniroute/open-sse/handlers/imageGeneration.ts";
import { unavailableResponse } from "@omniroute/open-sse/utils/error.ts";
import {
  getProviderCredentials,
  clearRecoveredProviderState,
  extractApiKey,
  isValidApiKey,
  markAccountUnavailable,
} from "@/sse/services/auth";
import {
  parseImageModel,
  getAllImageModels,
  getImageProvider,
} from "@omniroute/open-sse/config/imageRegistry.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1ImageGenerationSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

import { getAllCustomModels } from "@/lib/localDb";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/images/generations — list available image models
 */
export async function GET() {
  const builtInModels = getAllImageModels();
  const timestamp = Math.floor(Date.now() / 1000);

  const data = builtInModels.map((m) => ({
    id: m.id,
    object: "model",
    created: timestamp,
    owned_by: m.provider,
    type: "image",
    supported_sizes: m.supportedSizes,
  }));

  // Include custom models tagged for images
  try {
    const customModelsMap = (await getAllCustomModels()) as Record<string, any>;
    for (const [providerId, models] of Object.entries(customModelsMap)) {
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (!model?.id || !Array.isArray(model.supportedEndpoints)) continue;
        if (!model.supportedEndpoints.includes("images")) continue;
        const fullId = `${providerId}/${model.id}`;
        if (data.some((d) => d.id === fullId)) continue;
        data.push({
          id: fullId,
          object: "model",
          created: timestamp,
          owned_by: providerId,
          type: "image",
          supported_sizes: null,
        });
      }
    }
  } catch {}

  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /v1/images/generations — generate images
 */
export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    log.warn("IMAGE", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1ImageGenerationSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

  // Optional API key validation
  if (process.env.REQUIRE_API_KEY === "true") {
    const apiKey = extractApiKey(request);
    if (!apiKey) {
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, body.model);
  if (policy.rejection) return policy.rejection;

  // Parse model to get provider
  let { provider } = parseImageModel(body.model);
  let isCustomModel = false;

  // If not in built-in registry, check custom models tagged for images
  if (!provider) {
    try {
      const customModelsMap = (await getAllCustomModels()) as Record<string, any>;
      for (const [providerId, models] of Object.entries(customModelsMap)) {
        if (!Array.isArray(models)) continue;
        for (const model of models) {
          if (!model?.id || !Array.isArray(model.supportedEndpoints)) continue;
          if (!model.supportedEndpoints.includes("images")) continue;
          const fullId = `${providerId}/${model.id}`;
          if (fullId === body.model) {
            provider = providerId;
            isCustomModel = true;
            break;
          }
        }
        if (provider) break;
      }
    } catch {}
  }

  if (!provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid image model: ${body.model}. Use format: provider/model`
    );
  }

  const providerConfig = getImageProvider(provider);

  const needsCredentials = (providerConfig && providerConfig.authType !== "none") || isCustomModel;
  const lockoutModel = body.model.startsWith(`${provider}/`)
    ? body.model.slice(provider.length + 1)
    : body.model;

  let excludeConnectionId = null;
  let lastError = null;
  let lastStatus = null;

  while (true) {
    let credentials = null;
    if (needsCredentials) {
      credentials = await getProviderCredentials(provider, excludeConnectionId);
      if (!credentials || credentials.allRateLimited) {
        return handleNoImageCredentials({
          credentials,
          excludeConnectionId,
          provider,
          model: lockoutModel,
          lastError,
          lastStatus,
          noCredentialsMessage: isCustomModel
            ? `No credentials for custom image provider: ${provider}`
            : `No credentials for image provider: ${provider}`,
        });
      }
    }

    const result = await handleImageGeneration({
      body,
      credentials,
      log,
      ...(isCustomModel && { resolvedProvider: provider }),
    });

    if (result.success) {
      await clearRecoveredProviderState(credentials);
      return new Response(JSON.stringify((result as any).data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!credentials?.connectionId) {
      const errorPayload = toJsonErrorPayload(
        (result as any).error,
        "Image generation provider error"
      );
      return new Response(JSON.stringify(errorPayload), {
        status: (result as any).status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      (result as any).status,
      String((result as any).error || "Image generation provider error"),
      provider,
      lockoutModel
    );

    if (shouldFallback) {
      excludeConnectionId = credentials.connectionId;
      lastError = String((result as any).error || "Image generation provider error");
      lastStatus = Number((result as any).status) || HTTP_STATUS.SERVICE_UNAVAILABLE;
      continue;
    }

    const errorPayload = toJsonErrorPayload(
      (result as any).error,
      "Image generation provider error"
    );
    return new Response(JSON.stringify(errorPayload), {
      status: (result as any).status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function handleNoImageCredentials({
  credentials,
  excludeConnectionId,
  provider,
  model,
  lastError,
  lastStatus,
  noCredentialsMessage,
}) {
  if (credentials?.allRateLimited) {
    const errorMsg = lastError || credentials.lastError || "Unavailable";
    const status =
      lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
    log.warn("IMAGE", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
    return unavailableResponse(
      status,
      `[${provider}/${model}] ${errorMsg}`,
      credentials.retryAfter,
      credentials.retryAfterHuman
    );
  }

  if (!excludeConnectionId) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, noCredentialsMessage);
  }

  const errorPayload = toJsonErrorPayload(
    lastError || "All accounts unavailable",
    noCredentialsMessage
  );
  return new Response(JSON.stringify(errorPayload), {
    status: lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
    headers: { "Content-Type": "application/json" },
  });
}
