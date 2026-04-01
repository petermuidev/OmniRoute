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
import {
  getAllImageEditModels,
  resolveImageEditRoutes,
} from "@omniroute/open-sse/config/imageEditRegistry.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1ImageEditSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

type RouteAttempt = {
  provider: string;
  model: string;
  error: string;
  status: number;
};

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function GET() {
  const builtInModels = getAllImageEditModels();
  const timestamp = Math.floor(Date.now() / 1000);

  const data = builtInModels.map((model) => ({
    id: model.id,
    object: "model",
    created: timestamp,
    owned_by: model.provider,
    type: "image_edit",
    family: model.family,
    priority: model.priority,
    is_fallback: model.isFallback,
  }));

  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json" },
  });
}

function shouldTryNextRoute(status: number, errorText: string): boolean {
  if (status === 401 || status === 403 || status === 408 || status === 409 || status === 429) {
    return true;
  }

  if (status >= 500) {
    return true;
  }

  const normalized = errorText.toLowerCase();
  return [
    "access denied",
    "account is suspended",
    "suspended",
    "not in good standing",
    "unavailable",
    "not implemented",
    "no credential",
    "no provider credentials",
  ].some((phrase) => normalized.includes(phrase));
}

function noCredentialsResponse({
  credentials,
  excludeConnectionId,
  provider,
  model,
  lastError,
  lastStatus,
}: {
  credentials: any;
  excludeConnectionId: string | null;
  provider: string;
  model: string;
  lastError: string | null;
  lastStatus: number | null;
}) {
  if (credentials?.allRateLimited) {
    const errorMsg = lastError || credentials.lastError || "Unavailable";
    const status =
      lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
    log.warn("IMAGE_EDIT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
    return unavailableResponse(
      status,
      `[${provider}/${model}] ${errorMsg}`,
      credentials.retryAfter,
      credentials.retryAfterHuman
    );
  }

  if (!excludeConnectionId) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `No credentials for image edit provider: ${provider}`
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

export async function POST(request: Request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    log.warn("IMAGE_EDIT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1ImageEditSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

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

  const policy = await enforceApiKeyPolicy(request, body.model);
  if (policy.rejection) return policy.rejection;

  const routePlan = resolveImageEditRoutes(body.model);
  if (routePlan.length === 0) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid image edit model: ${body.model}. Use a registered provider/model route.`
    );
  }

  const attemptedRoutes: RouteAttempt[] = [];

  for (const route of routePlan) {
    let excludeConnectionId: string | null = null;
    let lastError: string | null = null;
    let lastStatus: number | null = null;

    while (true) {
      const credentials = await getProviderCredentials(route.provider, excludeConnectionId);
      if (!credentials || credentials.allRateLimited) {
        const noCredsError =
          lastError ||
          credentials?.lastError ||
          `No credentials for image edit provider: ${route.provider}`;
        attemptedRoutes.push({
          provider: route.provider,
          model: route.fullId,
          error: noCredsError,
          status: lastStatus || Number(credentials?.lastErrorCode) || HTTP_STATUS.BAD_REQUEST,
        });

        if (route !== routePlan[routePlan.length - 1]) {
          break;
        }

        return noCredentialsResponse({
          credentials,
          excludeConnectionId,
          provider: route.provider,
          model: route.model,
          lastError,
          lastStatus,
        });
      }

      const result = await handleImageEdit({
        body,
        credentials,
        log,
        resolvedRoute: route,
      });

      if (result.success) {
        await clearRecoveredProviderState(credentials);
        const fallbackAttempt = attemptedRoutes.length
          ? `${attemptedRoutes[attemptedRoutes.length - 1].model} failed: ${attemptedRoutes[attemptedRoutes.length - 1].error}`
          : null;
        const responsePayload = {
          ...(result.data as Record<string, unknown>),
          _omniroute: {
            route: "omniroute",
            resolved_provider: route.provider,
            resolved_model: route.fullId,
            requested_model: body.model,
            fallback_reason: route.isFallback ? fallbackAttempt : null,
            attempted_routes: attemptedRoutes,
            connection_id: credentials.connectionId || null,
          },
        };

        return new Response(JSON.stringify(responsePayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const status = Number(result.status) || HTTP_STATUS.SERVICE_UNAVAILABLE;
      const errorText = String(result.error || "Image edit provider error");

      if (!credentials.connectionId) {
        attemptedRoutes.push({
          provider: route.provider,
          model: route.fullId,
          error: errorText,
          status,
        });

        if (route !== routePlan[routePlan.length - 1] && shouldTryNextRoute(status, errorText)) {
          break;
        }

        const errorPayload = toJsonErrorPayload(errorText, "Image edit provider error");
        return new Response(JSON.stringify(errorPayload), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }

      const { shouldFallback } = await markAccountUnavailable(
        credentials.connectionId,
        status,
        errorText,
        route.provider,
        route.model
      );

      attemptedRoutes.push({
        provider: route.provider,
        model: route.fullId,
        error: errorText,
        status,
      });

      if (shouldFallback) {
        excludeConnectionId = credentials.connectionId;
        lastError = errorText;
        lastStatus = status;
        continue;
      }

      if (route !== routePlan[routePlan.length - 1] && shouldTryNextRoute(status, errorText)) {
        break;
      }

      const errorPayload = toJsonErrorPayload(errorText, "Image edit provider error");
      return new Response(JSON.stringify(errorPayload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const finalAttempt = attemptedRoutes[attemptedRoutes.length - 1];
  const finalPayload = toJsonErrorPayload(
    finalAttempt?.error || "All image edit routes failed",
    "Image edit provider error"
  );
  return new Response(JSON.stringify(finalPayload), {
    status: finalAttempt?.status || HTTP_STATUS.SERVICE_UNAVAILABLE,
    headers: { "Content-Type": "application/json" },
  });
}
