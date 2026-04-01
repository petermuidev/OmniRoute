import { CORS_ORIGIN } from "@/shared/utils/cors";
import { handleImageEdit } from "@omniroute/open-sse/handlers/imageEdit.ts";
import { unavailableResponse, errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import {
  getProviderCredentials,
  clearRecoveredProviderState,
  extractApiKey,
  isValidApiKey,
  markAccountUnavailable,
} from "@/sse/services/auth";
import { getImageEditProvider } from "@omniroute/open-sse/config/imageEditRegistry.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1ImageEditSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request, { params }) {
  const { provider: rawProvider } = await params;
  const providerConfig = getImageEditProvider(rawProvider);
  if (!providerConfig) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown image edit provider: ${rawProvider}`);
  }

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1ImageEditSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

  if (process.env.REQUIRE_API_KEY === "true") {
    const apiKey = extractApiKey(request);
    if (!apiKey || !(await isValidApiKey(apiKey))) {
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!body.model.includes("/")) {
    body.model = `${rawProvider}/${body.model}`;
  }

  const policy = await enforceApiKeyPolicy(request, body.model);
  if (policy.rejection) return policy.rejection;

  const modelProvider = body.model.split("/")[0];
  if (modelProvider !== rawProvider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Model "${body.model}" does not belong to image edit provider "${rawProvider}"`
    );
  }

  const modelId = body.model.slice(rawProvider.length + 1);
  if (!providerConfig.models.some((entry) => entry.id === modelId)) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Unknown model "${body.model}" for image edit provider "${rawProvider}"`
    );
  }

  let excludeConnectionId = null;
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(rawProvider, excludeConnectionId);
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status =
          lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn(
          "IMAGE_EDIT",
          `[${rawProvider}/${modelId}] ${errorMsg} (${credentials.retryAfterHuman})`
        );
        return unavailableResponse(
          status,
          `[${rawProvider}/${modelId}] ${errorMsg}`,
          credentials.retryAfter,
          credentials.retryAfterHuman
        );
      }

      if (!excludeConnectionId) {
        return errorResponse(
          HTTP_STATUS.BAD_REQUEST,
          `No credentials for image edit provider: ${rawProvider}`
        );
      }

      const errorPayload = toJsonErrorPayload(
        lastError || "All accounts unavailable",
        "Image edit provider error"
      );
      return new Response(JSON.stringify(errorPayload), {
        status: lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await handleImageEdit({
      body,
      credentials,
      log,
      resolvedRoute: {
        provider: rawProvider,
        model: modelId,
        fullId: body.model,
        family: `${rawProvider}_edit`,
        isFallback: false,
      },
    });

    if (result.success) {
      await clearRecoveredProviderState(credentials);
      return new Response(
        JSON.stringify({
          ...(result.data as Record<string, unknown>),
          _omniroute: {
            route: "omniroute",
            resolved_provider: rawProvider,
            resolved_model: body.model,
            requested_model: body.model,
            fallback_reason: null,
            attempted_routes: [],
            connection_id: credentials.connectionId || null,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const status = Number(result.status) || HTTP_STATUS.SERVICE_UNAVAILABLE;
    const errorText = String(result.error || "Image edit provider error");

    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      status,
      errorText,
      rawProvider,
      modelId
    );

    if (shouldFallback) {
      excludeConnectionId = credentials.connectionId;
      lastError = errorText;
      lastStatus = status;
      continue;
    }

    const errorPayload = toJsonErrorPayload(errorText, "Image edit provider error");
    return new Response(JSON.stringify(errorPayload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
